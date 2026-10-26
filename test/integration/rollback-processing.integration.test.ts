import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../src/application/open-wallet';
import { ReconcileWallet } from '../../src/application/queries';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/submit-wager-transaction';
import type { PendingReferenceRepository } from '../../src/application/wager-transaction-repository';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmQueryRepository } from '../../src/database/repositories/query.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// PostgreSQL real com as migrations aplicadas; recusa qualquer banco que não seja *_test.
assertTestDatabaseEnv();

const { Processed, Rejected, PendingReference } = WagerTransactionStatus;
const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');

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

function command(
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

const rollbackOf = (wallet: WalletRef, reference: SubmitWagerTransactionCommand) =>
  command(WagerTransactionKind.Rollback, wallet, reference.money.cents, {
    referenceExternalTransactionId: reference.externalTransactionId,
  });

async function walletState(walletId: string) {
  const [row] = await sql<{ balance: string; version: number; entries: number }>(
    `select w.balance_cents::text as balance, w.version,
            (select count(*) from wallet_ledger_entries e where e.wallet_id = w.id)::int as entries
       from wallets w where w.id = ?`,
    [walletId],
  );
  return row;
}

/** Invariante do §13: saldo armazenado == saldo reconstruído pelo ledger. */
async function expectConsistent(walletId: string) {
  const result = await new ReconcileWallet(new MikroOrmQueryRepository(orm)).execute(walletId);
  expect(result?.consistent).toBe(true);
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

describe('ROLLBACK com o PostgreSQL real', () => {
  test('de BET: crédito, PROCESSED com a referência, eventos e replay com o saldo original', async () => {
    const wallet = await openWallet(10_000n);
    const bet = command(WagerTransactionKind.Bet, wallet, 3_000n);
    const betResult = await submit.execute(bet);
    const rollback = rollbackOf(wallet, bet);

    const result = await submit.execute(rollback);
    await submit.execute(command(WagerTransactionKind.Bet, wallet, 1_000n)); // muda o saldo
    const replay = await submit.execute(rollback);

    expect(result).toMatchObject({ status: Processed, idempotentReplay: false });
    expect(result.balance.cents).toBe(10_000n);
    expect(replay).toMatchObject({ status: Processed, idempotentReplay: true });
    expect(replay.balance.cents).toBe(10_000n);
    const [row] = await sql<{ reference_transaction_id: string }>(
      'select reference_transaction_id from wager_transactions where id = ?',
      [result.transactionId],
    );
    expect(row?.reference_transaction_id).toBe(betResult.transactionId);
    const events = await sql<{ event_type: string; direction: string | null }>(
      `select event_type, payload -> 'data' ->> 'direction' as direction from outbox_messages
        where transaction_id = ? order by seq`,
      [result.transactionId],
    );
    expect(events).toEqual([
      { event_type: 'WagerTransactionProcessed', direction: null },
      { event_type: 'WalletBalanceChanged', direction: 'CREDIT' },
    ]);
    await expectConsistent(wallet.walletId);
  });

  test('de WIN e de REFUND: débito do mesmo valor', async () => {
    const wallet = await openWallet(10_000n);
    const win = command(WagerTransactionKind.Win, wallet, 2_000n);
    await submit.execute(win);
    const bet = command(WagerTransactionKind.Bet, wallet, 1_000n);
    await submit.execute(bet);
    const refund = command(WagerTransactionKind.Refund, wallet, 1_000n, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await submit.execute(refund);

    expect((await submit.execute(rollbackOf(wallet, win))).status).toBe(Processed);
    expect((await submit.execute(rollbackOf(wallet, refund))).status).toBe(Processed);

    // 100 + 20 (WIN) − 10 (BET) + 10 (REFUND) − 20 (ROLLBACK WIN) − 10 (ROLLBACK REFUND) = 90
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '9000', entries: 6 });
    await expectConsistent(wallet.walletId);
  });

  test('saldo insuficiente para o débito: REJECTED REVERSAL_WOULD_OVERDRAW, sem efeito (regra 9)', async () => {
    const wallet = await openWallet(0n);
    const win = command(WagerTransactionKind.Win, wallet, 5_000n);
    await submit.execute(win);
    await submit.execute(command(WagerTransactionKind.Bet, wallet, 4_000n));
    const before = await walletState(wallet.walletId);

    const result = await submit.execute(rollbackOf(wallet, win));

    expect(result).toMatchObject({ status: Rejected, failureCode: 'REVERSAL_WOULD_OVERDRAW' });
    expect(await walletState(wallet.walletId)).toEqual(before);
    const [event] = await sql<{ event_type: string; code: string }>(
      `select event_type, payload -> 'data' ->> 'failureCode' as code from outbox_messages
        where transaction_id = ?`,
      [result.transactionId],
    );
    expect(event).toEqual({
      event_type: 'WagerTransactionRejected',
      code: 'REVERSAL_WOULD_OVERDRAW',
    });
  });

  test('dois ROLLBACKs da mesma BET em paralelo, em dois pools: um aplicado, o outro rejeitado', async () => {
    const wallet = await openWallet(10_000n);
    const bet = command(WagerTransactionKind.Bet, wallet, 3_000n);
    await submit.execute(bet);

    const results = await Promise.all([
      submit.execute(rollbackOf(wallet, bet)),
      submitElsewhere.execute(rollbackOf(wallet, bet)),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([Processed, Rejected].sort());
    expect(results.find((r) => r.status === Rejected)?.failureCode).toBe(
      'REFERENCE_ALREADY_REVERSED',
    );
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '10000', entries: 3 });
    await expectConsistent(wallet.walletId);
  });

  test('referência inválida: valor diferente e tipo não reversível rejeitados sem efeito', async () => {
    const wallet = await openWallet(10_000n);
    const bet = command(WagerTransactionKind.Bet, wallet, 3_000n);
    await submit.execute(bet);
    const loss = command(WagerTransactionKind.Loss, wallet, 0n);
    await submit.execute(loss);

    const partial = await submit.execute(
      command(WagerTransactionKind.Rollback, wallet, 1_000n, {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const ofLoss = await submit.execute(
      command(WagerTransactionKind.Rollback, wallet, 1n, {
        referenceExternalTransactionId: loss.externalTransactionId,
      }),
    );

    expect(partial.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect(ofLoss.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '7000', entries: 2 });
  });

  test('ROLLBACK antes da BET: PENDING_REFERENCE; o worker aplica quando a BET chega', async () => {
    const wallet = await openWallet(10_000n);
    const bet = command(WagerTransactionKind.Bet, wallet, 3_000n);
    const rollback = rollbackOf(wallet, bet);

    expect((await submit.execute(rollback)).status).toBe(PendingReference);
    await submit.execute(bet);

    const real = new MikroOrmWagerTransactionRepository(orm);
    const scoped: PendingReferenceRepository = {
      async findDuePendingReferences(now, limit) {
        const due = await real.findDuePendingReferences(now, 10_000);
        return due.filter((t) => t.walletId === wallet.walletId).slice(0, limit);
      },
      resolvePendingReference: (task, now, decide) =>
        real.resolvePendingReference(task, now, decide),
      deferAfterFailure: (task, now, next) => real.deferAfterFailure(task, now, next),
    };
    const summary = await new ReprocessPendingReferences(scoped, {
      batchSize: 10,
      now: () => new Date(Date.now() + 600_000),
    }).runOnce();

    expect(summary.processed).toBe(1);
    const replay = await submit.execute(rollback);
    expect(replay).toMatchObject({ status: Processed, idempotentReplay: true });
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '10000', entries: 3 });
    await expectConsistent(wallet.walletId);
  });
});

const refundOf = (wallet: WalletRef, reference: SubmitWagerTransactionCommand) =>
  command(WagerTransactionKind.Refund, wallet, reference.money.cents, {
    referenceExternalTransactionId: reference.externalTransactionId,
  });

/** Eventos da outbox de uma transação, em ordem. */
const eventsOf = async (transactionId: string) =>
  (
    await sql<{ event_type: string; code: string | null }>(
      `select event_type, payload -> 'data' ->> 'failureCode' as code from outbox_messages
        where transaction_id = ? order by seq`,
      [transactionId],
    )
  ).map((e) => (e.code === null ? e.event_type : `${e.event_type}:${e.code}`));

describe('uma reversão por operação, qualquer que seja o tipo (REFUND ou ROLLBACK)', () => {
  test.each([
    ['REFUND seguido de ROLLBACK', refundOf, rollbackOf],
    ['ROLLBACK seguido de REFUND', rollbackOf, refundOf],
  ])('%s: a segunda é REJECTED, saldo e ledger mudam uma vez', async (_case, first, second) => {
    const wallet = await openWallet(10_000n);
    const bet = command(WagerTransactionKind.Bet, wallet, 3_000n);
    await submit.execute(bet);

    const applied = await submit.execute(first(wallet, bet));
    const refused = await submit.execute(second(wallet, bet));

    expect(applied.status).toBe(Processed);
    expect(refused).toMatchObject({
      status: Rejected,
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    expect(refused.balance.cents).toBe(10_000n);
    // Abertura, débito da BET e um único crédito de reversão.
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '10000', entries: 3 });
    expect(await eventsOf(applied.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(await eventsOf(refused.transactionId)).toEqual([
      'WagerTransactionRejected:REFERENCE_ALREADY_REVERSED',
    ]);
    const [reversals] = await sql<{ n: number }>(
      `select count(*)::int as n from wager_transactions t join wager_transactions b
         on b.id = t.reference_transaction_id where b.external_transaction_id = ?`,
      [bet.externalTransactionId],
    );
    expect(reversals?.n).toBe(1);
    await expectConsistent(wallet.walletId);
  });

  test('REFUND e ROLLBACK da mesma BET em paralelo, em dois pools: exatamente um aplicado', async () => {
    for (let round = 0; round < 5; round += 1) {
      const wallet = await openWallet(10_000n);
      const bet = command(WagerTransactionKind.Bet, wallet, 3_000n);
      await submit.execute(bet);
      const refund = refundOf(wallet, bet);
      const rollback = rollbackOf(wallet, bet);

      // Alterna qual pool recebe cada tipo, para não favorecer um deles.
      const [a, b] = round % 2 === 0 ? [submit, submitElsewhere] : [submitElsewhere, submit];
      const results = await Promise.all([a.execute(refund), b.execute(rollback)]);

      expect(results.map((r) => r.status).sort()).toEqual([Processed, Rejected].sort());
      const loser = results.find((r) => r.status === Rejected);
      expect(loser?.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
      expect(await walletState(wallet.walletId)).toMatchObject({ balance: '10000', entries: 3 });
      const balanceChanges = await sql<{ n: number }>(
        `select count(*)::int as n from outbox_messages
          where message_group_id = ? and event_type = 'WalletBalanceChanged'`,
        [wallet.walletId],
      );
      // Abertura, BET e uma única reversão.
      expect(balanceChanges[0]?.n).toBe(3);

      // Replays idempotentes devolvem os resultados originais, sem novo efeito nem evento.
      const before = await sql<{ n: number }>(
        'select count(*)::int as n from outbox_messages where message_group_id = ?',
        [wallet.walletId],
      );
      const replays = await Promise.all([
        submit.execute(refund),
        submitElsewhere.execute(rollback),
      ]);
      expect(replays.every((r) => r.idempotentReplay)).toBe(true);
      expect(replays.map((r) => r.status)).toEqual(results.map((r) => r.status));
      const after = await sql<{ n: number }>(
        'select count(*)::int as n from outbox_messages where message_group_id = ?',
        [wallet.walletId],
      );
      expect(after[0]?.n).toBe(before[0]?.n);
      await expectConsistent(wallet.walletId);
    }
  });

  test('REFUND pendente perde para um ROLLBACK aplicado antes: o worker o rejeita', async () => {
    const wallet = await openWallet(10_000n);
    const bet = command(WagerTransactionKind.Bet, wallet, 3_000n);
    const refund = refundOf(wallet, bet);

    expect((await submit.execute(refund)).status).toBe(PendingReference);
    await submit.execute(bet);
    expect((await submit.execute(rollbackOf(wallet, bet))).status).toBe(Processed);

    const real = new MikroOrmWagerTransactionRepository(orm);
    const scoped: PendingReferenceRepository = {
      async findDuePendingReferences(now, limit) {
        const due = await real.findDuePendingReferences(now, 10_000);
        return due.filter((t) => t.walletId === wallet.walletId).slice(0, limit);
      },
      resolvePendingReference: (task, now, decide) =>
        real.resolvePendingReference(task, now, decide),
      deferAfterFailure: (task, now, next) => real.deferAfterFailure(task, now, next),
    };
    const summary = await new ReprocessPendingReferences(scoped, {
      batchSize: 10,
      now: () => new Date(Date.now() + 600_000),
    }).runOnce();

    expect(summary.rejected).toBe(1);
    expect(await submit.execute(refund)).toMatchObject({
      status: Rejected,
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      idempotentReplay: true,
    });
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '10000', entries: 3 });
    await expectConsistent(wallet.walletId);
  });

  test('ROLLBACK de um REFUND continua permitido: reverte outra operação (o REFUND)', async () => {
    const wallet = await openWallet(10_000n);
    const bet = command(WagerTransactionKind.Bet, wallet, 3_000n);
    await submit.execute(bet);
    const refund = refundOf(wallet, bet);
    await submit.execute(refund);

    expect((await submit.execute(rollbackOf(wallet, refund))).status).toBe(Processed);
    // A BET já foi revertida pelo REFUND: um ROLLBACK dela é recusado.
    expect((await submit.execute(rollbackOf(wallet, bet))).failureCode).toBe(
      'REFERENCE_ALREADY_REVERSED',
    );
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '7000', entries: 4 });
    await expectConsistent(wallet.walletId);
  });
});
