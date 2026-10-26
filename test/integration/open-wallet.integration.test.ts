import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../src/application/open-wallet';
import { WalletAlreadyExistsError } from '../../src/application/wallet-repository';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// Grava no banco de teste (migrations reais aplicadas); recusa qualquer banco que não seja *_test.
assertTestDatabaseEnv();

const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
let orm: MikroORM;
const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

/** Gerador de ids que registra o que entregou (wallet, OPENING e lançamento, nessa ordem). */
function recordingIds(preset: string[] = []) {
  const issued: string[] = [];
  const next = () => {
    const id = preset[issued.length] ?? randomUUID();
    issued.push(id);
    return id;
  };
  return { next, issued };
}

function openWallet(ids = recordingIds(), repository = new MikroOrmWalletRepository(orm)) {
  return { useCase: new OpenWallet(repository, () => new Date(), ids.next), ids };
}

interface Persisted {
  wallets: { id: string; balance: string; version: number; currency: string }[];
  transactions: {
    id: string;
    kind: string;
    status: string;
    money: string;
    currency: string;
    processed: boolean;
    submission: (string | null)[];
  }[];
  entries: {
    id: string;
    transaction_id: string;
    direction: string;
    money: string;
    before: string;
    after: string;
    currency: string;
  }[];
}

/** Estado real no PostgreSQL de tudo que pertence às wallets do player. */
async function persistedFor(playerId: string): Promise<Persisted> {
  const wallets = await sql<Persisted['wallets'][number]>(
    'select id, balance_cents::text as balance, version, currency from wallets where player_id = ? order by created_at',
    [playerId],
  );
  const ids = wallets.map((w) => w.id);
  if (ids.length === 0) return { wallets, transactions: [], entries: [] };
  const transactions = await sql<Persisted['transactions'][number]>(
    `select id, kind, status, money_cents::text as money, currency, processed_at is not null as processed,
            array[provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id,
                  reference_external_transaction_id, reference_transaction_id::text] as submission
       from wager_transactions where wallet_id in (?)`,
    [ids],
  );
  const entries = await sql<Persisted['entries'][number]>(
    `select id, transaction_id, direction, money_cents::text as money, balance_before_cents::text as before,
            balance_after_cents::text as after, currency from wallet_ledger_entries where wallet_id in (?)`,
    [ids],
  );
  return { wallets, transactions, entries };
}

