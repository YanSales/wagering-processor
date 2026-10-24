import { fileURLToPath } from 'node:url';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { readDatabaseSettings } from './database.config';
import { entities } from './entities';

const MIGRATIONS_PATH = fileURLToPath(new URL('./migrations', import.meta.url));

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
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_PATH,
      emit: 'ts',
      transactional: true,
      allOrNothing: true,
    },
  });
}
