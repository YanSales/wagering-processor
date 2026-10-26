import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { FailureCodes } from '../../src/application/failure-codes';
import { OpenWallet } from '../../src/application/open-wallet';
import {
  DEFAULT_REFERENCE_RETRY,
  ReferenceRetryPolicy,
} from '../../src/application/reference-retry-policy';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/submit-wager-transaction';
import type { PendingReferenceRepository } from '../../src/application/wager-transaction-repository';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// Grava no banco de teste (migrations reais aplicadas); recusa qualquer banco que não seja *_test.
assertTestDatabaseEnv();

const { Rejected, PendingReference } = WagerTransactionStatus;
const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
const policy = ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Duas instâncias do MikroORM, com pools independentes, no mesmo processo de teste.
let orm: MikroORM;
let otherOrm: MikroORM;
let submit: SubmitWagerTransaction;
let submitElsewhere: SubmitWagerTransaction;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

type WalletRef = { walletId: string; playerId: string };

async function openWallet(cents: bigint): Promise<WalletRef> {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: brl(cents),
  });
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

const betOn = (w: WalletRef, cents: bigint) => submission(WagerTransactionKind.Bet, w, cents);
const refundOf = (w: WalletRef, bet: SubmitWagerTransactionCommand) =>
  submission(WagerTransactionKind.Refund, w, bet.money.cents, {
    referenceExternalTransactionId: bet.externalTransactionId,
  });

interface OutboxRow {
  id: string;
  seq: string;
  transaction_id: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  message_group_id: string;
  correlation_id: string;
  payload: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    occurredAt: string;
    version: number;
    data: Record<string, unknown>;
  };
  /** `timestamptz` pelo SQL cru: texto. */
  occurred_at: string;
  attempts: number;
  claimed_until: string | null;
  claim_token: string | null;
  published_at: string | null;
  last_error_code: string | null;
}

/** Eventos de uma wallet (grupo FIFO), na ordem da outbox. */
const outboxOf = (walletId: string) =>
  sql<OutboxRow>(
    // `seq` é `bigint`: o driver devolve texto, sem perda.
    'select o.* from outbox_messages o where o.message_group_id = ? order by o.seq',
    [walletId],
  );

const typesOf = (rows: OutboxRow[]) => rows.map((r) => r.event_type);

async function transactionRow(idempotencyKey: string) {
  const [found] = await sql<{ id: string; status: string; correlation_id: string }>(
    'select id, status, correlation_id from wager_transactions where idempotency_key = ?',
    [idempotencyKey],
  );
  return found;
}

async function walletState(walletId: string) {
  const [state] = await sql<{ balance: string; version: number; entries: number }>(
    `select w.balance_cents::text as balance, w.version,
            (select count(*) from wallet_ledger_entries e where e.wallet_id = w.id)::int as entries
       from wallets w where w.id = ?`,
    [walletId],
  );
  return state;
}

