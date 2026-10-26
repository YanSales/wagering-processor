import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/database/orm.config';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// Aplica as migrations reais no banco de teste; recusa qualquer banco que não seja *_test.
assertTestDatabaseEnv();

let orm: MikroORM;
const sql = (query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params);

/** Exige que o PostgreSQL rejeite a operação com o SQLSTATE e, quando informado, a constraint. */
async function expectRejected(
  operation: Promise<unknown>,
  code: string,
  constraint?: string | readonly string[],
) {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const error = caught as { code?: string; constraint?: string };
  expect(error.code).toBe(code);
  // Com várias constraints violadas, o PostgreSQL relata só uma (em ordem de nome).
  if (constraint !== undefined) {
    expect(typeof constraint === 'string' ? [constraint] : constraint).toContain(
      error.constraint as string,
    );
  }
}

const PG = {
  UNIQUE: '23505',
  CHECK: '23514',
  FOREIGN_KEY: '23503',
  NOT_NULL: '23502',
  RAISE: 'P0001',
} as const;

interface WalletRow {
  id?: string;
  playerId?: string;
  currency?: string;
  balanceCents?: string;
  version?: number;
}

async function insertWallet(row: WalletRow = {}) {
  const id = row.id ?? randomUUID();
  await sql(
    'insert into wallets (id, player_id, currency, balance_cents, version, created_at, updated_at) values (?, ?, ?, ?, ?, now(), now())',
    [
      id,
      row.playerId ?? `player-${randomUUID()}`,
      row.currency ?? 'BRL',
      row.balanceCents ?? '0',
      row.version ?? 1,
    ],
  );
  return id;
}

interface TransactionRow {
  id?: string;
  walletId: string;
  kind?: string;
  status?: string;
  moneyCents?: string;
  currency?: string;
  submission?: boolean;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  /** Saldo observado; por padrão `'0'` em submissões PROCESSED/REJECTED, que o exigem. */
  resultBalanceCents?: string | null;
}

async function insertTransaction(row: TransactionRow) {
  const id = row.id ?? randomUUID();
  const kind = row.kind ?? 'BET';
  const status = row.status ?? 'PENDING';
  const submission = row.submission ?? kind !== 'OPENING';
  const ext = row.externalTransactionId ?? `ext-${id}`;
  const concluded = kind !== 'OPENING' && (status === 'PROCESSED' || status === 'REJECTED');
  // Aguardar a referência exige a próxima tentativa agendada (`pending_reference_schedule_check`).
  const nextReferenceAttemptAt = status === 'PENDING_REFERENCE' ? new Date() : null;
  await sql(
    `insert into wager_transactions (id, wallet_id, player_id, kind, status, provider_id, external_transaction_id,
       idempotency_key, payload_hash, round_id, game_id, money_cents, currency, reference_external_transaction_id,
       reference_transaction_id, failure_code, result_balance_cents, next_reference_attempt_at, correlation_id,
       created_at)
       values (?, ?, 'player-x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, gen_random_uuid(), now())`,
    [
      id,
      row.walletId,
      kind,
      status,
      submission ? (row.providerId ?? 'provider-a') : null,
      submission ? ext : null,
      submission ? (row.idempotencyKey ?? `provider-a:${ext}`) : null,
      submission ? 'hash' : null,
      submission ? 'round-1' : null,
      submission ? 'game-1' : null,
      row.moneyCents ?? '2500',
      row.currency ?? 'BRL',
      row.referenceExternalTransactionId ?? null,
      row.referenceTransactionId ?? null,
      row.failureCode ?? null,
      row.resultBalanceCents === undefined ? (concluded ? '0' : null) : row.resultBalanceCents,
      nextReferenceAttemptAt,
    ],
  );
  return id;
}

interface EntryRow {
  walletId: string;
  transactionId: string;
  currency?: string;
  direction?: string;
  moneyCents?: string;
  before?: string;
  after?: string;
}

