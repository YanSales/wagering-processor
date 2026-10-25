import { fileURLToPath } from 'node:url';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { readDatabaseSettings } from './database.config';
import { entities } from './entities';

const MIGRATIONS_PATH = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Limite para abrir uma conexão com o PostgreSQL. Sem ele, o `pg` espera indefinidamente quando a
 * conexão TCP é aceita mas o servidor não responde, e a inicialização trava em vez de falhar.
 */
export const DATABASE_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Configuração única do MikroORM, usada pelo `AppModule` e pelo CLI (via `src/mikro-orm.config.ts`).
 *
 * O schema evolui somente por migrations versionadas: não há sincronização automática.
 */
export function createOrmConfig(env: Record<string, string | undefined> = process.env): Options {
  const { host, port, user, password, dbName } = readDatabaseSettings(env);

  return defineConfig({
    host,
    port,
    user,
    password,
    dbName,
    entities,
    discovery: {
      // Apesar do nome, `true` (padrão) faz a descoberta lançar erro quando não há entidades.
      // Remover quando a primeira entidade for registrada em `entities.ts`.
      warnWhenNoEntities: false,
    },
    // O banco é criado pela infraestrutura (Compose/ambiente), nunca pela aplicação.
    ensureDatabase: false,
    // Repassado ao `Pool` do `pg`: o `pool` do MikroORM 7 só aceita min, max e idleTimeoutMillis.
    driverOptions: { connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS },
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_PATH,
      emit: 'ts',
      transactional: true,
      allOrNothing: true,
    },
  });
}