/** Worker restrito às wallets informadas: o banco de teste é compartilhado pelos demais testes. */
function scoped(walletIds: string[], target: MikroORM = orm): PendingReferenceRepository {
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

/** `aheadMs` padrão: a primeira tentativa (2 s após a submissão) já venceu. */
function worker(repository: PendingReferenceRepository, retry = policy, aheadMs = 3_000) {
  return new ReprocessPendingReferences(repository, {
    batchSize: 50,
    now: ahead(aheadMs),
    policy: retry,
  });
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  otherOrm = await MikroORM.init(createOrmConfig());
  submit = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm));
  submitElsewhere = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(otherOrm));
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await otherOrm?.close(true);
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('abertura de wallet', () => {
  test('saldo inicial positivo: Processed da OPENING e WalletBalanceChanged de 0, versão 1', async () => {
    const wallet = await openWallet(10_000n);

    const rows = await outboxOf(wallet.walletId);

    expect(typesOf(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const [opening] = await sql<{ id: string; correlation_id: string }>(
      "select id, correlation_id from wager_transactions where wallet_id = ? and kind = 'OPENING'",
      [wallet.walletId],
    );
    for (const row of rows) {
      expect(row.transaction_id).toBe(opening?.id as string);
      expect(row.correlation_id).toBe(opening?.correlation_id as string);
    }
    expect(rows[1]?.payload.data).toEqual({
      walletId: wallet.walletId,
      transactionId: opening?.id,
      direction: 'CREDIT',
      money: { amount: '100.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      walletVersion: 1,
    });
    expect(rows[0]?.payload.data).toMatchObject({
      kind: 'OPENING',
      providerId: null,
      externalTransactionId: null,
      roundId: null,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
    });
  });

  test('saldo inicial zero: nenhum evento', async () => {
    const wallet = await openWallet(0n);

    expect(await outboxOf(wallet.walletId)).toEqual([]);
  });
});

describe('submissão: eventos gravados no mesmo commit', () => {
  test('BET: envelope completo persistido, coerente com as colunas', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 2_500n);

    const result = await submit.execute(bet);

    const tx = await transactionRow(bet.idempotencyKey);
    expect(tx?.correlation_id).toMatch(UUID);
    const rows = (await outboxOf(wallet.walletId)).filter((r) => r.transaction_id === tx?.id);
    expect(typesOf(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const [processed, balanceChanged] = rows as [OutboxRow, OutboxRow];
    expect(BigInt(processed.seq) < BigInt(balanceChanged.seq)).toBe(true);

    expect(processed.payload).toEqual({
      eventId: processed.id,
      eventType: 'WagerTransactionProcessed',
      aggregateId: result.transactionId,
      correlationId: tx?.correlation_id as string,
      occurredAt: new Date(processed.occurred_at).toISOString(),
      version: 1,
      data: {
        transactionId: result.transactionId,
        kind: 'BET',
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        providerId: 'provider-a',
        externalTransactionId: bet.externalTransactionId,
        roundId: 'round-1',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: null,
        referenceTransactionId: null,
      },
    });
    expect(processed).toMatchObject({
      aggregate_id: result.transactionId,
      event_version: 1,
      message_group_id: wallet.walletId,
      correlation_id: tx?.correlation_id,
      attempts: 0,
      claimed_until: null,
      claim_token: null,
      published_at: null,
      last_error_code: null,
    });
    expect(balanceChanged).toMatchObject({
      aggregate_id: wallet.walletId,
      transaction_id: result.transactionId,
      correlation_id: tx?.correlation_id,
    });
    expect(balanceChanged.payload.data).toEqual({
      walletId: wallet.walletId,
      transactionId: result.transactionId,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('WIN: Processed e crédito', async () => {
    const wallet = await openWallet(0n);
    const win = submission(WagerTransactionKind.Win, wallet, 1_000n);

    await submit.execute(win);

    const rows = await outboxOf(wallet.walletId);
    expect(typesOf(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(rows[1]?.payload.data).toMatchObject({ direction: 'CREDIT', walletVersion: 2 });
  });

  test('LOSS: somente Processed', async () => {
    const wallet = await openWallet(0n);

    await submit.execute(submission(WagerTransactionKind.Loss, wallet, 1_000n));

    expect(typesOf(await outboxOf(wallet.walletId))).toEqual(['WagerTransactionProcessed']);
  });

  test('rejeição de negócio: somente Rejected, com o failureCode do domínio', async () => {
    const wallet = await openWallet(0n);
    const bet = betOn(wallet, 1_000n);

    const result = await submit.execute(bet);

    expect(result.status).toBe(Rejected);
    const rows = await outboxOf(wallet.walletId);
    expect(typesOf(rows)).toEqual(['WagerTransactionRejected']);
    expect(rows[0]?.payload.data).toMatchObject({
      failureCode: FailureCodes.InsufficientFunds,
      referenceExternalTransactionId: null,
    });
    expect(rows[0]?.payload.data).not.toHaveProperty('referenceTransactionId');
  });

  test('REFUND com a BET já aplicada: Processed com a referência interna e crédito', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const betResult = await submit.execute(bet);

    await submit.execute(refundOf(wallet, bet));

    const rows = (await outboxOf(wallet.walletId)).slice(-2);
    expect(typesOf(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(rows[0]?.payload.data).toMatchObject({
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
      referenceTransactionId: betResult.transactionId,
    });
    expect(rows[1]?.payload.data).toMatchObject({ direction: 'CREDIT', walletVersion: 3 });
  });

  test('replay idempotente e conflito: nenhum evento novo', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 1_000n);
    await submit.execute(bet);
    const before = await outboxOf(wallet.walletId);

    const replay = await submit.execute(bet);
    const conflict = await submit.execute({ ...bet, money: brl(2_000n) }).catch((e: unknown) => e);

    expect(replay.idempotentReplay).toBe(true);
    expect(conflict).toBeInstanceOf(Error);
    expect(await outboxOf(wallet.walletId)).toEqual(before);
  });
});

describe('PENDING_REFERENCE e worker', () => {
  test('entrada, reagendamento e resolução: um PendingReference, depois Processed e crédito com a correlação original', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const refund = refundOf(wallet, bet);

    expect((await submit.execute(refund)).status).toBe(PendingReference);
    const tx = await transactionRow(refund.idempotencyKey);
    const pendingRows = (await outboxOf(wallet.walletId)).filter(
      (r) => r.transaction_id === tx?.id,
    );
    expect(typesOf(pendingRows)).toEqual(['WagerTransactionPendingReference']);
    expect(pendingRows[0]?.payload.data).toMatchObject({
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    // Reagendamento: a BET ainda não existe; a tentativa é contada e nenhum evento novo sai.
    expect((await worker(scoped([wallet.walletId])).runOnce()).rescheduled).toBe(1);
    const afterReschedule = await outboxOf(wallet.walletId);
    expect(afterReschedule.filter((r) => r.transaction_id === tx?.id)).toEqual(pendingRows);

    // A BET chega; o worker (outra instância do ORM, com o relógio além do reagendamento) resolve
    // e grava os eventos finais.
    await submit.execute(bet);
    const summary = await worker(scoped([wallet.walletId], otherOrm), policy, 600_000).runOnce();
    expect(summary.processed).toBe(1);

    const refundRows = (await outboxOf(wallet.walletId)).filter((r) => r.transaction_id === tx?.id);
    expect(typesOf(refundRows)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    // A correlação gravada na submissão é a mesma dos eventos produzidos pelo worker.
    expect(new Set(refundRows.map((r) => r.correlation_id))).toEqual(
      new Set([tx?.correlation_id as string]),
    );
    expect(refundRows.every((r) => r.payload.correlationId === tx?.correlation_id)).toBe(true);
    expect(refundRows[2]?.payload.data).toMatchObject({ direction: 'CREDIT', walletVersion: 3 });
  });

  test('tentativas esgotadas: Rejected REFERENCE_NOT_FOUND no mesmo commit do estado terminal', async () => {
    const wallet = await openWallet(10_000n);
    const refund = refundOf(wallet, betOn(wallet, 1_000n));
    await submit.execute(refund);
    const exhausted = ReferenceRetryPolicy.from({ ...DEFAULT_REFERENCE_RETRY, maxAttempts: 1 });

    expect((await worker(scoped([wallet.walletId]), exhausted).runOnce()).rejected).toBe(1);

    const tx = await transactionRow(refund.idempotencyKey);
    expect(tx?.status).toBe(Rejected);
    const rows = (await outboxOf(wallet.walletId)).filter((r) => r.transaction_id === tx?.id);
    expect(typesOf(rows)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(rows[1]?.payload.data).toMatchObject({ failureCode: FailureCodes.ReferenceNotFound });
  });

  test('falha transitória na tentativa: nenhum evento de conclusão', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const refund = refundOf(wallet, bet);
    await submit.execute(refund);
    await submit.execute(bet);
    const before = await outboxOf(wallet.walletId);
    const real = scoped([wallet.walletId]);
    const flaky: PendingReferenceRepository = {
      ...real,
      resolvePendingReference: (task, now, decide) =>
        real.resolvePendingReference(task, now, (state) => {
          decide(state);
          throw Object.assign(new Error('deadlock simulado'), { code: '40P01' });
        }),
    };

    expect((await worker(flaky).runOnce()).transientFailures).toBe(1);

    expect(await outboxOf(wallet.walletId)).toEqual(before);
    expect((await transactionRow(refund.idempotencyKey))?.status).toBe(PendingReference);
  });
});

describe('atomicidade com o PostgreSQL real', () => {
  test(
    'transação, saldo, ledger e eventos são gravados entre o mesmo begin e o mesmo commit',
    async () => {
      const wallet = await openWallet(10_000n);
      const queries: string[] = [];
      const logged = await MikroORM.init({
        ...createOrmConfig(),
        debug: ['query'],
        colors: false,
        logger: (message: string) => queries.push(message),
      });
      try {
        await new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(logged)).execute(
          betOn(wallet, 1_000n),
        );
      } finally {
        await logged.close(true);
      }

      const sequence = queries
        .map(
          (q) =>
            q.match(
              /\[query\] (begin|commit|rollback|insert into "\w+"|update "\w+"|select .* for update)/,
            )?.[1],
        )
        .filter(Boolean)
        .map((q) => (q?.startsWith('select') ? 'select … for update' : q));
      expect(sequence).toEqual([
        'begin',
        'select … for update',
        'insert into "wager_transactions"',
        'update "wallets"',
        'insert into "wallet_ledger_entries"',
        'insert into "outbox_messages"',
        'insert into "outbox_messages"',
        'commit',
      ]);
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );

  test('falha ao gravar a outbox (PK repetida) desfaz transação, saldo, versão e ledger', async () => {
    const wallet = await openWallet(10_000n);
    const [taken] = await outboxOf(wallet.walletId);
    const before = await walletState(wallet.walletId);
    const bet = betOn(wallet, 2_000n);
    const failing = new SubmitWagerTransaction(
      new MikroOrmWagerTransactionRepository(orm, () => taken?.id as string),
    );

    const error = await failing.execute(bet).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UniqueConstraintViolationException);
    expect((error as { constraint?: string }).constraint).toBe('outbox_messages_pkey');
    expect(await walletState(wallet.walletId)).toEqual(before);
    expect(await transactionRow(bet.idempotencyKey)).toBeUndefined();
    expect(await outboxOf(wallet.walletId)).toHaveLength(2);

    // Nada foi confirmado: a mesma submissão aplica o efeito e os eventos exatamente uma vez.
    expect((await submit.execute(bet)).idempotentReplay).toBe(false);
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '8000', version: 2 });
    expect(typesOf(await outboxOf(wallet.walletId))).toHaveLength(4);
  });

  test('falha ao gravar a outbox no worker desfaz a resolução: a pendência continua', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 3_000n);
    const refund = refundOf(wallet, bet);
    await submit.execute(refund);
    await submit.execute(bet);
    const [taken] = await outboxOf(wallet.walletId);
    const before = await walletState(wallet.walletId);
    const eventsBefore = await outboxOf(wallet.walletId);
    const real = new MikroOrmWagerTransactionRepository(orm, () => taken?.id as string);
    const failing: PendingReferenceRepository = {
      ...scoped([wallet.walletId]),
      resolvePendingReference: (task, now, decide) =>
        real.resolvePendingReference(task, now, decide),
    };

    const summary = await worker(failing).runOnce();

    expect(summary).toMatchObject({ processed: 0, failures: 1 });
    expect(await walletState(wallet.walletId)).toEqual(before);
    expect((await transactionRow(refund.idempotencyKey))?.status).toBe(PendingReference);
    expect(await outboxOf(wallet.walletId)).toEqual(eventsBefore);
  });

  test('falha ao gravar a outbox na abertura: nenhuma wallet, OPENING ou lançamento', async () => {
    const existing = await openWallet(10_000n);
    const [taken] = await outboxOf(existing.walletId);
    const playerId = `player-${randomUUID()}`;
    const failing = new OpenWallet(new MikroOrmWalletRepository(orm, () => taken?.id as string));

    const error = await failing
      .execute({ playerId, initialBalance: brl(5_000n) })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UniqueConstraintViolationException);
    const [count] = await sql<{ wallets: number }>(
      'select count(*)::int as wallets from wallets where player_id = ?',
      [playerId],
    );
    expect(count?.wallets).toBe(0);
  });

  test('falha no ledger ou no estado da transação: nenhum evento órfão', async () => {
    const wallet = await openWallet(10_000n);
    const [takenEntry] = await sql<{ id: string }>(
      'select id from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId],
    );
    const [takenTransaction] = await sql<{ id: string }>(
      'select id from wager_transactions where wallet_id = ?',
      [wallet.walletId],
    );
    const before = await outboxOf(wallet.walletId);

    // Lançamento com id já usado: falha depois da transação e do saldo, antes dos eventos.
    const ledgerIds = [randomUUID(), takenEntry?.id as string];
    const ledgerFailure = await new SubmitWagerTransaction(
      new MikroOrmWagerTransactionRepository(orm),
      () => new Date(),
      () => ledgerIds.shift() as string,
    )
      .execute(betOn(wallet, 1_000n))
      .catch((e: unknown) => e);
    // Transação com id já usado: falha ao gravar o estado.
    const stateIds = [takenTransaction?.id as string, randomUUID()];
    const stateFailure = await new SubmitWagerTransaction(
      new MikroOrmWagerTransactionRepository(orm),
      () => new Date(),
      () => stateIds.shift() as string,
    )
      .execute(betOn(wallet, 1_000n))
      .catch((e: unknown) => e);

    expect((ledgerFailure as { constraint?: string }).constraint).toBe(
      'wallet_ledger_entries_pkey',
    );
    expect(stateFailure).toBeInstanceOf(UniqueConstraintViolationException);
    expect(await outboxOf(wallet.walletId)).toEqual(before);
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '10000', version: 1 });
  });
});

describe('constraints e imutabilidade da outbox', () => {
  /** Copia uma linha com outro id (e o mesmo id no envelope), alterando o que for informado. */
  const copy = (id: string, payloadPatch = "jsonb_build_object('eventId', n.id::text)") =>
    sql(
      `with n as (select gen_random_uuid() as id)
       insert into outbox_messages (id, transaction_id, aggregate_id, event_type, event_version,
         message_group_id, correlation_id, payload, occurred_at, next_attempt_at)
       select n.id, s.transaction_id, s.aggregate_id, s.event_type, s.event_version,
              s.message_group_id, s.correlation_id, s.payload || ${payloadPatch}, s.occurred_at, now()
         from outbox_messages s, n where s.id = ?`,
      [id],
    );

  async function expectRejected(operation: Promise<unknown>, code: string, constraint?: string) {
    const error = (await operation.then(
      () => ({}),
      (e: unknown) => e,
    )) as { code?: string; constraint?: string };
    expect(error.code).toBe(code);
    if (constraint !== undefined) expect(error.constraint).toBe(constraint);
  }

  test('o mesmo tipo de evento duas vezes para a mesma transação é recusado', async () => {
    const wallet = await openWallet(10_000n);
    const [row] = await outboxOf(wallet.walletId);

    await expectRejected(
      copy(row?.id as string),
      '23505',
      'outbox_messages_transaction_event_type_unique',
    );
  });

  test('envelope divergente das colunas é recusado', async () => {
    const wallet = await openWallet(10_000n);
    const [row] = await outboxOf(wallet.walletId);

    await expectRejected(
      copy(
        row?.id as string,
        "jsonb_build_object('eventId', n.id::text, 'correlationId', gen_random_uuid()::text)",
      ),
      '23514',
      'outbox_messages_payload_check',
    );
  });

  test('conteúdo imutável; metadados operacionais atualizáveis', async () => {
    const wallet = await openWallet(10_000n);
    const [row] = await outboxOf(wallet.walletId);
    const id = row?.id as string;

    await expectRejected(
      sql(
        `update outbox_messages set payload = jsonb_set(payload, '{data,money,amount}', '"0.00"')
          where id = ?`,
        [id],
      ),
      'P0001',
    );
    await expectRejected(
      sql('update outbox_messages set correlation_id = gen_random_uuid() where id = ?', [id]),
      'P0001',
    );
    await sql(
      `update outbox_messages set attempts = 1, next_attempt_at = now(), last_error_code = 'X',
         claimed_until = now(), claim_token = gen_random_uuid(), published_at = now() where id = ?`,
      [id],
    );
    const [updated] = await outboxOf(wallet.walletId);
    expect(updated?.payload).toEqual(row?.payload as OutboxRow['payload']);
    expect(updated).toMatchObject({ attempts: 1, last_error_code: 'X' });
  });
});

describe('concorrência', () => {
  test('a mesma submissão entregue 10 vezes em dois pools: um efeito e dois eventos', async () => {
    const wallet = await openWallet(10_000n);
    const bet = betOn(wallet, 1_000n);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? submit : submitElsewhere).execute(bet)),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    const tx = await transactionRow(bet.idempotencyKey);
    const rows = (await outboxOf(wallet.walletId)).filter((r) => r.transaction_id === tx?.id);
    expect(typesOf(rows)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '9000', version: 2 });
  });

  test('BETs simultâneas na mesma wallet: a ordem da outbox acompanha a ordem de commit', async () => {
    const wallet = await openWallet(10_000n);
    const bets = Array.from({ length: 6 }, () => betOn(wallet, 1_000n));

    await Promise.all(bets.map((bet, i) => (i % 2 === 0 ? submit : submitElsewhere).execute(bet)));

    const changes = (await outboxOf(wallet.walletId))
      .filter((r) => r.event_type === 'WalletBalanceChanged')
      .map(
        (r) =>
          r.payload.data as {
            walletVersion: number;
            balanceBefore: unknown;
            balanceAfter: unknown;
          },
      );
    // Por `seq`: versões consecutivas e cada saldo anterior igual ao posterior do evento anterior.
    expect(changes.map((c) => c.walletVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < changes.length; i += 1) {
      expect(changes[i]?.balanceBefore).toEqual(changes[i - 1]?.balanceAfter);
    }
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '4000', version: 7 });
  });

  test('wallets diferentes em paralelo: cada grupo só tem os próprios eventos', async () => {
    const [a, b] = await Promise.all([openWallet(10_000n), openWallet(10_000n)]);
    const work = [a, b].flatMap((w) => [betOn(w, 1_000n), betOn(w, 2_000n)]);

    await Promise.all(work.map((bet, i) => (i % 2 === 0 ? submit : submitElsewhere).execute(bet)));

    for (const w of [a, b]) {
      const rows = await outboxOf(w.walletId);
      expect(rows).toHaveLength(6);
      expect(rows.every((r) => r.message_group_id === w.walletId)).toBe(true);
      expect(
        rows.every((r) => (r.payload.data as { walletId: string }).walletId === w.walletId),
      ).toBe(true);
    }
  });
});

