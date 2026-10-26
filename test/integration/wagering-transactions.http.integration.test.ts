import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import {
  TransientPersistenceError,
  type WagerTransactionRepository,
} from '../../src/application/wager-transaction-repository';
import {
  type PendingReferenceSettings,
  readPendingReferenceSettings,
} from '../../src/wagering/pending-reference.config';
import {
  PENDING_REFERENCE_SETTINGS,
  WAGER_TRANSACTION_REPOSITORY,
} from '../../src/wagering/wagering.module';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// O AppModule conecta ao PostgreSQL e o endpoint grava: só roda contra o banco de teste.
assertTestDatabaseEnv();

interface Wallet {
  id: string;
  playerId: string;
}

/**
 * Worker de `PENDING_REFERENCE` desligado por padrão: as pendências só mudam quando o teste quer. O
 * teste do agendamento liga o worker com intervalos curtos.
 */
async function startApp(
  repository?: WagerTransactionRepository,
  pendingReference: Partial<PendingReferenceSettings> = { enabled: false },
) {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (repository !== undefined) {
    builder.overrideProvider(WAGER_TRANSACTION_REPOSITORY).useValue(repository);
  }
  builder
    .overrideProvider(PENDING_REFERENCE_SETTINGS)
    .useValue({ ...readPendingReferenceSettings({}), ...pendingReference });
  const app = (await builder.compile()).createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, baseUrl: await app.getUrl() };
}

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

async function openWallet(amount: string, currency = 'BRL'): Promise<Wallet> {
  const playerId = `player-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
  });
  expect(response.status).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, playerId };
}

/** Corpo do contrato §9 para uma BET na wallet. Cada chamada é uma operação externa nova. */
function betBody(wallet: Wallet, amount: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

/** Chave recomendada pelo contrato: `{providerId}:{externalTransactionId}`. */
const keyOf = (body: { providerId: string; externalTransactionId: string }) =>
  `${body.providerId}:${body.externalTransactionId}`;

function submit(body: unknown, key: string | undefined, target = baseUrl) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== undefined) headers['idempotency-key'] = key;
  return fetch(`${target}/wagering/transactions`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/** Saldo, versão, débitos e transações gravadas de uma wallet. */
async function walletState(walletId: string) {
  const [row] = await sql<{ balance: string; version: number; rebuilt: string; debits: number }>(
    `select w.balance_cents::text as balance, w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)::text as rebuilt,
            (count(*) filter (where e.direction = 'DEBIT'))::int as debits
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  if (row === undefined) throw new Error(`wallet ${walletId} não existe.`);
  const [bets] = await sql<{ count: number }>(
    "select count(*)::int as count from wager_transactions where wallet_id = ? and kind = 'BET'",
    [walletId],
  );
  return { ...row, bets: bets?.count ?? 0 };
}

async function transactionsWithKey(key: string) {
  return sql<{ id: string; status: string; result_balance: string }>(
    'select id, status, result_balance_cents::text as result_balance from wager_transactions where idempotency_key = ?',
    [key],
  );
}

beforeAll(async () => {
  ({ app, baseUrl } = await startApp());
  orm = app.get(MikroORM);
  await orm.migrator.up();
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('POST /wagering/transactions: BET', () => {
  test('BET válida: 200, corpo do contrato, saldo, ledger e resultado gravados', async () => {
    const wallet = await openWallet('100.00');
    const body = betBody(wallet, '80.00');

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const result = await json(response);
    expect(result).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSED',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletState(wallet.id)).toMatchObject({
      balance: '2000',
      version: 2,
      rebuilt: '2000',
      debits: 1,
    });
    expect(await transactionsWithKey(keyOf(body))).toEqual([
      { id: result.transactionId as string, status: 'PROCESSED', result_balance: '2000' },
    ]);
  });

  test('saldo insuficiente: 422 com o resultado REJECTED gravado, sem débito', async () => {
    const wallet = await openWallet('100.00');
    const body = betBody(wallet, '100.01');

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(422);
    expect(await json(response)).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '10000', version: 1, debits: 0 });
    expect((await transactionsWithKey(keyOf(body)))[0]?.status).toBe('REJECTED');
  });

  test.each([
    ['moeda incompatível', { money: { amount: '1.00', currency: 'USD' } }, 'CURRENCY_MISMATCH'],
    ['wallet de outro player', { playerId: 'outro-player' }, 'PLAYER_WALLET_MISMATCH'],
  ])('%s: 422 REJECTED com failureCode próprio', async (_case, overrides, failureCode) => {
    const wallet = await openWallet('100.00');
    const body = betBody(wallet, '1.00', overrides);

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ status: 'REJECTED', failureCode });
    expect((await walletState(wallet.id)).debits).toBe(0);
  });
});

