import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { AuthGuard } from '../../src/auth/auth.guard';
import { IS_PUBLIC_ROUTE } from '../../src/auth/public.decorator';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// O AppModule conecta ao PostgreSQL no bootstrap: só roda contra o banco de teste.
assertTestDatabaseEnv();

/** Guard de teste: nega tudo que não é `@Public()`, como uma autenticação real sem credenciais. */
class DenyNonPublicGuard implements CanActivate {
  readonly #reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    return (
      this.#reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}

async function startApp(guard?: CanActivate) {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (guard !== undefined) {
    builder.overrideProvider(AuthGuard).useValue(guard);
  }
  const app = (await builder.compile()).createNestApplication({ logger: false });
  // `POST /wallets` grava: o schema precisa existir mesmo se esta suíte rodar primeiro.
  await app.get(MikroORM).migrator.up();
  await app.listen(0, '127.0.0.1');
  return { app, baseUrl: await app.getUrl() };
}

const openWallet = (baseUrl: string) =>
  fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: `player-${randomUUID()}`,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    }),
  });

describe('autenticação desativada (estado atual)', () => {
  let started: { app: INestApplication; baseUrl: string };

  beforeAll(async () => {
    started = await startApp();
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    await started?.app.close();
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  test('POST /wallets sem nenhuma credencial é aceito: a API não está protegida', async () => {
    expect((await openWallet(started.baseUrl)).status).toBe(201);
  });

  test('o guard global registrado é o AuthGuard no-op', () => {
    expect(started.app.get(AuthGuard)).toBeInstanceOf(AuthGuard);
  });
});

describe('ponto de extensão: substituir o AuthGuard protege as rotas não públicas', () => {
  let started: { app: INestApplication; baseUrl: string };

  beforeAll(async () => {
    started = await startApp(new DenyNonPublicGuard());
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  afterAll(async () => {
    await started?.app.close();
  }, DATABASE_BOOTSTRAP_TIMEOUT_MS);

  test('POST /wallets passa pelo guard global e é negado (403)', async () => {
    const response = await openWallet(started.baseUrl);

    expect(response.status).toBe(403);
  });

  test('GET /health/live continua aberto (@Public)', async () => {
    const response = await fetch(`${started.baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
