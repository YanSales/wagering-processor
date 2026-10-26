/** Parâmetros das novas tentativas de publicação de um evento da outbox. */
export interface OutboxRetrySettings {
  /** Espera depois da primeira falha; dobra a cada falha seguida. */
  baseDelayMs: number;
  /** Teto da espera entre tentativas. */
  maxDelayMs: number;
}

/**
 * Padrão do projeto: 1 s após a primeira falha, dobrando até 60 s. Uma indisponibilidade curta do SQS
 * se resolve em segundos, e uma longa não gera mais de uma tentativa por minuto por wallet.
 */
export const DEFAULT_OUTBOX_RETRY: Readonly<OutboxRetrySettings> = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

/**
 * Backoff exponencial com teto e **sem limite de tentativas**: um evento confirmado nunca é
 * descartado (§11, "sem perder"), e os eventos seguintes da mesma wallet esperam por ele para não
 * sair fora de ordem. O atraso é aplicado pelo relógio do banco, o mesmo de `next_attempt_at`.
 */
export class OutboxRetryPolicy {
  private constructor(readonly settings: Readonly<OutboxRetrySettings>) {}

  static from(settings: OutboxRetrySettings): OutboxRetryPolicy {
    for (const name of ['baseDelayMs', 'maxDelayMs'] as const) {
      const value = settings[name];
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} deve ser um inteiro positivo; recebido ${String(value)}.`);
      }
    }
    if (settings.baseDelayMs > settings.maxDelayMs) {
      throw new RangeError('baseDelayMs não pode ser maior que maxDelayMs.');
    }
    return new OutboxRetryPolicy(Object.freeze({ ...settings }));
  }

  /** Espera antes da próxima tentativa, dadas as falhas já registradas antes desta (0, 1, 2…). */
  delayAfterFailure(previousAttempts: number): number {
    if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0) {
      throw new RangeError(
        `previousAttempts deve ser um inteiro não negativo; recebido ${previousAttempts}.`,
      );
    }
    const { baseDelayMs, maxDelayMs } = this.settings;
    // Para no teto antes de a potência crescer além do necessário.
    let delay = baseDelayMs;
    for (let i = 0; i < previousAttempts && delay < maxDelayMs; i += 1) delay *= 2;
    return Math.min(delay, maxDelayMs);
  }
}
