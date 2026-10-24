import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

// Requer o PostgreSQL do compose.yaml em execução (`bun run db:up`) e o `.env` configurado.
describe('PostgreSQL via MikroORM (integração com banco real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let closed = false;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    if (!closed) {
      await app?.close();
    }
  });

  test('a aplicação conecta ao banco configurado', async () => {
    expect(await orm.checkConnection()).toEqual({ ok: true });

    const rows = await orm.em.getConnection().execute<{ ok: number }[]>('select 1 as ok');
    expect(rows).toEqual([{ ok: 1 }]);
  });

  test('o Migrator lê o histórico na tabela de controle de migrations', async () => {
    expect(Array.isArray(await orm.migrator.getPending())).toBe(true);
    expect(Array.isArray(await orm.migrator.getExecuted())).toBe(true);

    const rows = await orm.em
      .getConnection()
      .execute<{ found: boolean }[]>(
        "select to_regclass('public.mikro_orm_migrations') is not null as found",
      );
    expect(rows).toEqual([{ found: true }]);
  });

  test('encerrar a aplicação fecha a conexão com o banco', async () => {
    await app.close();
    closed = true;

    expect(await orm.isConnected()).toBe(false);
  });
});

describe('bootstrap com credenciais inválidas', () => {
  test('falha na inicialização, sem expor a senha na mensagem', async () => {
    const original = process.env.DB_PASSWORD;
    const invalid = 'invalid-password-for-test';
    process.env.DB_PASSWORD = invalid;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });

    try {
      const error = await app.init().then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Falha ao conectar ao PostgreSQL');
      expect((error as Error).message).not.toContain(invalid);
    } finally {
      process.env.DB_PASSWORD = original;
      await app.close().catch(() => undefined);
    }
  });
});