async function countById(ids: string[]) {
  const [row] = await sql<{ wallets: number; transactions: number; entries: number }>(
    `select (select count(*) from wallets where id in (?))::int as wallets,
            (select count(*) from wager_transactions where id in (?))::int as transactions,
            (select count(*) from wallet_ledger_entries where id in (?))::int as entries`,
    [ids, ids, ids],
  );
  return row;
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('abertura de wallet no PostgreSQL', () => {
  test('saldo inicial zero cria só a wallet, sem OPENING nem lançamento', async () => {
    const playerId = `player-${randomUUID()}`;

    const wallet = await openWallet().useCase.execute({ playerId, initialBalance: brl(0n) });

    const state = await persistedFor(playerId);
    expect(state.wallets).toEqual([{ id: wallet.id, balance: '0', version: 1, currency: 'BRL' }]);
    expect(state.transactions).toEqual([]);
    expect(state.entries).toEqual([]);
  });

  test('saldo inicial positivo cria wallet, OPENING processada e CREDIT coerentes', async () => {
    const playerId = `player-${randomUUID()}`;
    const { useCase, ids } = openWallet();

    const wallet = await useCase.execute({ playerId, initialBalance: brl(100_000n) });

    const [walletId, openingId, entryId] = ids.issued;
    const state = await persistedFor(playerId);
    expect(wallet.id).toBe(walletId as string);
    expect(state.wallets).toEqual([
      { id: walletId as string, balance: '100000', version: 1, currency: 'BRL' },
    ]);
    expect(state.transactions).toEqual([
      {
        id: openingId as string,
        kind: 'OPENING',
        status: 'PROCESSED',
        money: '100000',
        currency: 'BRL',
        processed: true,
        // Nenhum dado externo inventado: campos de submissão e referências nulos.
        submission: [null, null, null, null, null, null, null, null],
      },
    ]);
    expect(state.entries).toEqual([
      {
        id: entryId as string,
        transaction_id: openingId as string,
        direction: 'CREDIT',
        money: '100000',
        before: '0',
        after: '100000',
        currency: 'BRL',
      },
    ]);
  });

  test('saldo armazenado == saldo reconstruído pelo ledger, após o commit', async () => {
    const playerId = `player-${randomUUID()}`;
    const wallet = await openWallet().useCase.execute({ playerId, initialBalance: brl(2_500n) });

    const [row] = await sql<{ stored: string; rebuilt: string; last_after: string }>(
      `select w.balance_cents::text as stored,
              coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)::text as rebuilt,
              max(e.balance_after_cents)::text as last_after
         from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
        where w.id = ? group by w.balance_cents`,
      [wallet.id],
    );
    expect(row).toEqual({ stored: '2500', rebuilt: '2500', last_after: '2500' });
  });

  test('saldo bigint além de Number.MAX_SAFE_INTEGER é gravado sem perda', async () => {
    const playerId = `player-${randomUUID()}`;

    await openWallet().useCase.execute({ playerId, initialBalance: brl(9_007_199_254_740_993n) });

    const state = await persistedFor(playerId);
    expect(state.wallets[0]?.balance).toBe('9007199254740993');
    expect(state.entries[0]?.after).toBe('9007199254740993');
  });
});

describe('atomicidade e conflitos', () => {
  test(
    'falha no último INSERT (ledger) reverte wallet e OPENING já enviadas na mesma transação',
    async () => {
      // Uma abertura existente fornece um id de lançamento já usado.
      const existing = openWallet();
      await existing.useCase.execute({
        playerId: `player-${randomUUID()}`,
        initialBalance: brl(100n),
      });
      const takenEntryId = existing.ids.issued[2] as string;

      // ORM com log de SQL só para este caso, para provar a ordem real dos comandos.
      const queries: string[] = [];
      const logged = await MikroORM.init({
        ...createOrmConfig(),
        debug: ['query'],
        colors: false,
        logger: (message: string) => queries.push(message),
      });
      try {
        const playerId = `player-${randomUUID()}`;
        const ids = recordingIds([randomUUID(), randomUUID(), takenEntryId]);
        const { useCase } = openWallet(ids, new MikroOrmWalletRepository(logged));

        let caught: unknown;
        try {
          await useCase.execute({ playerId, initialBalance: brl(50_000n) });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(UniqueConstraintViolationException);
        expect((caught as { constraint?: string }).constraint).toBe('wallet_ledger_entries_pkey');
        expect(caught).not.toBeInstanceOf(WalletAlreadyExistsError);
        const sequence = queries
          .map((q) => q.match(/\[query\] (begin|commit|rollback|insert into "(\w+)")/)?.[1])
          .filter(Boolean);
        expect(sequence).toEqual([
          'begin',
          'insert into "wallets"',
          'insert into "wager_transactions"',
          'insert into "wallet_ledger_entries"',
          'rollback',
        ]);
        const [walletId, openingId] = ids.issued as [string, string];
        expect(await countById([walletId, openingId])).toEqual({
          wallets: 0,
          transactions: 0,
          entries: 0,
        });
        expect((await persistedFor(playerId)).wallets).toEqual([]);
      } finally {
        await logged.close(true);
      }
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );

  test('wallet duplicada é conflito e não deixa registros financeiros parciais', async () => {
    const playerId = `player-${randomUUID()}`;
    await openWallet().useCase.execute({ playerId, initialBalance: brl(100_000n) });
    const before = await persistedFor(playerId);
    const second = openWallet();

    await expect(second.useCase.execute({ playerId, initialBalance: brl(7_000n) })).rejects.toThrow(
      WalletAlreadyExistsError,
    );

    expect(await persistedFor(playerId)).toEqual(before);
    expect(await countById(second.ids.issued)).toEqual({ wallets: 0, transactions: 0, entries: 0 });
  });

  test('duas aberturas simultâneas do mesmo player e moeda: uma vence, a outra é conflito', async () => {
    const playerId = `player-${randomUUID()}`;
    const attempts = [openWallet(), openWallet()];

    const results = await Promise.allSettled(
      attempts.map(({ useCase }) => useCase.execute({ playerId, initialBalance: brl(1_000n) })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(WalletAlreadyExistsError);
    const state = await persistedFor(playerId);
    expect([state.wallets.length, state.transactions.length, state.entries.length]).toEqual([
      1, 1, 1,
    ]);
  });

  test('o mesmo player em outra moeda abre uma segunda wallet independente', async () => {
    const playerId = `player-${randomUUID()}`;
    await openWallet().useCase.execute({ playerId, initialBalance: brl(100n) });

    await openWallet().useCase.execute({ playerId, initialBalance: Money.fromCents(100n, 'USD') });

    const state = await persistedFor(playerId);
    expect(state.wallets.map((w) => w.currency).sort()).toEqual(['BRL', 'USD']);
    expect(state.entries.map((e) => e.currency).sort()).toEqual(['BRL', 'USD']);
  });
});

describe('constraints existentes continuam valendo para a abertura', () => {
  test('o lançamento de abertura gravado é imutável (trigger)', async () => {
    const playerId = `player-${randomUUID()}`;
    const { useCase, ids } = openWallet();
    await useCase.execute({ playerId, initialBalance: brl(100n) });
    const entryId = ids.issued[2] as string;

    await expect(
      sql('update wallet_ledger_entries set money_cents = 1 where id = ?', [entryId]),
    ).rejects.toMatchObject({
      code: 'P0001',
    });
    await expect(
      sql('delete from wallet_ledger_entries where id = ?', [entryId]),
    ).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  test('uma segunda OPENING para a mesma wallet continua bloqueada pelo banco', async () => {
    const playerId = `player-${randomUUID()}`;
    const wallet = await openWallet().useCase.execute({ playerId, initialBalance: brl(100n) });

    await expect(
      sql(
        `insert into wager_transactions (id, wallet_id, player_id, kind, status, money_cents, currency,
           correlation_id, created_at)
         values (?, ?, ?, 'OPENING', 'PROCESSED', 100, 'BRL', gen_random_uuid(), now())`,
        [randomUUID(), wallet.id, playerId],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'wager_transactions_opening_once_unique',
    });
  });
});
