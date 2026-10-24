import { describe, expect, test } from 'bun:test';
import { assertTestDatabaseEnv } from '../support/test-database';

const SECRET = 'fake-secret-for-tests';

describe('assertTestDatabaseEnv', () => {
  test('aceita o ambiente de teste com banco *_test', () => {
    expect(() =>
      assertTestDatabaseEnv({ NODE_ENV: 'test', DB_NAME: 'wagering_test', DB_PASSWORD: SECRET }),
    ).not.toThrow();
  });

  test('recusa banco que não termina com _test, sem expor a senha', () => {
    const run = () =>
      assertTestDatabaseEnv({ NODE_ENV: 'test', DB_NAME: 'wagering', DB_PASSWORD: SECRET });

    expect(run).toThrow('Recusando executar testes contra o banco "wagering"');
    expect(run).not.toThrow(SECRET);
  });

  test.each([
    ['NODE_ENV ausente', { DB_NAME: 'wagering_test' }, 'NODE_ENV=test'],
    ['NODE_ENV diferente', { NODE_ENV: 'development', DB_NAME: 'wagering_test' }, 'NODE_ENV=test'],
    ['DB_NAME ausente', { NODE_ENV: 'test' }, 'DB_NAME ausente'],
    ['DB_NAME vazio', { NODE_ENV: 'test', DB_NAME: '' }, 'DB_NAME ausente'],
    ['sufixo no meio', { NODE_ENV: 'test', DB_NAME: 'wagering_test_dev' }, 'Recusando'],
  ])('recusa %s', (_case, env, message) => {
    expect(() => assertTestDatabaseEnv(env)).toThrow(message);
  });
});
