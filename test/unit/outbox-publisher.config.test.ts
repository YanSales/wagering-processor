import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_OUTBOX_PUBLISHER,
  readOutboxPublisherSettings,
} from '../../src/messaging/outbox-publisher.config';

describe('readOutboxPublisherSettings', () => {
  test('sem variáveis: desligado e com os padrões documentados', () => {
    expect(readOutboxPublisherSettings({})).toEqual({
      ...DEFAULT_OUTBOX_PUBLISHER,
      retry: { baseDelayMs: 1_000, maxDelayMs: 60_000 },
    });
  });

  test('lê os valores informados', () => {
    const settings = readOutboxPublisherSettings({
      OUTBOX_PUBLISHER_ENABLED: 'true',
      OUTBOX_PUBLISHER_LEASE_MS: '20000',
      OUTBOX_PUBLISHER_SEND_TIMEOUT_MS: '10000',
      OUTBOX_PUBLISHER_MAX_GROUPS: '5',
    });
    expect(settings).toMatchObject({
      enabled: true,
      leaseMs: 20_000,
      sendTimeoutMs: 10_000,
      maxGroups: 5,
    });
  });

  test('timeout de envio acima de metade da reserva é recusado', () => {
    expect(() =>
      readOutboxPublisherSettings({
        OUTBOX_PUBLISHER_LEASE_MS: '10000',
        OUTBOX_PUBLISHER_SEND_TIMEOUT_MS: '6000',
      }),
    ).toThrow('OUTBOX_PUBLISHER_SEND_TIMEOUT_MS');
  });

  test('valores inválidos impedem a inicialização', () => {
    expect(() => readOutboxPublisherSettings({ OUTBOX_PUBLISHER_ENABLED: 'yes' })).toThrow(
      'OUTBOX_PUBLISHER_ENABLED',
    );
    expect(() => readOutboxPublisherSettings({ OUTBOX_PUBLISHER_MAX_PER_GROUP: '0' })).toThrow(
      'OUTBOX_PUBLISHER_MAX_PER_GROUP',
    );
  });
});
