import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { FailureCodes } from '../../src/application/failure-codes';
import { OpenWallet } from '../../src/application/open-wallet';
import {
  DEFAULT_REFERENCE_RETRY,
  ReferenceRetryPolicy,
} from '../../src/application/reference-retry-policy';
import {
  type ReprocessOptions,
  ReprocessPendingReferences,
} from '../../src/application/reprocess-pending-references';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/submit-wager-transaction';
import type {
  PendingReferenceRepository,
  PendingReferenceTask,
} from '../../src/application/wager-transaction-repository';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// Grava no banco de teste (migrations reais aplicadas); recusa qualquer banco que não seja *_test.
assertTestDatabaseEnv();

const { Processed, Rejected, PendingReference } = WagerTransactionStatus;
const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
const policy = ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);

// Três instâncias do MikroORM, com pools independentes, no mesmo processo de teste.
let orm: MikroORM;
let otherOrm: MikroORM;
let thirdOrm: MikroORM;
let submit: SubmitWagerTransaction;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

type WalletRef = { walletId: string; playerId: string };
/** Wallets abertas por este arquivo, para a reconciliação final e para limitar o worker. */
const usedWallets: string[] = [];

async function openWallet(cents: bigint, currency = 'BRL'): Promise<WalletRef> {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: Money.fromCents(cents, currency),
  });
  usedWallets.push(wallet.id);
  return { walletId: wallet.id, playerId };
}

