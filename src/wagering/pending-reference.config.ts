import {
  DEFAULT_REFERENCE_RETRY,
  type ReferenceRetrySettings,
} from '../application/reference-retry-policy';

/** Configuração do worker de `PENDING_REFERENCE` (contrato §7.1), lida do ambiente. */
export interface PendingReferenceSettings {
  /** `false` só desliga o agendamento nesta instância; as pendências continuam no banco. */
  enabled: boolean;
  /** Intervalo entre o fim de uma rodada e o início da próxima. */
  pollIntervalMs: number;
  /** Máximo de transações por rodada. */
  batchSize: number;
  retry: ReferenceRetrySettings;
}

type Env = Record<string, string | undefined>;

export const DEFAULT_PENDING_REFERENCE_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_PENDING_REFERENCE_BATCH_SIZE = 50;

/**
 * Todas as variáveis são opcionais; ausentes, valem os padrões documentados no `README.md`. Valores
 * inválidos impedem a inicialização. Mensagens citam o nome da variável e o valor (nenhum é segredo).
 */
export function readPendingReferenceSettings(env: Env = process.env): PendingReferenceSettings {
  return {
    enabled: readBoolean(env, 'PENDING_REFERENCE_WORKER_ENABLED', true),
    pollIntervalMs: readPositiveInt(
      env,
      'PENDING_REFERENCE_POLL_INTERVAL_MS',
      DEFAULT_PENDING_REFERENCE_POLL_INTERVAL_MS,
    ),
    batchSize: readPositiveInt(
      env,
      'PENDING_REFERENCE_BATCH_SIZE',
      DEFAULT_PENDING_REFERENCE_BATCH_SIZE,
    ),
    retry: {
      maxAttempts: readPositiveInt(
        env,
        'PENDING_REFERENCE_MAX_ATTEMPTS',
        DEFAULT_REFERENCE_RETRY.maxAttempts,
      ),
      baseDelayMs: readPositiveInt(
        env,
        'PENDING_REFERENCE_BASE_DELAY_MS',
        DEFAULT_REFERENCE_RETRY.baseDelayMs,
      ),
      maxDelayMs: readPositiveInt(
        env,
        'PENDING_REFERENCE_MAX_DELAY_MS',
        DEFAULT_REFERENCE_RETRY.maxDelayMs,
      ),
    },
  };
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} inválida: "${raw}". Use true ou false.`);
}

function readPositiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} inválida: "${raw}". Use um inteiro positivo.`);
  }
  return value;
}
