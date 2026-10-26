import {
  DEFAULT_OUTBOX_RETRY,
  type OutboxRetrySettings,
} from '../application/outbox/outbox-retry-policy';
import { readBoolean, readPositiveInt } from '../wagering/pending-reference.config';

/** Configuração do publisher da outbox (contrato §11), lida do ambiente. */
export interface OutboxPublisherSettings {
  /**
   * Desligado por padrão: ligar exige as variáveis do SQS (`sqs.config.ts`) e a fila provisionada.
   * Desligado, os eventos continuam gravados e saem quando algum publisher for ligado.
   */
  enabled: boolean;
  /** Intervalo entre o fim de uma rodada e o início da próxima. */
  pollIntervalMs: number;
  /** Máximo de wallets reservadas por rodada. */
  maxGroups: number;
  /** Máximo de eventos reservados por wallet numa rodada. */
  maxPerGroup: number;
  /** Duração da reserva; depois dela, outro publisher pode assumir a wallet. */
  leaseMs: number;
  /** Timeout de cada envio ao SQS; até metade da reserva. */
  sendTimeoutMs: number;
  retry: OutboxRetrySettings;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_OUTBOX_PUBLISHER: Readonly<Omit<OutboxPublisherSettings, 'retry'>> = {
  enabled: false,
  pollIntervalMs: 500,
  maxGroups: 20,
  maxPerGroup: 50,
  leaseMs: 30_000,
  sendTimeoutMs: 10_000,
};

/** Variáveis opcionais; valores inválidos impedem a inicialização (mensagens sem segredos). */
export function readOutboxPublisherSettings(env: Env = process.env): OutboxPublisherSettings {
  const d = DEFAULT_OUTBOX_PUBLISHER;
  const settings: OutboxPublisherSettings = {
    enabled: readBoolean(env, 'OUTBOX_PUBLISHER_ENABLED', d.enabled),
    pollIntervalMs: readPositiveInt(env, 'OUTBOX_PUBLISHER_POLL_INTERVAL_MS', d.pollIntervalMs),
    maxGroups: readPositiveInt(env, 'OUTBOX_PUBLISHER_MAX_GROUPS', d.maxGroups),
    maxPerGroup: readPositiveInt(env, 'OUTBOX_PUBLISHER_MAX_PER_GROUP', d.maxPerGroup),
    leaseMs: readPositiveInt(env, 'OUTBOX_PUBLISHER_LEASE_MS', d.leaseMs),
    sendTimeoutMs: readPositiveInt(env, 'OUTBOX_PUBLISHER_SEND_TIMEOUT_MS', d.sendTimeoutMs),
    retry: {
      baseDelayMs: readPositiveInt(
        env,
        'OUTBOX_PUBLISHER_RETRY_BASE_MS',
        DEFAULT_OUTBOX_RETRY.baseDelayMs,
      ),
      maxDelayMs: readPositiveInt(
        env,
        'OUTBOX_PUBLISHER_RETRY_MAX_MS',
        DEFAULT_OUTBOX_RETRY.maxDelayMs,
      ),
    },
  };
  // O publisher não começa envios depois de metade da reserva; um envio precisa caber no restante.
  if (settings.sendTimeoutMs * 2 > settings.leaseMs) {
    throw new Error(
      'OUTBOX_PUBLISHER_SEND_TIMEOUT_MS deve ser no máximo metade de OUTBOX_PUBLISHER_LEASE_MS.',
    );
  }
  return settings;
}