describe('POST /wagering/transactions: WIN sem referência', () => {
  test('WIN válido: 200, crédito, CREDIT e resultado gravados', async () => {
    const wallet = await openWallet('20.00');
    const body = betBody(wallet, '50.00', { kind: 'WIN' });

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSED',
      balance: { amount: '70.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const [credits] = await sql<{ count: number }>(
      `select count(*)::int as count from wallet_ledger_entries
        where wallet_id = ? and direction = 'CREDIT'`,
      [wallet.id],
    );
    expect(credits?.count).toBe(2); // OPENING e WIN
    expect(await walletState(wallet.id)).toMatchObject({ balance: '7000', rebuilt: '7000' });
  });

  test('replay: mesmo status e corpo, sem novo crédito; outro payload na chave: 409', async () => {
    const wallet = await openWallet('0.00');
    const body = betBody(wallet, '12.34', { kind: 'WIN' });
    const first = await json(await submit(body, keyOf(body)));

    const replay = await submit(body, keyOf(body));
    const conflict = await submit(
      { ...body, money: { amount: '12.35', currency: 'BRL' } },
      keyOf(body),
    );

    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual({ ...first, idempotentReplay: true });
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '1234', bets: 0 });
  });

  test('moeda incompatível: 422 REJECTED com CURRENCY_MISMATCH, sem crédito', async () => {
    const wallet = await openWallet('20.00');
    const body = betBody(wallet, '1.00', {
      kind: 'WIN',
      money: { amount: '1.00', currency: 'USD' },
    });

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      balance: { amount: '20.00', currency: 'BRL' },
    });
    expect((await walletState(wallet.id)).balance).toBe('2000');
  });

  test('BET e WIN simultâneos na mesma wallet: resultado consistente com o ledger', async () => {
    const wallet = await openWallet('10.00');
    const bet = betBody(wallet, '30.00');
    const win = betBody(wallet, '30.00', { kind: 'WIN' });

    const [betResponse, winResponse] = await Promise.all([
      submit(bet, keyOf(bet)),
      submit(win, keyOf(win)),
    ]);

    expect(winResponse.status).toBe(200);
    // A BET passa só se for serializada depois do WIN; em qualquer ordem o saldo bate com o ledger.
    const betApplied = betResponse.status === 200;
    expect([200, 422]).toContain(betResponse.status);
    expect(await walletState(wallet.id)).toMatchObject({
      balance: betApplied ? '1000' : '4000',
      rebuilt: betApplied ? '1000' : '4000',
      debits: betApplied ? 1 : 0,
    });
  });
});

describe('POST /wagering/transactions: LOSS sem referência', () => {
  test('LOSS válido: 200 PROCESSED, saldo inalterado e nenhum lançamento', async () => {
    const wallet = await openWallet('20.00');
    const body = betBody(wallet, '50.00', { kind: 'LOSS' });

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(200);
    const result = await json(response);
    expect(result).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSED',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletState(wallet.id)).toMatchObject({
      balance: '2000',
      version: 1,
      rebuilt: '2000',
      debits: 0,
    });
    const [entries] = await sql<{ count: number }>(
      'select count(*)::int as count from wallet_ledger_entries where transaction_id = ?',
      [result.transactionId],
    );
    expect(entries?.count).toBe(0);
  });

  test('LOSS de valor zero: 200 PROCESSED', async () => {
    const wallet = await openWallet('20.00');
    const body = betBody(wallet, '0.00', { kind: 'LOSS' });

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ status: 'PROCESSED' });
  });

  test('replay: mesmo status e corpo; outro payload na chave: 409', async () => {
    const wallet = await openWallet('20.00');
    const body = betBody(wallet, '5.00', { kind: 'LOSS' });
    const first = await json(await submit(body, keyOf(body)));

    const replay = await submit(body, keyOf(body));
    const conflict = await submit(
      { ...body, money: { amount: '5.01', currency: 'BRL' } },
      keyOf(body),
    );

    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual({ ...first, idempotentReplay: true });
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
  });

  test('moeda incompatível: 422 REJECTED com CURRENCY_MISMATCH', async () => {
    const wallet = await openWallet('20.00');
    const body = betBody(wallet, '1.00', {
      kind: 'LOSS',
      money: { amount: '1.00', currency: 'USD' },
    });

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      balance: { amount: '20.00', currency: 'BRL' },
    });
  });
});

