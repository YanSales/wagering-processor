type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Proteção dos testes de mensageria: só rodam contra um emulador SQS no loopback, nunca contra o
 * SQS da AWS (o que aconteceria sem `SQS_ENDPOINT`, se houver credenciais reais no ambiente).
 * Retorna o endpoint validado. A mensagem de erro não cita credenciais.
 */
export function assertLocalSqsEndpoint(env: Env = process.env): string {
  const hint =
    'Defina SQS_ENDPOINT (veja .env.test.example), suba o emulador com `bun run sqs:up` e use ' +
    '`bun run test:sqs`.';
  const endpoint = env.SQS_ENDPOINT;
  if (endpoint === undefined || endpoint === '') {
    throw new Error(`SQS_ENDPOINT ausente: os testes não rodam contra o SQS da AWS. ${hint}`);
  }

  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    throw new Error(`SQS_ENDPOINT inválido: "${endpoint}". ${hint}`);
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `Recusando executar testes contra o SQS em "${hostname}": use um emulador no loopback. ${hint}`,
    );
  }
  return endpoint;
}
