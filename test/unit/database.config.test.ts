import { describe, expect, test } from 'bun:test';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { readDatabaseSettings } from '../../src/database/database.config';
import { createOrmConfig, DATABASE_CONNECT_TIMEOUT_MS } from '../../src/database/orm.config';

const SECRET = 'fake-secret-for-tests';

const VALID_ENV = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
  DB_USER: 'tester',
  DB_PASSWORD: SECRET,
  DB_NAME: 'testdb',
};

function errorMessageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('A função deveria ter lançado um erro.');
}

describe('readDatabaseSettings', () => {
  test('converte variáveis válidas em configuração tipada', () => {
    expect(readDatabaseSettings(VALID_ENV)).toEqual({
      host: '127.0.0.1',
      port: 5432,
      user: 'tester',
      password: SECRET,
      dbName: 'testdb',
    });
  });

  test('lista as variáveis ausentes ou vazias sem expor valores', () => {
    const message = errorMessageOf(() =>
      readDatabaseSettings({ ...VALID_ENV, DB_HOST: undefined, DB_NAME: '' }),
    );

    expect(message).toContain('DB_HOST');
    expect(message).toContain('DB_NAME');
    expect(message).not.toContain('DB_USER');
    expect(message).not.toContain(SECRET);
  });

  test.each(['0', '65536', '54a', '-1', '5432.5'])('rejeita DB_PORT inválida: %p', (port) => {
    const message = errorMessageOf(() => readDatabaseSettings({ ...VALID_ENV, DB_PORT: port }));

    expect(message).toContain('DB_PORT inválida');
    expect(message).not.toContain(SECRET);
  });
});

describe('createOrmConfig', () => {
  test('não cria o banco automaticamente e registra o Migrator transacional', () => {
    const config = createOrmConfig(VALID_ENV);

    expect(config.ensureDatabase).toBe(false);
    expect(config.migrations?.transactional).toBe(true);
    expect(config.migrations?.allOrNothing).toBe(true);
    expect(config.extensions).toContain(Migrator);
  });

  test('define timeout de conexão para o pg', () => {
    expect(createOrmConfig(VALID_ENV).driverOptions).toEqual({
      connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
    });
  });

  // Regressão: sem timeout, uma conexão aceita que nunca responde deixa connect/select 1 pendentes
  // indefinidamente. Garante que o MikroORM continua repassando o valor ao Pool do pg.
  test('conexão aceita que nunca responde falha pelo timeout, sem travar', async () => {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    });
    const orm = await MikroORM.init({
      ...createOrmConfig({ ...VALID_ENV, DB_PORT: String(server.port) }),
      driverOptions: { connectionTimeoutMillis: 200 },
    });

    try {
      const startedAt = performance.now();
      await orm.connect();
      const check = await orm.checkConnection();

      expect(check.ok).toBe(false);
      expect(check.ok ? '' : check.reason).toContain('timeout');
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await orm.close(true);
      server.stop(true);
    }
  });
});
