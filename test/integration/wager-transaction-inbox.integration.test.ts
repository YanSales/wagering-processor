import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  HandleWagerTransactionMessage,
  WAGER_TRANSACTIONS_CONSUMER,
  type WagerTransactionMessage,
} from '../../src/application/inbox/handle-wager-transaction-message';
import { OpenWallet } from '../../src/application/open-wallet';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import {
  TransientPersistenceError,
  type WagerTransactionRepository,
} from '../../src/application/wager-transaction-repository';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmInboxRepository } from '../../src/database/repositories/inbox.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// PostgreSQL real com as migrations aplicadas; recusa qualquer banco que não seja *_test.
assertTestDatabaseEnv();

const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');

// Duas instâncias do MikroORM, com pools independentes: dois consumidores em instâncias diferentes.
let orm: MikroORM;
let otherOrm: MikroORM;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

function handlerOn(target: MikroORM, repository?: WagerTransactionRepository) {
  return new HandleWagerTransactionMessage(
    new SubmitWagerTransaction(repository ?? new MikroOrmWagerTransactionRepository(target)),
    new MikroOrmInboxRepository(target),
  );
}

async function openWallet(cents: bigint) {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: brl(cents),
  });
  return { walletId: wallet.id, playerId };
}

function betMessage(
  wallet: { walletId: string; playerId: string },
  cents: bigint,
  overrides: Partial<WagerTransactionMessage['command']> = {},
): WagerTransactionMessage {
  const externalTransactionId = `bet-${randomUUID()}`;
  return {
    messageId: `msg-${randomUUID()}`,
    command: {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl(cents),
      ...overrides,
    },
  };
}

async function state(walletId: string) {
  const [row] = await sql<{ balance: string; entries: number; transactions: number }>(
    `select w.balance_cents::text as balance,
            (select count(*) from wallet_ledger_entries e where e.wallet_id = w.id)::int as entries,
            (select count(*) from wager_transactions t
              where t.wallet_id = w.id and t.kind <> 'OPENING')::int as transactions
       from wallets w where w.id = ?`,
    [walletId],
  );
  return row;
}