function submission(
  kind: WagerTransactionKind,
  wallet: WalletRef,
  cents: bigint,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId = `${kind.toLowerCase()}-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(cents),
    ...overrides,
  };
}

const betOn = (w: WalletRef, cents: bigint, o: Partial<SubmitWagerTransactionCommand> = {}) =>
  submission(WagerTransactionKind.Bet, w, cents, o);
/** REFUND da operação `bet` (pelo id externo), na wallet `w`. */
const refundOf = (
  w: WalletRef,
  bet: SubmitWagerTransactionCommand,
  cents: bigint,
  o: Partial<SubmitWagerTransactionCommand> = {},
) =>
  submission(WagerTransactionKind.Refund, w, cents, {
    referenceExternalTransactionId: bet.externalTransactionId,
    ...o,
  });

/**
 * O banco de teste é compartilhado por todos os testes: o worker de cada teste só enxerga as wallets
 * informadas. A resolução é a do repositório real.
 */
function scoped(target: MikroORM, walletIds: string[]): PendingReferenceRepository {
  const real = new MikroOrmWagerTransactionRepository(target);
  return {
    async findDuePendingReferences(now, limit) {
      const due = await real.findDuePendingReferences(now, 10_000);
      return due.filter((t) => walletIds.includes(t.walletId)).slice(0, limit);
    },
    resolvePendingReference: (task, now, decide) => real.resolvePendingReference(task, now, decide),
    deferAfterFailure: (task, now, next) => real.deferAfterFailure(task, now, next),
  };
}

/** Relógio do worker à frente do real: as tentativas agendadas pela submissão já venceram. */
const ahead = (ms: number) => () => new Date(Date.now() + ms);

function worker(
  walletIds: string[],
  options: Partial<ReprocessOptions> = {},
  target: MikroORM = orm,
): ReprocessPendingReferences {
  return new ReprocessPendingReferences(scoped(target, walletIds), {
    batchSize: 50,
    now: ahead(3_000),
    policy,
    ...options,
  });
}

async function row(idempotencyKey: string) {
  const [found] = await sql<{
    id: string;
    status: string;
    failure_code: string | null;
    attempts: number;
    processing_failures: number;
    next_ms: string | null;
    created_ms: string;
    reference_id: string | null;
    result_balance: string;
    processed: boolean;
    entries: number;
  }>(
    `select t.id, t.status, t.failure_code, t.reference_attempts as attempts, t.processing_failures,
            (extract(epoch from t.next_reference_attempt_at) * 1000)::bigint::text as next_ms,
            (extract(epoch from t.created_at) * 1000)::bigint::text as created_ms,
            t.reference_transaction_id as reference_id,
            t.result_balance_cents::text as result_balance,
            t.processed_at is not null as processed,
            (select count(*) from wallet_ledger_entries e where e.transaction_id = t.id)::int as entries
       from wager_transactions t where t.idempotency_key = ?`,
    [idempotencyKey],
  );
  if (found === undefined) throw new Error(`transação ${idempotencyKey} não gravada.`);
  return found;
}

/** Saldo, versão, saldo reconstruído pelo ledger e lançamentos de uma wallet. */
async function walletState(walletId: string) {
  const [wallet] = await sql<{
    balance: string;
    version: number;
    rebuilt: string;
    entries: number;
    credits: number;
  }>(
    `select w.balance_cents::text as balance, w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)::text as rebuilt,
            count(e.id)::int as entries,
            (count(*) filter (where e.direction = 'CREDIT'))::int as credits
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  if (wallet === undefined) throw new Error(`wallet ${walletId} não existe no banco de teste.`);
  return wallet;
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  otherOrm = await MikroORM.init(createOrmConfig());
  thirdOrm = await MikroORM.init(createOrmConfig());
  submit = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm));
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await thirdOrm?.close(true);
  await otherOrm?.close(true);
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('PENDING_REFERENCE: submissão', () => {
  test('REFUND antes da BET: PENDING_REFERENCE agendado, sem saldo, versão nem lançamento', async () => {
    const wallet = await openWallet(10_000n);
    const refund = refundOf(wallet, betOn(wallet, 3_000n), 3_000n);

    const result = await submit.execute(refund);

    expect(result).toMatchObject({ status: PendingReference, idempotentReplay: false });
    expect(result.balance.cents).toBe(10_000n);
    const stored = await row(refund.idempotencyKey);
    expect(stored).toMatchObject({
      status: PendingReference,
      failure_code: null,
      attempts: 0,
      reference_id: null,
      result_balance: '10000',
      processed: false,
      entries: 0,
    });
    // Primeira tentativa 2 s depois da submissão (política padrão).
    expect(Number(stored.next_ms) - Number(stored.created_ms)).toBe(2_000);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '10000',
      version: 1,
      entries: 1,
    });
  });

  test('o CHECK do banco exige agendamento em PENDING_REFERENCE e o proíbe nos demais estados', async () => {
    const wallet = await openWallet(10_000n);
    const refund = refundOf(wallet, betOn(wallet, 1_000n), 1_000n);
    const bet = betOn(wallet, 1_000n);
    await submit.execute(refund);
    await submit.execute(bet);

    await expect(
      sql(
        'update wager_transactions set next_reference_attempt_at = null where idempotency_key = ?',
        [refund.idempotencyKey],
      ),
    ).rejects.toThrow('wager_transactions_pending_reference_schedule_check');
    await expect(
      sql(
        'update wager_transactions set next_reference_attempt_at = now() where idempotency_key = ?',
        [bet.idempotencyKey],
      ),
    ).rejects.toThrow('wager_transactions_pending_reference_schedule_check');
    await expect(
      sql('update wager_transactions set reference_attempts = -1 where idempotency_key = ?', [
        bet.idempotencyKey,
      ]),
    ).rejects.toThrow('wager_transactions_reference_attempts_check');
  });

  test.each([
    ['outra rodada', 'round', FailureCodes.ReferenceMismatch],
    ['outro player', 'player', FailureCodes.ReferenceMismatch],
    ['valor diferente', 'amount', FailureCodes.ReferenceAmountMismatch],
    ['BET rejeitada', 'rejected', FailureCodes.ReferenceNotProcessed],
    ['referência WIN', 'win', FailureCodes.ReferenceKindNotAllowed],
    ['moeda diferente da wallet', 'currency', FailureCodes.CurrencyMismatch],
  ])(
    'referência existente, mas inválida (%s): REJECTED na submissão, sem agendamento',
    async (_case, variant, code) => {
      const wallet = await openWallet(10_000n);
      const owner = variant === 'player' ? await openWallet(10_000n) : wallet;
      const referenced =
        variant === 'win'
          ? submission(WagerTransactionKind.Win, owner, 3_000n)
          : betOn(owner, variant === 'rejected' ? 50_000n : 3_000n);
      await submit.execute(referenced);
      const refund = refundOf(wallet, referenced, variant === 'amount' ? 2_999n : 3_000n, {
        ...(variant === 'round' ? { roundId: 'round-2' } : {}),
        ...(variant === 'rejected' ? { money: brl(50_000n) } : {}),
        ...(variant === 'currency' ? { money: Money.fromCents(3_000n, 'USD') } : {}),
      });
      const before = await walletState(wallet.walletId);

      const result = await submit.execute(refund);

      expect(result).toMatchObject({ status: Rejected, failureCode: code });
      expect(await row(refund.idempotencyKey)).toMatchObject({
        status: Rejected,
        failure_code: code,
        next_ms: null,
        reference_id: null,
        entries: 0,
      });
      expect(await walletState(wallet.walletId)).toEqual(before);
    },
  );
});