describe('POST /wagering/transactions: idempotência', () => {
  test('mesma chave e mesmo payload: mesmo status e corpo, com idempotentReplay e sem novo débito', async () => {
    const wallet = await openWallet('100.00');
    const body = betBody(wallet, '25.00');
    const first = await json(await submit(body, keyOf(body)));
    // O saldo muda depois; o replay devolve o saldo observado na primeira (§7, regra 7).
    const other = betBody(wallet, '10.00');
    await submit(other, keyOf(other));

    // Mesmo payload, com as chaves em outra ordem.
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    const replay = await submit(reordered, keyOf(body));

    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual({ ...first, idempotentReplay: true });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '6500', debits: 2 });
  });

  test('replay de uma rejeição: 422 com o mesmo resultado', async () => {
    const wallet = await openWallet('10.00');
    const body = betBody(wallet, '80.00');
    const first = await json(await submit(body, keyOf(body)));

    const replay = await submit(body, keyOf(body));

    expect(replay.status).toBe(422);
    expect(await json(replay)).toEqual({ ...first, idempotentReplay: true });
  });

  test('mesma chave com payload diferente: 409 IDEMPOTENCY_KEY_CONFLICT, sem novo efeito', async () => {
    const wallet = await openWallet('100.00');
    const body = betBody(wallet, '25.00');
    await submit(body, keyOf(body));

    const response = await submit(
      { ...body, money: { amount: '26.00', currency: 'BRL' } },
      keyOf(body),
    );

    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '7500', debits: 1, bets: 1 });
  });

  test('mesma operação externa com outra chave: 409 DUPLICATE_EXTERNAL_TRANSACTION, sem novo efeito', async () => {
    const wallet = await openWallet('100.00');
    const body = betBody(wallet, '25.00');
    await submit(body, keyOf(body));

    const response = await submit(body, `${keyOf(body)}:retry`);

    expect(response.status).toBe(409);
    const error = await json(response);
    expect(error).toMatchObject({ code: 'DUPLICATE_EXTERNAL_TRANSACTION' });
    expect(JSON.stringify(error)).not.toContain(keyOf(body));
    expect(await walletState(wallet.id)).toMatchObject({ balance: '7500', debits: 1, bets: 1 });
  });

  test('duas requisições equivalentes simultâneas: um débito; a outra é replay', async () => {
    const wallet = await openWallet('100.00');
    const body = betBody(wallet, '25.00');

    const responses = await Promise.all([submit(body, keyOf(body)), submit(body, keyOf(body))]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map(json));
    expect(results.map((r) => r.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0]?.transactionId).toBe(results[1]?.transactionId);
    expect(await walletState(wallet.id)).toMatchObject({ balance: '7500', debits: 1, bets: 1 });
  });

  test(
    'replay após reiniciar a aplicação: o resultado vem do banco',
    async () => {
      const wallet = await openWallet('100.00');
      const body = betBody(wallet, '25.00');
      const first = await json(await submit(body, keyOf(body)));

      const restarted = await startApp();
      let replay: Record<string, unknown>;
      try {
        replay = await json(await submit(body, keyOf(body), restarted.baseUrl));
      } finally {
        await restarted.app.close();
      }

      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect((await walletState(wallet.id)).debits).toBe(1);
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );
});