const inboxRow = async (messageId: string) =>
  (
    await sql<{ transaction_id: string }>(
      'select transaction_id from inbox_messages where consumer_name = ? and message_id = ?',
      [WAGER_TRANSACTIONS_CONSUMER, messageId],
    )
  )[0];

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  otherOrm = await MikroORM.init(createOrmConfig());
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await otherOrm?.close(true);
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('consumidor: Inbox e efeito financeiro na mesma transação', () => {
  test('mensagem válida: um débito, Inbox gravada com a transação; repetida, nada novo', async () => {
    const wallet = await openWallet(10_000n);
    const message = betMessage(wallet, 2_500n);

    const first = await handlerOn(orm).handle(message);
    const again = await handlerOn(orm).handle(message);

    expect(first).toMatchObject({ action: 'ack', outcome: 'processed' });
    expect(again).toEqual({
      action: 'ack',
      outcome: 'duplicate',
      transactionId: (first as { transactionId: string }).transactionId,
    });
    expect((await inboxRow(message.messageId))?.transaction_id).toBe(
      (first as { transactionId: string }).transactionId,
    );
    expect(await state(wallet.walletId)).toEqual({ balance: '7500', entries: 2, transactions: 1 });
  });

  test('mesma operação com outro messageId: replay sem efeito, registrado na Inbox', async () => {
    const wallet = await openWallet(10_000n);
    const message = betMessage(wallet, 1_000n);
    const resent = { ...message, messageId: `msg-${randomUUID()}` };

    await handlerOn(orm).handle(message);
    const replay = await handlerOn(orm).handle(resent);

    expect(replay).toMatchObject({ action: 'ack', outcome: 'replay' });
    expect(await inboxRow(resent.messageId)).toBeDefined();
    expect(await state(wallet.walletId)).toEqual({ balance: '9000', entries: 2, transactions: 1 });
  });

  test('mesmo messageId com outro conteúdo: DLQ, sem efeito', async () => {
    const wallet = await openWallet(10_000n);
    const message = betMessage(wallet, 1_000n);
    await handlerOn(orm).handle(message);

    const conflict = await handlerOn(orm).handle({
      ...message,
      command: { ...message.command, money: brl(2_000n) },
    });

    expect(conflict).toEqual({ action: 'dlq', reason: 'MESSAGE_ID_CONFLICT' });
    expect(await state(wallet.walletId)).toEqual({ balance: '9000', entries: 2, transactions: 1 });
  });

  test('falha antes do commit (outbox): nem Inbox, nem transação, nem saldo; depois, uma vez', async () => {
    const wallet = await openWallet(10_000n);
    const [taken] = await sql<{ id: string }>(
      'select id from outbox_messages where message_group_id = ? limit 1',
      [wallet.walletId],
    );
    const message = betMessage(wallet, 3_000n);
    // Repositório que gera um eventId já usado: o INSERT na outbox falha depois do débito e da Inbox.
    const failing = new MikroOrmWagerTransactionRepository(orm, () => taken?.id as string);

    const failed = await handlerOn(orm, failing).handle(message);

    expect(failed.action).toBe('retry');
    expect(await inboxRow(message.messageId)).toBeUndefined();
    expect(await state(wallet.walletId)).toEqual({ balance: '10000', entries: 1, transactions: 0 });

    // A reentrega processa normalmente, uma única vez.
    expect(await handlerOn(orm).handle(message)).toMatchObject({ outcome: 'processed' });
    expect(await state(wallet.walletId)).toEqual({ balance: '7000', entries: 2, transactions: 1 });
  });

  test('falha transitória: retry sem gravar; a nova tentativa aplica', async () => {
    const wallet = await openWallet(10_000n);
    const message = betMessage(wallet, 1_000n);
    const real = new MikroOrmWagerTransactionRepository(orm);
    const flaky: WagerTransactionRepository = {
      findExisting: (keys) => real.findExisting(keys),
      applyToLockedWallet: async () => {
        throw new TransientPersistenceError({ cause: new Error('deadlock simulado') });
      },
    };

    expect(await handlerOn(orm, flaky).handle(message)).toEqual({
      action: 'retry',
      reason: 'TRANSIENT',
    });
    expect(await inboxRow(message.messageId)).toBeUndefined();
    expect(await handlerOn(orm).handle(message)).toMatchObject({ outcome: 'processed' });
    expect(await state(wallet.walletId)).toMatchObject({ balance: '9000', transactions: 1 });
  });

  test('rejeição de negócio é terminal: ack, gravada com a Inbox; erros permanentes vão à DLQ', async () => {
    const wallet = await openWallet(1_000n);
    const insufficient = betMessage(wallet, 5_000n);
    const unknownWallet = betMessage({ walletId: randomUUID(), playerId: 'p' }, 100n);
    // LOSS com referência: o contrato não define a regra; recusada sem gravar.
    const rollback = betMessage(wallet, 100n, {
      kind: WagerTransactionKind.Loss,
      referenceExternalTransactionId: 'bet-x',
    });

    expect(await handlerOn(orm).handle(insufficient)).toMatchObject({
      action: 'ack',
      outcome: 'processed',
    });
    const [rejected] = await sql<{ status: string }>(
      'select status from wager_transactions where idempotency_key = ?',
      [insufficient.command.idempotencyKey],
    );
    expect(rejected?.status).toBe('REJECTED');
    expect(await inboxRow(insufficient.messageId)).toBeDefined();

    expect(await handlerOn(orm).handle(unknownWallet)).toEqual({
      action: 'dlq',
      reason: 'WALLET_NOT_FOUND',
    });
    expect(await handlerOn(orm).handle(rollback)).toEqual({
      action: 'dlq',
      reason: 'UNSUPPORTED_SUBMISSION',
    });
    // Enviadas à DLQ não ficam na Inbox: podem ser reprocessadas depois de corrigidas.
    expect(await inboxRow(unknownWallet.messageId)).toBeUndefined();
    expect(await inboxRow(rollback.messageId)).toBeUndefined();
    expect(await state(wallet.walletId)).toEqual({ balance: '1000', entries: 1, transactions: 1 });
  });

  test('a mesma mensagem entregue 10 vezes em paralelo, em dois pools: um único efeito', async () => {
    const wallet = await openWallet(10_000n);
    const message = betMessage(wallet, 1_000n);
    const handlers = [handlerOn(orm), handlerOn(otherOrm)];

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => handlers[i % 2]?.handle(message)),
    );

    expect(results.every((r) => r?.action === 'ack')).toBe(true);
    expect(results.filter((r) => r?.action === 'ack' && r.outcome === 'processed')).toHaveLength(1);
    expect(new Set(results.map((r) => (r as { transactionId: string }).transactionId)).size).toBe(
      1,
    );
    expect(await state(wallet.walletId)).toEqual({ balance: '9000', entries: 2, transactions: 1 });
    const [count] = await sql<{ n: number }>(
      'select count(*)::int as n from inbox_messages where message_id = ?',
      [message.messageId],
    );
    expect(count?.n).toBe(1);
  });
});
