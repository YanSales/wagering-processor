/** Parâmetros do reprocessamento de `PENDING_REFERENCE` (contrato §7.1). */
export interface ReferenceRetrySettings {
  /** Tentativas do worker antes de rejeitar com `REFERENCE_NOT_FOUND`. */
  maxAttempts: number;
  /** Espera até a primeira tentativa; dobra a cada tentativa sem a referência. */
  baseDelayMs: number;
  /** Teto da espera entre tentativas. */
  maxDelayMs: number;
}

/**
 * Padrão aprovado para o projeto (o §7.1 deixa o limite "definido e justificado por você"): 10
 * tentativas, a primeira 2 s após a submissão, dobrando até o teto de 5 min. Esperas: 2, 4, 8, 16,
 * 32, 64, 128, 256, 300 e 300 s; a rejeição ocorre cerca de 18,5 min após a submissão. Cobre a
 * reentrega fora de ordem de uma fila at-least-once (segundos a minutos) sem manter uma operação
 * pendente por horas.
 */
export const DEFAULT_REFERENCE_RETRY: Readonly<ReferenceRetrySettings> = {
  maxAttempts: 10,
  baseDelayMs: 2_000,
  maxDelayMs: 300_000,
};

/**
 * Backoff exponencial com teto e limite de tentativas. Sem jitter: o agendamento é por linha no banco
 * e os workers disputam linhas, não um recurso externo sincronizado.
 */
export class ReferenceRetryPolicy {
  private constructor(readonly settings: Readonly<ReferenceRetrySettings>) {}

  static from(settings: ReferenceRetrySettings): ReferenceRetryPolicy {
    for (const name of ['maxAttempts', 'baseDelayMs', 'maxDelayMs'] as const) {
      const value = settings[name];
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} deve ser um inteiro positivo; recebido ${String(value)}.`);
      }
    }
    if (settings.baseDelayMs > settings.maxDelayMs) {
      throw new RangeError('baseDelayMs não pode ser maior que maxDelayMs.');
    }
    return new ReferenceRetryPolicy(Object.freeze({ ...settings }));
  }

  /** `true` quando as tentativas feitas já atingiram o limite. */
  isExhausted(completedAttempts: number): boolean {
    return completedAttempts >= this.settings.maxAttempts;
  }

  /** Próxima tentativa após `completedAttempts` tentativas sem a referência (0 = submissão). */
  nextAttemptAt(completedAttempts: number, now: Date): Date {
    return this.#after(completedAttempts, now);
  }

  /**
   * Quarentena após uma falha operacional (nem transitória nem de negócio), dadas as falhas seguidas
   * já registradas antes desta: a mesma progressão e o mesmo teto (2 s, 4 s… até 5 min no padrão),
   * sem limite de ocorrências e sem consumir tentativas de resolução. Falha operacional não é
   * evidência de que a referência não existe.
   */
  nextAttemptAfterFailure(previousFailures: number, now: Date): Date {
    return this.#after(previousFailures, now);
  }

  #after(exponent: number, now: Date): Date {
    const { baseDelayMs, maxDelayMs } = this.settings;
    // O expoente é limitado antes da potência: o teto é atingido muito antes de 2^31.
    const factor = 2 ** Math.min(exponent, 31);
    return new Date(now.getTime() + Math.min(baseDelayMs * factor, maxDelayMs));
  }
}