describe('PENDING_REFERENCE: worker agendado (§7.1)', () => {
  test('antes do vencimento, nada é tentado', async () => {
    const wallet = await openWallet(10_000n);
    const refund = refundOf(wallet, betOn(wallet, 3_000n), 3_000n);
    await submit.execute(refund);

    // Relógio do worker antes do vencimento (submissão + 2 s), independente da velocidade do teste.
    const summary = await worker([wallet.walletId], { now: ahead(-60_000) }).runOnce();

    expect(summary.due).toBe(0);
    expect(await row(refund.idempotencyKey)).toMatchObject({
      status: PendingReference,
      attempts: 0,
    });
  });

  test('a BET chega depois: o worker credita uma vez, grava a referência e conta a tentativa', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const refund = refundOf(wallet, bet, 3_000n);
    await submit.execute(refund);
    await submit.execute(bet);
    const betId = (await row(bet.idempotencyKey)).id;

    const summary = await worker([wallet.walletId]).runOnce();

    expect(summary).toMatchObject({ due: 1, processed: 1, rejected: 0, rescheduled: 0 });
    expect(await row(refund.idempotencyKey)).toMatchObject({
      status: Processed,
      failure_code: null,
      attempts: 1,
      next_ms: null,
      reference_id: betId,
      result_balance: '10000',
      processed: true,
      entries: 1,
    });
    expect(await walletState(wallet.walletId)).toEqual({
      balance: '10000',
      version: 3,
      rebuilt: '10000',
      entries: 3,
      credits: 2,
    });

    // Rodadas seguintes não encontram nada: nenhum crédito novo.
    expect((await worker([wallet.walletId], { now: ahead(86_400_000) }).runOnce()).due).toBe(0);
    expect(await walletState(wallet.walletId)).toMatchObject({ entries: 3, version: 3 });
  });

  test('referência ausente: backoff exponencial persistido até o limite e REJECTED REFERENCE_NOT_FOUND', async () => {
    const wallet = await openWallet(10_000n);
    const refund = refundOf(wallet, betOn(wallet, 3_000n), 3_000n);
    await submit.execute(refund);
    let clock = Number((await row(refund.idempotencyKey)).next_ms);
    const delays: number[] = [];

    for (let attempt = 1; attempt <= DEFAULT_REFERENCE_RETRY.maxAttempts; attempt++) {
      const summary = await worker([wallet.walletId], { now: () => new Date(clock) }).runOnce();
      const stored = await row(refund.idempotencyKey);
      expect(stored.attempts).toBe(attempt);
      expect(stored.entries).toBe(0);
      if (attempt < DEFAULT_REFERENCE_RETRY.maxAttempts) {
        expect(summary).toMatchObject({ due: 1, rescheduled: 1 });
        expect(stored.status).toBe(PendingReference);
        delays.push(Number(stored.next_ms) - clock);
        clock = Number(stored.next_ms);
      } else {
        expect(summary).toMatchObject({ due: 1, rejected: 1 });
        expect(stored).toMatchObject({
          status: Rejected,
          failure_code: FailureCodes.ReferenceNotFound,
          next_ms: null,
          reference_id: null,
          result_balance: '10000',
        });
      }
    }

    expect(delays).toEqual([4, 8, 16, 32, 64, 128, 256, 300, 300].map((s) => s * 1_000));
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '10000',
      version: 1,
      entries: 1,
    });
    // Terminal: nenhuma tentativa a mais, mesmo muito depois.
    expect((await worker([wallet.walletId], { now: ahead(86_400_000) }).runOnce()).due).toBe(0);
  });

  test('a BET que chega é incompatível: REJECTED na tentativa, sem esperar o limite', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 2_500n);
    const refund = refundOf(wallet, bet, 3_000n);
    await submit.execute(refund);
    await submit.execute(bet);

    const summary = await worker([wallet.walletId]).runOnce();

    expect(summary).toMatchObject({ processed: 0, rejected: 1 });
    expect(await row(refund.idempotencyKey)).toMatchObject({
      status: Rejected,
      failure_code: FailureCodes.ReferenceAmountMismatch,
      attempts: 1,
      next_ms: null,
      result_balance: '7500',
      entries: 0,
    });
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '7500', version: 2 });
  });

  test('BET já reembolsada por outro REFUND enquanto este aguardava: REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const waiting = refundOf(wallet, bet, 3_000n);
    const immediate = refundOf(wallet, bet, 3_000n);
    expect((await submit.execute(waiting)).status).toBe(PendingReference);
    await submit.execute(bet);
    expect((await submit.execute(immediate)).status).toBe(Processed);

    await worker([wallet.walletId]).runOnce();

    expect(await row(waiting.idempotencyKey)).toMatchObject({
      status: Rejected,
      failure_code: FailureCodes.ReferenceAlreadyReversed,
      reference_id: null,
      entries: 0,
    });
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '10000',
      rebuilt: '10000',
      credits: 2,
    });
  });
});

