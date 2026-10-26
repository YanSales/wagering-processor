import { describe, expect, test } from 'bun:test';
import { DEFAULT_REFERENCE_RETRY } from '../../src/application/reference-retry-policy';
import { readPendingReferenceSettings } from '../../src/wagering/pending-reference.config';

describe('readPendingReferenceSettings', () => {
  test('sem variáveis: padrões documentados (worker ligado, 1 s, lotes de 50, política padrão)', () => {
    expect(readPendingReferenceSettings({})).toEqual({
      enabled: true,
      pollIntervalMs: 1_000,
      batchSize: 50,
      retry: { ...DEFAULT_REFERENCE_RETRY },
    });
  });

  test('variáveis presentes substituem os padrões', () => {
    expect(
      readPendingReferenceSettings({
        PENDING_REFERENCE_WORKER_ENABLED: 'false',
        PENDING_REFERENCE_POLL_INTERVAL_MS: '250',
        PENDING_REFERENCE_BATCH_SIZE: '10',
        PENDING_REFERENCE_MAX_ATTEMPTS: '3',
        PENDING_REFERENCE_BASE_DELAY_MS: '500',
        PENDING_REFERENCE_MAX_DELAY_MS: '4000',
      }),
    ).toEqual({
      enabled: false,
      pollIntervalMs: 250,
      batchSize: 10,
      retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4_000 },
    });
  });

  test('variável vazia vale como ausente', () => {
    expect(readPendingReferenceSettings({ PENDING_REFERENCE_BATCH_SIZE: '' }).batchSize).toBe(50);
  });

  test.each([
    ['PENDING_REFERENCE_WORKER_ENABLED', 'yes'],
    ['PENDING_REFERENCE_POLL_INTERVAL_MS', '0'],
    ['PENDING_REFERENCE_BATCH_SIZE', '-5'],
    ['PENDING_REFERENCE_MAX_ATTEMPTS', '2.5'],
    ['PENDING_REFERENCE_BASE_DELAY_MS', '1e3'],
    ['PENDING_REFERENCE_MAX_DELAY_MS', '99999999999999999999'],
  ])('%s=%s é recusada, com o nome da variável', (name, value) => {
    expect(() => readPendingReferenceSettings({ [name]: value })).toThrow(name);
  });
});