describe('POST /wagering/transactions: concorrência', () => {
  test('cenário obrigatório: duas BETs de 80.00 simultâneas sobre 100.00 → 200 e 422', async () => {
    const wallet = await openWallet('100.00');
    const bodies = [betBody(wallet, '80.00'), betBody(wallet, '80.00')];

    const responses = await Promise.all(bodies.map((b) => submit(b, keyOf(b))));

    expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
    const results = await Promise.all(responses.map(json));
    expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(results.map((r) => r.balance)).toEqual([
      { amount: '20.00', currency: 'BRL' },
      { amount: '20.00', currency: 'BRL' },
    ]);
    expect(await walletState(wallet.id)).toMatchObject({
      balance: '2000',
      version: 2,
      rebuilt: '2000',
      debits: 1,
      bets: 2,
    });

    // Reentrega das duas requisições: replays, nenhum débito novo.
    const again = await Promise.all(bodies.map((b) => submit(b, keyOf(b))));
    expect(again.map((r) => r.status).sort()).toEqual([200, 422]);
    expect((await Promise.all(again.map(json))).every((r) => r.idempotentReplay)).toBe(true);
    expect((await walletState(wallet.id)).debits).toBe(1);
  });

  test('dez BETs simultâneas de 30.00 sobre 100.00: três aplicadas, saldo nunca negativo', async () => {
    const wallet = await openWallet('100.00');
    const bodies = Array.from({ length: 10 }, () => betBody(wallet, '30.00'));

    const responses = await Promise.all(bodies.map((b) => submit(b, keyOf(b))));

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 422)).toHaveLength(7);
    expect(await walletState(wallet.id)).toMatchObject({
      balance: '1000',
      version: 4,
      rebuilt: '1000',
      debits: 3,
    });
    const [lowest] = await sql<{ min: string }>(
      'select min(balance_after_cents)::text as min from wallet_ledger_entries where wallet_id = ?',
      [wallet.id],
    );
    expect(BigInt(lowest?.min ?? '-1') >= 0n).toBe(true);
  });
});

describe('POST /wagering/transactions: requisições recusadas sem efeito', () => {
  let wallet: Wallet;

  beforeAll(async () => {
    wallet = await openWallet('100.00');
  });

  const cases: [string, (w: Wallet) => { body: unknown; key: string | undefined }][] = [
    ['sem Idempotency-Key', (w) => ({ body: betBody(w, '1.00'), key: undefined })],
    ['Idempotency-Key vazia', (w) => ({ body: betBody(w, '1.00'), key: ' ' })],
    [
      'campo obrigatório ausente',
      (w) => ({ body: { ...betBody(w, '1.00'), roundId: undefined }, key: 'k' }),
    ],
    [
      'walletId que não é UUID',
      (w) => ({ body: betBody(w, '1.00', { walletId: 'wallet-1' }), key: 'k' }),
    ],
    [
      'amount numérico',
      (w) => ({ body: betBody(w, '1.00', { money: { amount: 1, currency: 'BRL' } }), key: 'k' }),
    ],
    ['amount com 3 casas', (w) => ({ body: betBody(w, '1.005'), key: 'k' })],
    ['amount em notação científica', (w) => ({ body: betBody(w, '1e3'), key: 'k' })],
    ['amount negativo', (w) => ({ body: betBody(w, '-1.00'), key: 'k' })],
    [
      'moeda inválida',
      (w) => ({
        body: betBody(w, '1.00', { money: { amount: '1.00', currency: 'brl' } }),
        key: 'k',
      }),
    ],
    ['kind OPENING', (w) => ({ body: betBody(w, '1.00', { kind: 'OPENING' }), key: 'k' })],
    ['kind desconhecido', (w) => ({ body: betBody(w, '1.00', { kind: 'JACKPOT' }), key: 'k' })],
    [
      'valor acima do limite do bigint',
      (w) => ({ body: betBody(w, '92233720368547758.08'), key: 'k' }),
    ],
  ];

  test.each(cases)('%s: 400 INVALID_REQUEST', async (_case, build) => {
    const { body, key } = build(wallet);
    const uniqueKey = key === 'k' ? `k-${randomUUID()}` : key;

    const response = await submit(body, uniqueKey);

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' });
    if (uniqueKey !== undefined) expect(await transactionsWithKey(uniqueKey)).toEqual([]);
  });

  test('JSON malformado: 400', async () => {
    expect((await submit('{"kind": ', 'k-malformed')).status).toBe(400);
  });

  test.each([
    ['WIN com referência', { kind: 'WIN', referenceExternalTransactionId: 'tx-0' }],
    ['WIN de valor zero', { kind: 'WIN', money: { amount: '0.00', currency: 'BRL' } }],
    ['LOSS com referência', { kind: 'LOSS', referenceExternalTransactionId: 'tx-0' }],
    [
      'REFUND de valor zero',
      {
        kind: 'REFUND',
        referenceExternalTransactionId: 'tx-0',
        money: { amount: '0.00', currency: 'BRL' },
      },
    ],
    [
      'ROLLBACK de valor zero',
      {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'tx-0',
        money: { amount: '0.00', currency: 'BRL' },
      },
    ],
    ['BET de valor zero', { money: { amount: '0.00', currency: 'BRL' } }],
    ['BET com referência', { referenceExternalTransactionId: 'tx-0' }],
  ])('%s: 501 UNSUPPORTED_SUBMISSION, nada gravado', async (_case, overrides) => {
    const body = betBody(wallet, '1.00', overrides);

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(501);
    expect(await json(response)).toMatchObject({ statusCode: 501, code: 'UNSUPPORTED_SUBMISSION' });
    expect(await transactionsWithKey(keyOf(body))).toEqual([]);
  });

  test('wallet inexistente: 404 WALLET_NOT_FOUND, nada gravado', async () => {
    const body = betBody({ id: randomUUID(), playerId: 'player-x' }, '1.00');

    const response = await submit(body, keyOf(body));

    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({ code: 'WALLET_NOT_FOUND' });
    expect(await transactionsWithKey(keyOf(body))).toEqual([]);
  });

  test('o saldo da wallet usada nos casos recusados não mudou', async () => {
    expect(await walletState(wallet.id)).toMatchObject({ balance: '10000', version: 1, bets: 0 });
  });
});