async function insertEntry(row: EntryRow) {
  const id = randomUUID();
  await sql(
    `insert into wallet_ledger_entries (id, wallet_id, currency, transaction_id, direction, money_cents,
       balance_before_cents, balance_after_cents, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      id,
      row.walletId,
      row.currency ?? 'BRL',
      row.transactionId,
      row.direction ?? 'CREDIT',
      row.moneyCents ?? '2500',
      row.before ?? '0',
      row.after ?? '2500',
    ],
  );
  return id;
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('wallets', () => {
  test('rejeita duas wallets para o mesmo player e moeda', async () => {
    const playerId = `player-${randomUUID()}`;
    await insertWallet({ playerId });

    await expectRejected(
      insertWallet({ playerId }),
      PG.UNIQUE,
      'wallets_player_id_currency_unique',
    );
  });

  test('aceita o mesmo player em moedas diferentes (modelo multi-moeda)', async () => {
    const playerId = `player-${randomUUID()}`;
    await insertWallet({ playerId, currency: 'BRL' });

    expect(await insertWallet({ playerId, currency: 'USD' })).toBeString();
  });

  test('rejeita saldo negativo', async () => {
    await expectRejected(
      insertWallet({ balanceCents: '-1' }),
      PG.CHECK,
      'wallets_balance_cents_check',
    );
  });

  test.each([0, -1])('rejeita versão %p', async (version) => {
    await expectRejected(insertWallet({ version }), PG.CHECK, 'wallets_version_check');
  });

  test.each(['brl', 'BR', 'B1L', 'R$ '])('rejeita moeda inválida %p', async (currency) => {
    await expectRejected(insertWallet({ currency }), PG.CHECK, 'wallets_currency_check');
  });

  test('saldo bigint além de Number.MAX_SAFE_INTEGER é preservado sem perda', async () => {
    const id = await insertWallet({ balanceCents: '9007199254740993' });

    const [row] = await sql('select balance_cents::text as cents from wallets where id = ?', [id]);
    expect((row as { cents: string }).cents).toBe('9007199254740993');
  });
});

describe('wager_transactions', () => {
  test('rejeita a mesma idempotency key duas vezes', async () => {
    const walletId = await insertWallet();
    const idempotencyKey = `key-${randomUUID()}`;
    await insertTransaction({ walletId, idempotencyKey });

    await expectRejected(
      insertTransaction({ walletId, idempotencyKey }),
      PG.UNIQUE,
      'wager_transactions_idempotency_key_unique',
    );
  });

  test('rejeita (provider_id, external_transaction_id) duplicado', async () => {
    const walletId = await insertWallet();
    const externalTransactionId = `ext-${randomUUID()}`;
    await insertTransaction({
      walletId,
      externalTransactionId,
      idempotencyKey: `k1-${randomUUID()}`,
    });

    await expectRejected(
      insertTransaction({ walletId, externalTransactionId, idempotencyKey: `k2-${randomUUID()}` }),
      PG.UNIQUE,
      'wager_transactions_provider_external_unique',
    );
  });

  test('o mesmo id externo em provedores diferentes é aceito', async () => {
    const walletId = await insertWallet();
    const externalTransactionId = `ext-${randomUUID()}`;
    await insertTransaction({
      walletId,
      externalTransactionId,
      providerId: 'provider-a',
      idempotencyKey: `a-${randomUUID()}`,
    });

    expect(
      await insertTransaction({
        walletId,
        externalTransactionId,
        providerId: 'provider-b',
        idempotencyKey: `b-${randomUUID()}`,
      }),
    ).toBeString();
  });

  test.each([
    ['tipo desconhecido', { kind: 'DEPOSIT' }, 'wager_transactions_kind_check'],
    ['estado desconhecido', { status: 'DONE' }, 'wager_transactions_status_check'],
    ['valor negativo', { moneyCents: '-1' }, 'wager_transactions_money_cents_check'],
    ['moeda inválida', { currency: 'brl' }, 'wager_transactions_currency_check'],
    [
      'failureCode fora do formato',
      { failureCode: 'no funds' },
      'wager_transactions_failure_code_check',
    ],
    [
      'REFUND sem referência externa',
      { kind: 'REFUND' },
      'wager_transactions_reference_required_check',
    ],
    [
      'ROLLBACK sem referência externa',
      { kind: 'ROLLBACK' },
      'wager_transactions_reference_required_check',
    ],
  ] as const)('rejeita %s', async (_case, overrides, constraint) => {
    const walletId = await insertWallet();

    await expectRejected(insertTransaction({ walletId, ...overrides }), PG.CHECK, constraint);
  });

  test('valor zero é aceito pelo schema (a política de negócio para zero continua pendente)', async () => {
    const walletId = await insertWallet();

    expect(await insertTransaction({ walletId, moneyCents: '0' })).toBeString();
  });

  test('rejeita FK para wallet inexistente', async () => {
    await expectRejected(
      insertTransaction({ walletId: randomUUID() }),
      PG.FOREIGN_KEY,
      'wager_transactions_wallet_id_fk',
    );
  });

  test('rejeita FK para transação referenciada inexistente', async () => {
    const walletId = await insertWallet();

    await expectRejected(
      insertTransaction({
        walletId,
        kind: 'REFUND',
        referenceExternalTransactionId: 'ext-x',
        referenceTransactionId: randomUUID(),
      }),
      PG.FOREIGN_KEY,
      'wager_transactions_reference_transaction_id_fk',
    );
  });
});

describe('OPENING: transação interna sem dados externos inventados', () => {
  test('é aceita com os campos de submissão nulos', async () => {
    const walletId = await insertWallet();

    const id = await insertTransaction({ walletId, kind: 'OPENING', status: 'PROCESSED' });

    const [row] = await sql(
      'select provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id from wager_transactions where id = ?',
      [id],
    );
    expect(Object.values(row as Record<string, unknown>).every((value) => value === null)).toBe(
      true,
    );
  });

  test('várias wallets podem ter OPENING (idempotency_key nula não colide)', async () => {
    await insertTransaction({ walletId: await insertWallet(), kind: 'OPENING' });

    expect(
      await insertTransaction({ walletId: await insertWallet(), kind: 'OPENING' }),
    ).toBeString();
  });

  test('OPENING com dados de submissão é rejeitada', async () => {
    const walletId = await insertWallet();

    await expectRejected(
      insertTransaction({ walletId, kind: 'OPENING', submission: true }),
      PG.CHECK,
      'wager_transactions_submission_fields_check',
    );
  });

  test('transação externa sem dados de submissão é rejeitada', async () => {
    const walletId = await insertWallet();

    await expectRejected(
      insertTransaction({ walletId, kind: 'BET', submission: false }),
      PG.CHECK,
      'wager_transactions_submission_fields_check',
    );
  });

  test('uma segunda OPENING na mesma wallet é rejeitada', async () => {
    const walletId = await insertWallet();
    await insertTransaction({ walletId, kind: 'OPENING' });

    await expectRejected(
      insertTransaction({ walletId, kind: 'OPENING' }),
      PG.UNIQUE,
      'wager_transactions_opening_once_unique',
    );
  });

  test('o lançamento de abertura referencia a OPENING pela FK do ledger', async () => {
    const walletId = await insertWallet({ balanceCents: '100000' });
    const openingId = await insertTransaction({
      walletId,
      kind: 'OPENING',
      status: 'PROCESSED',
      moneyCents: '100000',
    });

    expect(
      await insertEntry({
        walletId,
        transactionId: openingId,
        moneyCents: '100000',
        before: '0',
        after: '100000',
      }),
    ).toBeString();
  });
});

describe('reversões: unicidade por referência e tipo (contrato §7, regra 4)', () => {
  async function processedBet() {
    const walletId = await insertWallet();
    const betId = await insertTransaction({ walletId, status: 'PROCESSED' });
    return { walletId, betId };
  }
  const reversal = (walletId: string, betId: string, kind: 'REFUND' | 'ROLLBACK') =>
    insertTransaction({
      walletId,
      kind,
      status: 'PROCESSED',
      referenceExternalTransactionId: 'ext-bet',
      referenceTransactionId: betId,
    });

  test.each(['REFUND', 'ROLLBACK'] as const)(
    'rejeita dois %s da mesma referência',
    async (kind) => {
      const { walletId, betId } = await processedBet();
      await reversal(walletId, betId, kind);

      await expectRejected(
        reversal(walletId, betId, kind),
        PG.UNIQUE,
        'wager_transactions_reversal_once_unique',
      );
    },
  );

  test('permite um REFUND e um ROLLBACK distintos da mesma referência', async () => {
    const { walletId, betId } = await processedBet();
    await reversal(walletId, betId, 'REFUND');

    expect(await reversal(walletId, betId, 'ROLLBACK')).toBeString();
  });

  test('reversões ainda sem referência resolvida não colidem', async () => {
    const walletId = await insertWallet();
    const pending = () =>
      insertTransaction({
        walletId,
        kind: 'REFUND',
        status: 'PENDING_REFERENCE',
        referenceExternalTransactionId: 'ext-bet',
      });
    await pending();

    expect(await pending()).toBeString();
  });
});

describe('wallet_ledger_entries', () => {
  async function walletWithTransaction(currency = 'BRL') {
    const walletId = await insertWallet({ currency });
    const transactionId = await insertTransaction({ walletId, status: 'PROCESSED', currency });
    return { walletId, transactionId };
  }

  test('aceita crédito e débito com a equação contábil correta', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const debitTx = await insertTransaction({ walletId, status: 'PROCESSED' });

    await insertEntry({
      walletId,
      transactionId,
      direction: 'CREDIT',
      moneyCents: '2500',
      before: '0',
      after: '2500',
    });
    expect(
      await insertEntry({
        walletId,
        transactionId: debitTx,
        direction: 'DEBIT',
        moneyCents: '2500',
        before: '2500',
        after: '0',
      }),
    ).toBeString();
  });

  // A equação contábil é mantida verdadeira para isolar a regra do valor positivo.
  test.each([
    ['0', '1000'],
    ['-100', '900'],
  ])('rejeita valor %p', async (moneyCents, after) => {
    const { walletId, transactionId } = await walletWithTransaction();

    await expectRejected(
      insertEntry({ walletId, transactionId, moneyCents, before: '1000', after }),
      PG.CHECK,
      'wallet_ledger_entries_money_cents_check',
    );
  });

  test('rejeita saldo negativo, mesmo com a equação correta', async () => {
    const { walletId, transactionId } = await walletWithTransaction();

    await expectRejected(
      insertEntry({
        walletId,
        transactionId,
        direction: 'DEBIT',
        moneyCents: '2500',
        before: '1000',
        after: '-1500',
      }),
      PG.CHECK,
      'wallet_ledger_entries_balances_check',
    );
  });

  test.each([
    ['crédito com saldo posterior errado', 'CREDIT', '1000', '3501'],
    ['débito calculado como crédito', 'DEBIT', '1000', '3500'],
    ['crédito calculado como débito', 'CREDIT', '3500', '1000'],
  ])('rejeita %s', async (_case, direction, before, after) => {
    const { walletId, transactionId } = await walletWithTransaction();

    await expectRejected(
      insertEntry({ walletId, transactionId, direction, moneyCents: '2500', before, after }),
      PG.CHECK,
      'wallet_ledger_entries_arithmetic_check',
    );
  });

  test('rejeita direção desconhecida (pela constraint de direção ou pela equação)', async () => {
    const { walletId, transactionId } = await walletWithTransaction();

    await expectRejected(insertEntry({ walletId, transactionId, direction: 'REFUND' }), PG.CHECK, [
      'wallet_ledger_entries_direction_check',
      'wallet_ledger_entries_arithmetic_check',
    ]);
  });

  test('rejeita moeda diferente da moeda da wallet (FK composta)', async () => {
    const { walletId, transactionId } = await walletWithTransaction('BRL');

    await expectRejected(
      insertEntry({ walletId, transactionId, currency: 'USD' }),
      PG.FOREIGN_KEY,
      'wallet_ledger_entries_wallet_currency_fk',
    );
  });

  test('rejeita FK para transação inexistente', async () => {
    const walletId = await insertWallet();

    await expectRejected(
      insertEntry({ walletId, transactionId: randomUUID() }),
      PG.FOREIGN_KEY,
      'wallet_ledger_entries_transaction_id_fk',
    );
  });

  test('rejeita um segundo lançamento da mesma transação na mesma wallet', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    await insertEntry({ walletId, transactionId });

    await expectRejected(
      insertEntry({ walletId, transactionId, before: '2500', after: '5000' }),
      PG.UNIQUE,
      'wallet_ledger_entries_wallet_transaction_unique',
    );
  });

  test('UPDATE e DELETE diretos no PostgreSQL são recusados pelo trigger', async () => {
    const { walletId, transactionId } = await walletWithTransaction();
    const entryId = await insertEntry({ walletId, transactionId });
    const read = () =>
      sql(
        'select money_cents::text as m, balance_after_cents::text as a from wallet_ledger_entries where id = ?',
        [entryId],
      );
    const before = await read();

    await expectRejected(
      sql('update wallet_ledger_entries set money_cents = 1 where id = ?', [entryId]),
      PG.RAISE,
    );
    await expectRejected(
      sql('update wallet_ledger_entries set created_at = now() where id = ?', [entryId]),
      PG.RAISE,
    );
    await expectRejected(
      sql('delete from wallet_ledger_entries where id = ?', [entryId]),
      PG.RAISE,
    );

    expect(await read()).toEqual(before);
    expect(before).toHaveLength(1);
  });
});

describe('saldo observado de submissões concluídas (contrato §7, regra 7)', () => {
  test.each(['PROCESSED', 'REJECTED'])('BET %s sem saldo observado é recusada', async (status) => {
    const walletId = await insertWallet();

    await expectRejected(
      insertTransaction({
        walletId,
        status,
        failureCode: status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null,
        resultBalanceCents: null,
      }),
      PG.CHECK,
      'wager_transactions_result_balance_required_check',
    );
  });

  test('BET PENDING e OPENING PROCESSED dispensam o saldo observado', async () => {
    const walletId = await insertWallet({ balanceCents: '2500' });

    await insertTransaction({ walletId, status: 'PENDING' });
    await insertTransaction({ walletId, kind: 'OPENING', status: 'PROCESSED' });
  });

  test('saldo observado negativo é recusado', async () => {
    const walletId = await insertWallet();

    await expectRejected(
      insertTransaction({ walletId, status: 'PROCESSED', resultBalanceCents: '-1' }),
      PG.CHECK,
      'wager_transactions_result_balance_check',
    );
  });
});

describe('migration e comparação de schema', () => {
  test(
    'a migration é revertida por completo e reaplicada',
    async () => {
      const objects = async () => {
        const [row] = await sql(
          `select (select count(*) from information_schema.tables where table_schema = 'public'
                     and table_name in ('wallets', 'wager_transactions', 'wallet_ledger_entries',
                                        'outbox_messages', 'inbox_messages'))::int as tables,
                  (select count(*) from pg_proc
                    where proname in ('wallet_ledger_entries_ledger_no_update_delete_fn',
                                      'outbox_messages_content_no_update_fn'))::int as functions,
                  (select count(*) from pg_trigger where not tgisinternal)::int as triggers`,
        );
        return row;
      };
      expect(await objects()).toEqual({ tables: 5, functions: 2, triggers: 2 });
      const executed = (await orm.migrator.getExecuted()).map((m) => m.name);
      expect(executed.some((name) => name.endsWith('_financial_schema'))).toBe(true);

      // Reverte todas as migrations, da mais recente à primeira, e reaplica na ordem.
      const reverted = await orm.migrator.down({ to: 0 });
      expect(reverted.map((m) => m.name)).toEqual([...executed].reverse());
      expect(await objects()).toEqual({ tables: 0, functions: 0, triggers: 0 });

      const reapplied = await orm.migrator.up();
      expect(reapplied.map((m) => m.name)).toEqual(executed);
      expect(await objects()).toEqual({ tables: 5, functions: 2, triggers: 2 });
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );

  test(
    'o schema efetivo coincide com as entidades: sem diferenças nem migrations pendentes',
    async () => {
      expect(await orm.migrator.getPending()).toEqual([]);
      expect(await orm.migrator.checkSchema()).toBe(false);
      expect(await orm.schema.getUpdateSchemaSQL({ wrap: false })).toBe('');
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );
});