describe('PENDING_REFERENCE: concorrência, falhas e recuperação', () => {
  test('3 workers simultâneos (pools independentes): cada pendência é concluída uma única vez', async () => {
    const wallets: WalletRef[] = [];
    const refunds: SubmitWagerTransactionCommand[] = [];
    for (let i = 0; i < 8; i++) {
      const wallet = await openWallet(10_000n);
      const bet = betOn(wallet, 1_000n);
      const refund = refundOf(wallet, bet, 1_000n);
      await submit.execute(refund);
      await submit.execute(bet);
      wallets.push(wallet);
      refunds.push(refund);
    }
    const ids = wallets.map((w) => w.walletId);

    // Rodadas em paralelo, várias por pool, disputando as mesmas pendências.
    const summaries = await Promise.all(
      [orm, otherOrm, thirdOrm, orm, otherOrm, thirdOrm].map((target) =>
        worker(ids, {}, target).runOnce(),
      ),
    );

    expect(summaries.reduce((sum, s) => sum + s.processed, 0)).toBe(refunds.length);
    expect(summaries.every((s) => s.failures === 0 && s.transientFailures === 0)).toBe(true);
    for (const refund of refunds) {
      expect(await row(refund.idempotencyKey)).toMatchObject({
        status: Processed,
        attempts: 1,
        entries: 1,
      });
    }
    for (const wallet of wallets) {
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '10000',
        rebuilt: '10000',
        version: 3,
        credits: 2,
      });
    }
  });

  test('REFUND e BET simultâneos na mesma wallet: um único crédito, na hora ou pelo worker', async () => {
    const wallets: WalletRef[] = [];
    for (let i = 0; i < 10; i++) {
      const wallet = await openWallet(10_000n);
      const bet = betOn(wallet, 4_000n);
      const refund = refundOf(wallet, bet, 4_000n);
      await Promise.all([submit.execute(refund), submit.execute(bet)]);
      wallets.push(wallet);
    }

    await worker(wallets.map((w) => w.walletId)).runOnce();

    for (const wallet of wallets) {
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '10000',
        rebuilt: '10000',
        version: 3,
        credits: 2,
      });
    }
  });

  test('10 REFUNDs distintos e simultâneos da mesma BET: um PROCESSED, os demais REFERENCE_ALREADY_REVERSED', async () => {
    for (let round = 0; round < 3; round++) {
      const wallet = await openWallet(10_000n);
      const bet = betOn(wallet, 3_000n);
      await submit.execute(bet);
      const refunds = Array.from({ length: 10 }, () => refundOf(wallet, bet, 3_000n));

      // Pools diferentes: as submissões disputam o lock da wallet de verdade.
      const pools = [orm, otherOrm, thirdOrm].map(
        (target) => new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(target)),
      );
      const results = await Promise.all(
        refunds.map((refund, i) =>
          (pools[i % pools.length] as SubmitWagerTransaction).execute(refund),
        ),
      );

      expect(results.filter((r) => r.status === Processed)).toHaveLength(1);
      const rejected = results.filter((r) => r.status === Rejected);
      expect(rejected).toHaveLength(9);
      expect(rejected.every((r) => r.failureCode === FailureCodes.ReferenceAlreadyReversed)).toBe(
        true,
      );
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '10000',
        rebuilt: '10000',
        version: 3,
        credits: 2,
      });
    }
  });

  test('REFUND pendente reenviado com outra chave: DuplicateExternalTransactionError, nada gravado', async () => {
    const wallet = await openWallet(10_000n);
    const refund = refundOf(wallet, betOn(wallet, 3_000n), 3_000n);
    await submit.execute(refund);

    // Mesmo payload (mesmo id externo) sob outra chave, e depois com outro valor: os dois são a
    // mesma operação externa, e nenhum vira replay nem uma segunda pendência.
    for (const duplicate of [
      { ...refund, idempotencyKey: 'outra-chave-1' },
      { ...refund, idempotencyKey: 'outra-chave-2', money: brl(2_000n) },
    ]) {
      await expect(submit.execute(duplicate)).rejects.toBeInstanceOf(
        DuplicateExternalTransactionError,
      );
      expect(
        await sql('select 1 from wager_transactions where idempotency_key = ?', [
          duplicate.idempotencyKey,
        ]),
      ).toHaveLength(0);
    }
    expect(await row(refund.idempotencyKey)).toMatchObject({
      status: PendingReference,
      attempts: 0,
    });
  });

  test('entrega duplicada: 20 reenvios simultâneos gravam uma pendência; após a resolução, replay sem novo crédito', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const refund = refundOf(wallet, bet, 3_000n);

    const results = await Promise.all(Array.from({ length: 20 }, () => submit.execute(refund)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === PendingReference)).toBe(true);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(
      await sql('select 1 from wager_transactions where idempotency_key = ?', [
        refund.idempotencyKey,
      ]),
    ).toHaveLength(1);

    await submit.execute(bet);
    await worker([wallet.walletId]).runOnce();
    const replays = await Promise.all(Array.from({ length: 5 }, () => submit.execute(refund)));

    for (const replay of replays) {
      expect(replay).toMatchObject({ status: Processed, idempotentReplay: true });
      expect(replay.balance.cents).toBe(10_000n);
    }
    await expect(submit.execute({ ...refund, money: brl(2_999n) })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await walletState(wallet.walletId)).toMatchObject({ credits: 2, version: 3 });
  });

  test('falha transitória na tentativa: nada gravado, tentativa não consumida; a rodada seguinte resolve', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const refund = refundOf(wallet, bet, 3_000n);
    await submit.execute(refund);
    await submit.execute(bet);
    const before = await row(refund.idempotencyKey);
    const real = scoped(orm, [wallet.walletId]);
    // Decide de verdade (sob o lock, com a BET lida) e então falha como um deadlock do PostgreSQL.
    const flaky: PendingReferenceRepository = {
      findDuePendingReferences: real.findDuePendingReferences,
      resolvePendingReference: (task, now, decide) =>
        real.resolvePendingReference(task, now, (state) => {
          decide(state);
          throw Object.assign(new Error('deadlock simulado'), { code: '40P01' });
        }),
      deferAfterFailure: real.deferAfterFailure,
    };

    const summary = await new ReprocessPendingReferences(flaky, {
      batchSize: 50,
      now: ahead(3_000),
      policy,
    }).runOnce();

    expect(summary).toMatchObject({ due: 1, transientFailures: 1, processed: 0, failures: 0 });
    expect(await row(refund.idempotencyKey)).toEqual(before);
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '7000', version: 2 });

    expect((await worker([wallet.walletId]).runOnce()).processed).toBe(1);
    expect(await row(refund.idempotencyKey)).toMatchObject({
      status: Processed,
      attempts: 1,
      entries: 1,
    });
  });

  test('falha no meio da tentativa (lançamento duplicado): transação, saldo e ledger desfeitos juntos', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const refund = refundOf(wallet, bet, 3_000n);
    await submit.execute(refund);
    await submit.execute(bet);
    const before = await row(refund.idempotencyKey);
    const beforeWallet = await walletState(wallet.walletId);
    const [opening] = await sql<{ id: string }>(
      'select id from wallet_ledger_entries where wallet_id = ? order by created_at limit 1',
      [wallet.walletId],
    );
    const failures: PendingReferenceTask[] = [];

    // O id do lançamento já existe: o INSERT do ledger falha depois do UPDATE da transação e da wallet.
    const summary = await worker([wallet.walletId], {
      newId: () => opening?.id as string,
      onError: (task) => failures.push(task),
    }).runOnce();

    expect(summary).toMatchObject({ due: 1, failures: 1, processed: 0, deferred: 1 });
    expect(failures).toEqual([{ transactionId: before.id, walletId: wallet.walletId }]);
    // A tentativa foi desfeita inteira; só a quarentena, gravada depois do rollback, mudou a linha.
    const after = await row(refund.idempotencyKey);
    expect({ ...after, processing_failures: 0, next_ms: before.next_ms }).toEqual(before);
    expect(after.processing_failures).toBe(1);
    expect(await walletState(wallet.walletId)).toEqual(beforeWallet);

    // Vencida a quarentena, a causa (o id repetido) não existe mais: resolve e zera o contador.
    expect((await worker([wallet.walletId], { now: ahead(60_000) }).runOnce()).processed).toBe(1);
    expect(await row(refund.idempotencyKey)).toMatchObject({
      status: Processed,
      attempts: 1,
      processing_failures: 0,
    });
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '10000',
      rebuilt: '10000',
      credits: 2,
    });
  });

  test('reinício: a pendência gravada por uma instância é resolvida por outra, iniciada depois', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const refund = refundOf(wallet, bet, 3_000n);
    const first = await MikroORM.init(createOrmConfig());
    try {
      const result = await new SubmitWagerTransaction(
        new MikroOrmWagerTransactionRepository(first),
      ).execute(refund);
      expect(result.status).toBe(PendingReference);
    } finally {
      await first.close(true);
    }
    await submit.execute(bet);

    const restarted = await MikroORM.init(createOrmConfig());
    try {
      expect((await worker([wallet.walletId], {}, restarted).runOnce()).processed).toBe(1);
    } finally {
      await restarted.close(true);
    }
    expect(await row(refund.idempotencyKey)).toMatchObject({ status: Processed, entries: 1 });
  });

  test('reconciliação: em toda wallet usada, saldo armazenado = saldo reconstruído pelo ledger', async () => {
    expect(usedWallets.length).toBeGreaterThan(0);
    for (const walletId of usedWallets) {
      const state = await walletState(walletId);
      expect(state.rebuilt).toBe(state.balance);
      // Nenhuma transação pendente ou rejeitada tem lançamento (§6.4 e §7, regra 6).
      const [orphans] = await sql<{ count: number }>(
        `select count(*)::int as count from wallet_ledger_entries e
           join wager_transactions t on t.id = e.transaction_id
          where t.status <> 'PROCESSED' and t.wallet_id = ?`,
        [walletId],
      );
      expect(orphans?.count).toBe(0);
    }
  });
});