describe('POST /wagering/transactions: falhas da persistência', () => {
  const leak = 'insert into "wager_transactions" ... password=segredo host=10.0.0.5';
  let unexpected: { app: INestApplication; baseUrl: string };
  let transient: { app: INestApplication; baseUrl: string };

  beforeAll(async () => {
    const failing = (error: Error): WagerTransactionRepository => ({
      findExisting: async () => {
        throw error;
      },
      applyToLockedWallet: async () => {
        throw error;
      },
    });
    unexpected = await startApp(failing(new Error(leak)));
    transient = await startApp(failing(new TransientPersistenceError({ cause: new Error(leak) })));
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    await unexpected?.app.close();
    await transient?.app.close();
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  test('erro inesperado: 500 genérico, sem SQL nem credenciais', async () => {
    const body = betBody({ id: randomUUID(), playerId: 'p' }, '1.00');

    const response = await submit(body, keyOf(body), unexpected.baseUrl);

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(text).not.toContain('segredo');
  });

  test('falha transitória: 503 TRANSIENT_FAILURE, sem a causa', async () => {
    const body = betBody({ id: randomUUID(), playerId: 'p' }, '1.00');

    const response = await submit(body, keyOf(body), transient.baseUrl);

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ statusCode: 503, code: 'TRANSIENT_FAILURE' });
    expect(text).not.toContain('segredo');
    expect(text).not.toContain('insert into');
  });
});

