import { SQSClient } from '@aws-sdk/client-sqs';

/**
 * Configuração do SQS lida do ambiente.
 *
 * Credenciais não passam por aqui: o SDK da AWS as resolve pela cadeia padrão (variáveis
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, perfil, papel da instância). Localmente, o
 * ElasticMQ não valida credenciais, mas o SDK exige valores; o `.env.example` usa fictícios.
 *
 * `SQS_ENDPOINT` é opcional: definido, aponta para o emulador local; ausente, usa o SQS da AWS.
 * Mensagens de erro citam apenas nomes de variáveis.
 */
export interface SqsSettings {
  region: string;
  endpoint: string | undefined;
  wagerEventsQueueName: string;
  wagerEventsDlqName: string;
}

type Env = Record<string, string | undefined>;

const REQUIRED_VARS = ['AWS_REGION', 'SQS_WAGER_EVENTS_QUEUE', 'SQS_WAGER_EVENTS_DLQ'] as const;

// Regra da AWS para filas FIFO: até 80 caracteres no total, incluindo o sufixo `.fifo`.
const FIFO_QUEUE_NAME = /^[A-Za-z0-9_-]{1,75}\.fifo$/;

export function readSqsSettings(env: Env = process.env): SqsSettings {
  const missing = REQUIRED_VARS.filter((name) => env[name] === undefined || env[name] === '');
  if (missing.length > 0) {
    throw new Error(
      `Variáveis de ambiente do SQS ausentes: ${missing.join(', ')}. Veja o .env.example.`,
    );
  }

  const wagerEventsQueueName = env.SQS_WAGER_EVENTS_QUEUE as string;
  const wagerEventsDlqName = env.SQS_WAGER_EVENTS_DLQ as string;
  assertFifoQueueName('SQS_WAGER_EVENTS_QUEUE', wagerEventsQueueName);
  assertFifoQueueName('SQS_WAGER_EVENTS_DLQ', wagerEventsDlqName);
  if (wagerEventsQueueName === wagerEventsDlqName) {
    throw new Error('SQS_WAGER_EVENTS_DLQ deve ser diferente de SQS_WAGER_EVENTS_QUEUE.');
  }

  const endpoint = env.SQS_ENDPOINT === '' ? undefined : env.SQS_ENDPOINT;
  if (endpoint !== undefined && !isHttpUrl(endpoint)) {
    throw new Error(`SQS_ENDPOINT inválido: "${endpoint}". Use uma URL http(s).`);
  }

  return {
    region: env.AWS_REGION as string,
    endpoint,
    wagerEventsQueueName,
    wagerEventsDlqName,
  };
}

export function createSqsClient(settings: Pick<SqsSettings, 'region' | 'endpoint'>): SQSClient {
  return new SQSClient({
    region: settings.region,
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
  });
}

function assertFifoQueueName(variable: string, value: string): void {
  if (!FIFO_QUEUE_NAME.test(value)) {
    throw new Error(
      `${variable} inválida: "${value}". Use até 80 caracteres [A-Za-z0-9_-] terminando em ".fifo".`,
    );
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
