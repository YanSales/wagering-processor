import { DATABASE_CONNECT_TIMEOUT_MS } from '../../src/database/orm.config';

type Env = Record<string, string | undefined>;

/**
 * Timeout de hooks e testes que inicializam ou encerram a aplicação com banco. Precisa exceder o
 * timeout de conexão (mais o bootstrap do Nest) para que uma falha de conexão apareça com sua
 * mensagem real, e não como o timeout genérico de 5 s do Bun.
 */
export const DATABASE_BOOTSTRAP_TIMEOUT_MS = DATABASE_CONNECT_TIMEOUT_MS + 5_000;

export const TEST_DATABASE_SUFFIX = '_test';

/**
 * Proteção contra executar testes que acessam o banco fora do ambiente de teste.
 *
 * Chamada no topo de cada suíte de integração/smoke, antes de qualquer conexão. Falha se o processo
 * não estiver em `NODE_ENV=test` ou se `DB_NAME` não terminar com `_test` — por exemplo, quando
 * `bun test` é executado sem `.env.test` e herda o `.env` de desenvolvimento. A mensagem cita apenas
 * o nome do banco, nunca credenciais.
 */
export function assertTestDatabaseEnv(env: Env = process.env): void {
  const hint =
    'Copie .env.test.example para .env.test, suba o banco com `bun run db:test:up` e use ' +
    '`bun run test:integration` ou `bun run test:smoke`.';

  if (env.NODE_ENV !== 'test') {
    throw new Error(`Testes com banco exigem NODE_ENV=test. ${hint}`);
  }

  const dbName = env.DB_NAME;
  if (dbName === undefined || dbName === '') {
    throw new Error(`DB_NAME ausente no ambiente de teste. ${hint}`);
  }

  if (!dbName.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `Recusando executar testes contra o banco "${dbName}": DB_NAME deve terminar com ` +
        `"${TEST_DATABASE_SUFFIX}". ${hint}`,
    );
  }
}