describe('ordenação: premissas da sequência de seq', () => {
  test('a sequência de seq usa CACHE 1, premissa da ordem por wallet', async () => {
    // Somente leitura do catálogo: a sequência é a associada à coluna, não um nome presumido.
    const [sequence] = await sql<{ name: string | null; cache_size: string | null }>(
      `select r.name, s.cache_size::text as cache_size
         from (select pg_get_serial_sequence('outbox_messages', 'seq') as name) r
         left join pg_sequences s on s.schemaname || '.' || s.sequencename = r.name`,
    );

    if (sequence?.name == null) {
      throw new Error('outbox_messages.seq não tem sequência associada (esperado bigserial).');
    }
    if (sequence.cache_size !== '1') {
      throw new Error(
        `A sequência ${sequence.name} usa CACHE ${sequence.cache_size ?? '(não encontrada em pg_sequences)'}; ` +
          'a ordem por wallet exige CACHE 1 (ver ARCHITECTURE.md, "Ordenação").',
      );
    }
    expect(sequence).toEqual({ name: 'public.outbox_messages_seq_seq', cache_size: '1' });
  });
});

describe('migration: correlação das transações existentes', () => {
  test('revertida e reaplicada, preenche a correlação das linhas antigas sem alterar o resto', async () => {
    const executed = (await orm.migrator.getExecuted()).map((m) => m.name);
    const last = executed[executed.length - 1] as string;
    expect(last.endsWith('_outbox_messages')).toBe(true);

    const reverted = await orm.migrator.down();
    expect(reverted.map((m) => m.name)).toEqual([last]);

    // Transação gravada como antes desta migration: sem `correlation_id`.
    const walletId = randomUUID();
    const transactionId = randomUUID();
    await sql(
      `insert into wallets (id, player_id, currency, balance_cents, version, created_at, updated_at)
       values (?, ?, 'BRL', 0, 1, now(), now())`,
      [walletId, `player-${randomUUID()}`],
    );
    await sql(
      `insert into wager_transactions (id, wallet_id, player_id, kind, status, provider_id,
         external_transaction_id, idempotency_key, payload_hash, round_id, game_id, money_cents,
         currency, failure_code, result_balance_cents, created_at)
       values (?, ?, 'p', 'BET', 'REJECTED', 'provider-a', ?, ?, 'h', 'r', 'g', 100, 'BRL',
         'INSUFFICIENT_FUNDS', 0, now())`,
      [transactionId, walletId, `ext-${transactionId}`, `provider-a:ext-${transactionId}`],
    );

    expect((await orm.migrator.up()).map((m) => m.name)).toEqual([last]);

    const [legacy] = await sql<{ correlation_id: string; status: string; failure_code: string }>(
      'select correlation_id, status, failure_code from wager_transactions where id = ?',
      [transactionId],
    );
    expect(legacy).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(legacy?.correlation_id).toMatch(UUID);
    const [nulls] = await sql<{ missing: number }>(
      'select count(*)::int as missing from wager_transactions where correlation_id is null',
    );
    expect(nulls?.missing).toBe(0);
  });
});
