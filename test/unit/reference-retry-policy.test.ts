import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REFERENCE_RETRY,
  ReferenceRetryPolicy,
} from '../../src/application/reference-retry-policy';
import { T0 } from '../support/wager-fixtures';

const delayAfter = (policy: ReferenceRetryPolicy, attempts: number) =>
  policy.nextAttemptAt(attempts, T0).getTime() - T0.getTime();

describe('ReferenceRetryPolicy', () => {
  test('padrão: 10 tentativas, 2 s dobrando até 5 min; rejeição cerca de 18,5 min após a submissão', () => {
    const policy = ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);
    // Esperas antes de cada uma das 10 tentativas: após a submissão (0) e após as 9 primeiras.
    const delays = Array.from({ length: 10 }, (_, done) => delayAfter(policy, done) / 1_000);

    expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
    expect(delays.reduce((sum, s) => sum + s, 0)).toBe(1_110);
    expect(policy.isExhausted(9)).toBe(false);
    expect(policy.isExhausted(10)).toBe(true);
  });

  test('o teto vale para qualquer número de tentativas, sem estouro', () => {
    const policy = ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);

    expect(delayAfter(policy, 1_000)).toBe(300_000);
    expect(delayAfter(policy, Number.MAX_SAFE_INTEGER)).toBe(300_000);
  });

  test('quarentena operacional: mesma progressão e teto, sem limite de ocorrências', () => {
    const policy = ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);
    const delays = Array.from(
      { length: 15 },
      (_, failures) =>
        (policy.nextAttemptAfterFailure(failures, T0).getTime() - T0.getTime()) / 1_000,
    );

    expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300, 300, 300, 300, 300]);
    expect(policy.nextAttemptAfterFailure(Number.MAX_SAFE_INTEGER, T0).getTime()).toBe(
      T0.getTime() + 300_000,
    );
  });

  test('a quarentena usa a base e o teto configurados (as mesmas variáveis do reprocessamento)', () => {
    const policy = ReferenceRetryPolicy.from({ maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 350 });

    expect(
      [0, 1, 2, 3].map((f) => policy.nextAttemptAfterFailure(f, T0).getTime() - T0.getTime()),
    ).toEqual([100, 200, 350, 350]);
  });

  test('não altera a data recebida', () => {
    const now = new Date(T0.getTime());
    ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY).nextAttemptAt(0, now);

    expect(now.getTime()).toBe(T0.getTime());
  });

  test.each([
    ['maxAttempts zero', { maxAttempts: 0 }],
    ['baseDelayMs negativo', { baseDelayMs: -1 }],
    ['maxDelayMs fracionário', { maxDelayMs: 1.5 }],
    ['base maior que o teto', { baseDelayMs: 10_000, maxDelayMs: 1_000 }],
  ])('configuração inválida: %s', (_case, overrides) => {
    expect(() => ReferenceRetryPolicy.from({ ...DEFAULT_REFERENCE_RETRY, ...overrides })).toThrow(
      RangeError,
    );
  });
});
