import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// O AppModule conecta ao PostgreSQL no bootstrap: só roda contra o banco de teste. O publisher e o
// consumidor SQS ficam desligados (padrão): o readiness não exige o SQS.
assertTestDatabaseEnv();

async function startApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, baseUrl: await app.getUrl() };
}

/** Valor de uma série do texto do Prometheus (`nome{rótulos} valor`); `undefined` se ausente. */
function metricValue(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('health e métricas (integração HTTP em processo)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await startApp());
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close();
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  test('GET /health/live responde 200 com status ok', async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('GET /health/ready: PostgreSQL alcançável e SQS desligado → 200', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'up', sqs: 'disabled' },
    });
  });

  test('rota inexistente responde 404', async () => {
    const response = await fetch(`${baseUrl}/health/unknown`);

    expect(response.status).toBe(404);
  });

  test('GET /metrics: formato Prometheus, dados do banco e contadores atualizados', async () => {
    const before = await (await fetch(`${baseUrl}/metrics`)).text();
    const opened = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: `player-${randomUUID()}`,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    const wallet = (await opened.json()) as { id: string; playerId: string };
    const bet = {
      providerId: 'provider-a',
      externalTransactionId: `tx-${randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const submit = () =>
      fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `k-${bet.externalTransactionId}`,
        },
        body: JSON.stringify(bet),
      });
    expect((await submit()).status).toBe(200);
    expect((await submit()).status).toBe(200); // replay

    const response = await fetch(`${baseUrl}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('# TYPE wagering_transactions gauge');
    for (const status of ['PENDING', 'PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED']) {
      expect(metricValue(text, `wagering_transactions{status="${status}"}`)).toBeGreaterThanOrEqual(
        0,
      );
    }
    expect(metricValue(text, 'wagering_transactions{status="PROCESSED"}')).toBeGreaterThan(
      metricValue(before, 'wagering_transactions{status="PROCESSED"}') ?? 0,
    );
    // Abertura e BET gravaram eventos; nenhum publisher está ligado neste teste.
    expect(metricValue(text, 'wagering_outbox_pending_messages')).toBeGreaterThan(0);
    expect(metricValue(text, 'wagering_outbox_lag_seconds')).toBeGreaterThanOrEqual(0);
    expect(metricValue(text, 'wagering_lock_waits')).toBeGreaterThanOrEqual(0);
    expect(metricValue(text, 'wagering_metrics_source_up{source="postgres"}')).toBe(1);

    const replays = 'wagering_duplicates_total{channel="http",type="idempotency_replay"}';
    expect(metricValue(text, replays)).toBe((metricValue(before, replays) ?? 0) + 1);
    const latency = 'wagering_processing_duration_seconds_count{channel="http"}';
    expect(metricValue(text, latency)).toBe((metricValue(before, latency) ?? 0) + 2);
    expect(text).toContain('wagering_processing_duration_seconds_bucket{channel="http",le="+Inf"}');
    // Sem identificadores por wallet ou transação nos rótulos.
    expect(text).not.toContain(wallet.id);
  });
});

describe('PostgreSQL indisponível para o readiness', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, baseUrl } = await startApp());
    // Encerra o pool: a verificação do PostgreSQL falha (`checkConnection` não está conectado). As
    // métricas com o banco falhando são testadas em `test/unit/observability.test.ts`.
    await app.get(MikroORM).close(true);
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  test('liveness continua 200; readiness responde 503 sem detalhes do erro', async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);
    const body = await ready.text();

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      status: 'unavailable',
      checks: { postgres: 'down', sqs: 'disabled' },
    });
    for (const secret of [process.env.DB_PASSWORD, process.env.DB_USER, process.env.DB_HOST]) {
      if (secret) expect(body).not.toContain(secret);
    }
  });
});
