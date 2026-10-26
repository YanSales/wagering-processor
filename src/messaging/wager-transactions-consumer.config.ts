import { readBoolean, readPositiveInt } from '../wagering/pending-reference.config';

/** Configuração do consumidor de `wager-transactions.fifo` (contrato §10), lida do ambiente. */
export interface WagerTransactionsConsumerSettings {
  /** Desligado por padrão; ligado, exige as variáveis do SQS e as filas provisionadas. */
  enabled: boolean;
  queueName: string;
  dlqName: string;
  /** Long polling de cada `ReceiveMessage` (0–20 s). */
  waitTimeSeconds: number;
  /** Mensagens por `ReceiveMessage` (1–10). */
  maxMessages: number;
  /** Visibilidade após a primeira falha transitória; dobra a cada recebimento. */
  retryBaseSeconds: number;
  /** Teto da visibilidade entre tentativas. */
  retryMaxSeconds: number;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_WAGER_TRANSACTIONS_QUEUE = 'wager-transactions.fifo';
export const DEFAULT_WAGER_TRANSACTIONS_DLQ = 'wager-transactions-dlq.fifo';

/** Variáveis opcionais; valores inválidos impedem a inicialização. */
export function readWagerTransactionsConsumerSettings(
  env: Env = process.env,
): WagerTransactionsConsumerSettings {
  const settings: WagerTransactionsConsumerSettings = {
    enabled: readBoolean(env, 'WAGER_TRANSACTIONS_CONSUMER_ENABLED', false),
    queueName: env.SQS_WAGER_TRANSACTIONS_QUEUE || DEFAULT_WAGER_TRANSACTIONS_QUEUE,
    dlqName: env.SQS_WAGER_TRANSACTIONS_DLQ || DEFAULT_WAGER_TRANSACTIONS_DLQ,
    waitTimeSeconds: readPositiveInt(env, 'WAGER_TRANSACTIONS_WAIT_TIME_SECONDS', 5),
    maxMessages: readPositiveInt(env, 'WAGER_TRANSACTIONS_MAX_MESSAGES', 10),
    retryBaseSeconds: readPositiveInt(env, 'WAGER_TRANSACTIONS_RETRY_BASE_SECONDS', 2),
    retryMaxSeconds: readPositiveInt(env, 'WAGER_TRANSACTIONS_RETRY_MAX_SECONDS', 60),
  };
  for (const [name, value] of [
    ['SQS_WAGER_TRANSACTIONS_QUEUE', settings.queueName],
    ['SQS_WAGER_TRANSACTIONS_DLQ', settings.dlqName],
  ] as const) {
    if (!/^[A-Za-z0-9_-]{1,75}\.fifo$/.test(value)) {
      throw new Error(`${name} inválida: "${value}". Use um nome FIFO terminando em ".fifo".`);
    }
  }
  if (settings.queueName === settings.dlqName) {
    throw new Error(
      'SQS_WAGER_TRANSACTIONS_DLQ deve ser diferente de SQS_WAGER_TRANSACTIONS_QUEUE.',
    );
  }
  if (settings.waitTimeSeconds > 20) {
    throw new Error('WAGER_TRANSACTIONS_WAIT_TIME_SECONDS deve ser no máximo 20.');
  }
  if (settings.maxMessages > 10) {
    throw new Error('WAGER_TRANSACTIONS_MAX_MESSAGES deve ser no máximo 10.');
  }
  if (settings.retryBaseSeconds > settings.retryMaxSeconds) {
    throw new Error(
      'WAGER_TRANSACTIONS_RETRY_BASE_SECONDS não pode ser maior que WAGER_TRANSACTIONS_RETRY_MAX_SECONDS.',
    );
  }
  return settings;
}