describe('POST /wagering/transactions: REFUND e PENDING_REFERENCE', () => {
  /** REFUND da BET `bet`: mesma rodada, valor e player, operação externa nova. */
  function refundBody(wallet: Wallet, bet: { externalTransactionId: string }, amount: string) {
    return betBody(wallet, amount, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
  }

  async function refundState(key: string) {
    const [row] = await sql<{
      status: string;
      failure_code: string | null;
      attempts: number;
      scheduled: boolean;
      reference_id: string | null;
      entries: number;
    }>(
      `select t.status, t.failure_code, t.reference_attempts as attempts,
              t.next_reference_attempt_at is not null as scheduled,
              t.reference_transaction_id as reference_id,
              (select count(*) from wallet_ledger_entries e where e.transaction_id = t.id)::int as entries
         from wager_transactions t where t.idempotency_key = ?`,
      [key],
    );
    return row;
  }

  test('REFUND antes da BET: 202 PENDING_REFERENCE, sem crédito nem lançamento; reenvio 202', async () => {
    const wallet = await openWallet('100.00');
    const bet = betBody(wallet, '30.00');
    const refund = refundBody(wallet, bet, '30.00');

    const response = await submit(refund, keyOf(refund));

    expect(response.status).toBe(202);
    expect(await json(response)).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await refundState(keyOf(refund))).toEqual({
      status: 'PENDING_REFERENCE',
      failure_code: null,
      attempts: 0,
      scheduled: true,
      reference_id: null,
      entries: 0,
    });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '10000', version: 1 });

    const replay = await submit(refund, keyOf(refund));
    expect(replay.status).toBe(202);
    expect(await json(replay)).toMatchObject({
      status: 'PENDING_REFERENCE',
      idempotentReplay: true,
    });
  });

  test('REFUND depois da BET: 200 PROCESSED, crédito com um lançamento e referência gravada', async () => {
    const wallet = await openWallet('100.00');
    const bet = betBody(wallet, '30.00');
    expect((await submit(bet, keyOf(bet))).status).toBe(200);
    const refund = refundBody(wallet, bet, '30.00');

    const response = await submit(refund, keyOf(refund));

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    const [betRow] = await transactionsWithKey(keyOf(bet));
    expect(await refundState(keyOf(refund))).toMatchObject({
      status: 'PROCESSED',
      reference_id: betRow?.id,
      scheduled: false,
      entries: 1,
    });
    expect(await walletState(wallet.id)).toMatchObject({
      balance: '10000',
      rebuilt: '10000',
      version: 3,
    });
  });

  test.each([
    ['outra rodada', { roundId: 'round-outro' }, '30.00', 'REFERENCE_MISMATCH'],
    ['valor diferente', {}, '29.99', 'REFERENCE_AMOUNT_MISMATCH'],
  ])(
    'referência existente e incompatível (%s): 422 imediato, sem lançamento',
    async (_case, overrides, amount, code) => {
      const wallet = await openWallet('100.00');
      const bet = betBody(wallet, '30.00');
      expect((await submit(bet, keyOf(bet))).status).toBe(200);
      const refund = { ...refundBody(wallet, bet, amount), ...overrides };

      const response = await submit(refund, keyOf(refund));

      expect(response.status).toBe(422);
      expect(await json(response)).toMatchObject({ status: 'REJECTED', failureCode: code });
      expect(await refundState(keyOf(refund))).toMatchObject({ entries: 0, scheduled: false });
      expect(await walletState(wallet.id)).toMatchObject({ balance: '7000', version: 2 });
    },
  );

  test('segundo REFUND da mesma BET: 422 REFERENCE_ALREADY_REVERSED, um único crédito', async () => {
    const wallet = await openWallet('100.00');
    const bet = betBody(wallet, '30.00');
    expect((await submit(bet, keyOf(bet))).status).toBe(200);
    const first = refundBody(wallet, bet, '30.00');
    const second = refundBody(wallet, bet, '30.00');

    expect((await submit(first, keyOf(first))).status).toBe(200);
    const response = await submit(second, keyOf(second));

    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '10000', version: 3 });
  });

  test(
    'worker agendado da aplicação resolve a pendência sozinho; o reenvio passa a 200',
    async () => {
      const withWorker = await startApp(undefined, {
        enabled: true,
        pollIntervalMs: 20,
        retry: { maxAttempts: 10, baseDelayMs: 10, maxDelayMs: 50 },
      });
      try {
        const wallet = await openWallet('100.00');
        const bet = betBody(wallet, '30.00');
        const refund = refundBody(wallet, bet, '30.00');
        expect((await submit(refund, keyOf(refund), withWorker.baseUrl)).status).toBe(202);
        expect((await submit(bet, keyOf(bet), withWorker.baseUrl)).status).toBe(200);

        let state = await refundState(keyOf(refund));
        for (let i = 0; i < 250 && state?.status === 'PENDING_REFERENCE'; i++) {
          await Bun.sleep(20);
          state = await refundState(keyOf(refund));
        }

        expect(state).toMatchObject({ status: 'PROCESSED', entries: 1, scheduled: false });
        const replay = await submit(refund, keyOf(refund), withWorker.baseUrl);
        expect(replay.status).toBe(200);
        expect(await json(replay)).toMatchObject({
          status: 'PROCESSED',
          balance: { amount: '100.00', currency: 'BRL' },
          idempotentReplay: true,
        });
        expect(await walletState(wallet.id)).toMatchObject({ balance: '10000', rebuilt: '10000' });
      } finally {
        await withWorker.app.close();
      }
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );
});

describe('autenticação: estado atual', () => {
  test('a rota passa pelo AuthGuard global, que ainda aceita tudo (sem credenciais → processada)', async () => {
    const wallet = await openWallet('10.00');
    const body = betBody(wallet, '1.00');

    expect((await submit(body, keyOf(body))).status).toBe(200);
  });
});
