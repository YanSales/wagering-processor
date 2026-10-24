/**
 * Configuração de conexão com o PostgreSQL lida do ambiente.
 *
 * As mesmas variáveis alimentam o `compose.yaml` (container) e a aplicação, evitando duplicar a
 * senha. Em desenvolvimento o Bun carrega o `.env` automaticamente; em produção as variáveis devem
 * vir do ambiente de execução.
 *
 * Mensagens de erro citam apenas o nome das variáveis, nunca seus valores.
 */
export interface DatabaseSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  dbName: string;
}

type Env = Record<string, string | undefined>;

const REQUIRED_VARS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const;

export function readDatabaseSettings(env: Env = process.env): DatabaseSettings {
  const missing = REQUIRED_VARS.filter((name) => env[name] === undefined || env[name] === '');
  if (missing.length > 0) {
    throw new Error(
      `Variáveis de ambiente do banco ausentes: ${missing.join(', ')}. Veja o .env.example.`,
    );
  }

  const rawPort = env.DB_PORT as string;
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error(`DB_PORT inválida: "${rawPort}". Use um inteiro entre 1 e 65535.`);
  }

  return {
    host: env.DB_HOST as string,
    port,
    user: env.DB_USER as string,
    password: env.DB_PASSWORD as string,
    dbName: env.DB_NAME as string,
  };
}
