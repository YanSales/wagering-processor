import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// O AppModule conecta ao PostgreSQL e os endpoints gravam: só roda contra o banco de teste.
assertTestDatabaseEnv();

let app: INestApplication;
let baseUrl: string;
let orm: MikroORM;

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const get = (path: string) => fetch(`${baseUrl}${path}`);

async function openWallet(amount: string) {
  const playerId = `player-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  return { id: ((await response.json()) as { id: string }).id, playerId };
}

async function bet(wallet: { id: string; playerId: string }, amount: string) {
  const body = {
    providerId: 'provider-q',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': body.externalTransactionId },
    body: JSON.stringify(body),
  });
  return { body, result: await json(response) };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  orm = app.get(MikroORM);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('GET /wallets/:walletId', () => {
  test('200 com saldo e versão atuais', async () => {
    const wallet = await openWallet('100.00');
    await bet(wallet, '25.00');

    const response = await get(`/wallets/${wallet.id}`);

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: '75.00', currency: 'BRL' },
      version: 2,
    });
  });

  test('404 WALLET_NOT_FOUND e 400 INVALID_REQUEST', async () => {
    const missing = await get(`/wallets/${randomUUID()}`);
    const invalid = await get('/wallets/nao-e-uuid');

    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ statusCode: 404, code: 'WALLET_NOT_FOUND' });
    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('paginação por cursor: todas as entradas, em ordem, sem repetir', async () => {
    const wallet = await openWallet('100.00');
    for (const amount of ['1.00', '2.00', '3.00', '4.00']) await bet(wallet, amount);

    const pages: Record<string, unknown>[][] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const response = await get(`/wallets/${wallet.id}/ledger${query}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: Record<string, unknown>[];
        nextCursor: string | null;
      };
      pages.push(page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);

    const items = pages.flat();
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(items.map((i) => (i.money as { amount: string }).amount)).toEqual([
      '100.00',
      '1.00',
      '2.00',
      '3.00',
      '4.00',
    ]);
    expect(items[0]).toMatchObject({
      direction: 'CREDIT',
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
    });
    expect(items.at(-1)).toMatchObject({
      direction: 'DEBIT',
      balanceAfter: { amount: '90.00', currency: 'BRL' },
    });
    expect(new Set(items.map((i) => i.id)).size).toBe(5);
  });

  test('limit e cursor inválidos: 400; wallet inexistente: 404', async () => {
    const wallet = await openWallet('10.00');
    for (const query of ['?limit=0', '?limit=201', '?limit=abc', '?cursor=xyz']) {
      const response = await get(`/wallets/${wallet.id}/ledger${query}`);
      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    // Cursor bem formado, mas de outra wallet.
    const other = await openWallet('10.00');
    const [entry] = (
      (await (await get(`/wallets/${other.id}/ledger`)).json()) as { items: { id: string }[] }
    ).items;
    const foreign = Buffer.from(entry?.id as string).toString('base64url');
    expect((await get(`/wallets/${wallet.id}/ledger?cursor=${foreign}`)).status).toBe(400);
    expect((await get(`/wallets/${randomUUID()}/ledger`)).status).toBe(404);
  });
});

describe('consultas de transação', () => {
  test('pelo id interno e pelo id do provedor: a mesma transação', async () => {
    const wallet = await openWallet('100.00');
    const { body, result } = await bet(wallet, '30.00');

    const byId = await get(`/wagering/transactions/${result.transactionId}`);
    const byExternal = await get(
      `/providers/provider-q/wagering/transactions/${body.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    const view = await json(byId);
    expect(view).toMatchObject({
      transactionId: result.transactionId,
      walletId: wallet.id,
      kind: 'BET',
      status: 'PROCESSED',
      providerId: 'provider-q',
      externalTransactionId: body.externalTransactionId,
      money: { amount: '30.00', currency: 'BRL' },
      balance: { amount: '70.00', currency: 'BRL' },
      failureCode: null,
      referenceTransactionId: null,
    });
    expect(await json(byExternal)).toEqual(view);
  });

  test('404 TRANSACTION_NOT_FOUND e 400 para id que não é UUID', async () => {
    const missing = await get(`/wagering/transactions/${randomUUID()}`);
    const external = await get('/providers/provider-q/wagering/transactions/nao-existe');
    const invalid = await get('/wagering/transactions/123');

    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
    expect(external.status).toBe(404);
    expect(invalid.status).toBe(400);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistente: saldo armazenado igual ao reconstruído pelo ledger', async () => {
    const wallet = await openWallet('100.00');
    await bet(wallet, '12.34');

    const response = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '87.66', currency: 'BRL' },
      calculatedBalance: { amount: '87.66', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada, sem corrigir a wallet; inexistente: 404', async () => {
    const wallet = await openWallet('50.00');
    // Divergência forçada no banco de teste: o saldo muda sem lançamento. Desfeita ao
    // final, para não deixar no banco compartilhado uma wallet que viole a invariante do §13.
    await orm.em
      .getConnection()
      .execute('update wallets set balance_cents = balance_cents + 150 where id = ?', [wallet.id]);
    try {
      const response = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
      });

      expect(await json(response)).toMatchObject({
        storedBalance: { amount: '51.50', currency: 'BRL' },
        calculatedBalance: { amount: '50.00', currency: 'BRL' },
        difference: { amount: '1.50', currency: 'BRL' },
        consistent: false,
      });
      // Nada foi corrigido.
      expect(await json(await get(`/wallets/${wallet.id}`))).toMatchObject({
        balance: { amount: '51.50', currency: 'BRL' },
      });
    } finally {
      await orm.em
        .getConnection()
        .execute('update wallets set balance_cents = balance_cents - 150 where id = ?', [
          wallet.id,
        ]);
    }
    const missing = await fetch(`${baseUrl}/wallets/${randomUUID()}/reconciliation`, {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
  });
});
