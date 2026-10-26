import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import type { WalletRepository } from '../../src/application/wallet-repository';
import type { WalletResponse } from '../../src/wallets/open-wallet.request';
import { WALLET_REPOSITORY } from '../../src/wallets/wallets.module';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// O AppModule conecta ao PostgreSQL e o endpoint grava: só roda contra o banco de teste.
assertTestDatabaseEnv();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function startApp(repository?: WalletRepository) {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (repository !== undefined) {
    builder.overrideProvider(WALLET_REPOSITORY).useValue(repository);
  }
  const app = (await builder.compile()).createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, baseUrl: await app.getUrl() };
}

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

function postWallet(body: unknown, raw = false) {
  return fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const request = (playerId: string, amount: string, currency = 'BRL') => ({
  playerId,
  initialBalance: { amount, currency },
});

/** Estado persistido das wallets de um player (wallets, transações e lançamentos). */
async function persistedFor(playerId: string) {
  const wallets = await sql<{ id: string; balance: string; version: number; currency: string }>(
    'select id, balance_cents::text as balance, version, currency from wallets where player_id = ?',
    [playerId],
  );
  const transactions = await sql<{ id: string; kind: string; status: string; money: string }>(
    `select t.id, t.kind, t.status, t.money_cents::text as money
       from wager_transactions t join wallets w on w.id = t.wallet_id where w.player_id = ?`,
    [playerId],
  );
  const entries = await sql<{ transaction_id: string; direction: string; after: string }>(
    `select e.transaction_id, e.direction, e.balance_after_cents::text as after
       from wallet_ledger_entries e join wallets w on w.id = e.wallet_id where w.player_id = ?`,
    [playerId],
  );
  return { wallets, transactions, entries };
}

beforeAll(async () => {
  ({ app, baseUrl } = await startApp());
  // O mesmo ORM que o AppModule usa (DatabaseModule); as migrations reais são aplicadas antes.
  orm = app.get(MikroORM);
  await orm.migrator.up();
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('POST /wallets (HTTP + PostgreSQL)', () => {
  test('saldo inicial zero: 201 com a wallet e só a wallet persistida', async () => {
    const playerId = `player-${randomUUID()}`;

    const response = await postWallet(request(playerId, '0.00'));

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as WalletResponse;
    expect(body).toEqual({
      id: expect.stringMatching(UUID),
      playerId,
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });
    expect(await persistedFor(playerId)).toEqual({
      wallets: [{ id: body.id, balance: '0', version: 1, currency: 'BRL' }],
      transactions: [],
      entries: [],
    });
  });

  test('saldo inicial positivo: 201 e wallet, OPENING processada e CREDIT persistidos', async () => {
    const playerId = `player-${randomUUID()}`;

    const response = await postWallet(request(playerId, '1000.00'));

    expect(response.status).toBe(201);
    const body = (await response.json()) as WalletResponse;
    expect(body).toEqual({
      id: expect.stringMatching(UUID),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const state = await persistedFor(playerId);
    expect(state.wallets).toEqual([
      { id: body.id, balance: '100000', version: 1, currency: 'BRL' },
    ]);
    expect(state.transactions).toEqual([
      { id: expect.stringMatching(UUID), kind: 'OPENING', status: 'PROCESSED', money: '100000' },
    ]);
    expect(state.entries).toEqual([
      { transaction_id: state.transactions[0]?.id as string, direction: 'CREDIT', after: '100000' },
    ]);
  });

  test('valor acima de Number.MAX_SAFE_INTEGER centavos: string exata na resposta e no banco', async () => {
    const playerId = `player-${randomUUID()}`;

    const response = await postWallet(request(playerId, '90071992547409.93'));

    expect(response.status).toBe(201);
    // Lido como texto: o JSON nunca carrega o valor como number.
    expect(await response.text()).toContain(
      '"balance":{"amount":"90071992547409.93","currency":"BRL"}',
    );
    const state = await persistedFor(playerId);
    expect(state.wallets[0]?.balance).toBe('9007199254740993');
    expect(state.entries[0]?.after).toBe('9007199254740993');
  });

  // Fronteira do armazenamento: `bigint` do PostgreSQL vai até 9223372036854775807 centavos.
  test('maior saldo armazenável (92233720368547758.07): 201, gravado sem perda', async () => {
    const playerId = `player-${randomUUID()}`;

    const response = await postWallet(request(playerId, '92233720368547758.07'));

    expect(response.status).toBe(201);
    expect(await response.text()).toContain(
      '"balance":{"amount":"92233720368547758.07","currency":"BRL"}',
    );
    const state = await persistedFor(playerId);
    expect(state.wallets[0]?.balance).toBe('9223372036854775807');
    expect(state.transactions[0]?.money).toBe('9223372036854775807');
    expect(state.entries[0]?.after).toBe('9223372036854775807');
  });

  test.each([
    ['um centavo acima do máximo', '92233720368547758.08'],
    ['muito acima do máximo', `${'9'.repeat(40)}.00`],
  ])(
    'saldo fora da faixa armazenável (%s): 400 de entrada, sem persistir',
    async (_case, amount) => {
      const playerId = `player-${randomUUID()}`;

      const response = await postWallet(request(playerId, amount));

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        statusCode: number;
        error: string;
        message: string;
      };
      expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(body.message).toContain('92233720368547758.07');
      expect(await persistedFor(playerId)).toEqual({ wallets: [], transactions: [], entries: [] });
    },
  );

  test.each([
    ['saldo negativo', (p: string) => request(p, '-1.00')],
    ['moeda minúscula', (p: string) => request(p, '1.00', 'brl')],
    ['moeda inválida', (p: string) => request(p, '1.00', 'REAL')],
    [
      'amount numérico',
      (p: string) => ({ playerId: p, initialBalance: { amount: 1, currency: 'BRL' } }),
    ],
    ['mais de 2 casas', (p: string) => request(p, '1.001')],
    ['notação científica', (p: string) => request(p, '1e3')],
    ['sem initialBalance', (p: string) => ({ playerId: p })],
  ])('payload inválido (%s): 400 sem persistir', async (_case, build) => {
    const playerId = `player-${randomUUID()}`;

    const response = await postWallet(build(playerId));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect((await persistedFor(playerId)).wallets).toEqual([]);
  });

  test.each([
    ['sem playerId', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['playerId vazio', request('  ', '1.00')],
    ['playerId com NUL', request('player\u0000x', '1.00')],
    ['corpo array', [request('player-x', '1.00')]],
  ])('payload inválido (%s): 400', async (_case, body) => {
    const response = await postWallet(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ statusCode: 400, error: 'Bad Request' });
  });

  test('JSON malformado: 400', async () => {
    const response = await postWallet('{"playerId": ', true);

    expect(response.status).toBe(400);
  });

  test('wallet duplicada para o mesmo player e moeda: 409, sem registros parciais', async () => {
    const playerId = `player-${randomUUID()}`;
    expect((await postWallet(request(playerId, '100.00'))).status).toBe(201);
    const before = await persistedFor(playerId);

    const response = await postWallet(request(playerId, '7.00'));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ statusCode: 409, error: 'Conflict' });
    expect(await persistedFor(playerId)).toEqual(before);
  });

  test('o mesmo player em outra moeda: 201', async () => {
    const playerId = `player-${randomUUID()}`;
    expect((await postWallet(request(playerId, '1.00'))).status).toBe(201);

    const response = await postWallet(request(playerId, '1.00', 'USD'));

    expect(response.status).toBe(201);
    expect(((await response.json()) as { balance: unknown }).balance).toEqual({
      amount: '1.00',
      currency: 'USD',
    });
  });

  test('duas requisições simultâneas para o mesmo player e moeda: um 201 e um 409', async () => {
    const playerId = `player-${randomUUID()}`;

    const responses = await Promise.all([
      postWallet(request(playerId, '10.00')),
      postWallet(request(playerId, '10.00')),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const state = await persistedFor(playerId);
    expect([state.wallets.length, state.transactions.length, state.entries.length]).toEqual([
      1, 1, 1,
    ]);
  });
});

describe('POST /wallets com falha inesperada da persistência', () => {
  let failing: { app: INestApplication; baseUrl: string };

  beforeAll(async () => {
    failing = await startApp({
      insertOpened: async () => {
        throw new Error('falha inesperada de infraestrutura');
      },
    });
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    await failing?.app.close();
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  test('responde 500 genérico: não é mascarada como 400 ou 409 nem expõe a mensagem', async () => {
    const response = await fetch(`${failing.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request(`player-${randomUUID()}`, '1.00')),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
  });
});
