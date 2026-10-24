import { createOrmConfig } from './database/orm.config';

/**
 * Ponto de entrada do CLI `mikro-orm`, que procura `./src/mikro-orm.config.ts` por padrão.
 * A aplicação usa `createOrmConfig()` diretamente no `AppModule`.
 */
export default createOrmConfig();
