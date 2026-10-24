import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { assertTestDatabaseEnv } from '../support/test-database';

// O AppModule conecta ao PostgreSQL no bootstrap: só roda contra o banco de teste.
assertTestDatabaseEnv();

describe('GET /health/live (integração HTTP em processo)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  test('responde 200 com status ok', async () => {
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('rota inexistente responde 404', async () => {
    const response = await fetch(`${baseUrl}/health/unknown`);

    expect(response.status).toBe(404);
  });
});
