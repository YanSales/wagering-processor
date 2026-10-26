import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DeleteQueueCommand, ListQueuesCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient, readSqsSettings } from '../../src/messaging/sqs.config';
import { provisionWagerEventsQueues } from '../../src/messaging/wager-events.queues';
import { createObservedDependencies } from '../../src/observability/observed-dependencies';
import { assertLocalSqsEndpoint } from '../support/test-sqs';

// Emulador SQS no loopback (`bun run sqs:up`); filas efêmeras, nunca as reais.
assertLocalSqsEndpoint();

const PREFIX = `it-${randomUUID().slice(0, 8)}`;
const env = {
  ...process.env,
  SQS_WAGER_EVENTS_QUEUE: `${PREFIX}-wager-events.fifo`,
  SQS_WAGER_EVENTS_DLQ: `${PREFIX}-wager-events-dlq.fifo`,
  SQS_WAGER_TRANSACTIONS_QUEUE: `${PREFIX}-wager-transactions.fifo`,
  SQS_WAGER_TRANSACTIONS_DLQ: `${PREFIX}-wager-transactions-dlq.fifo`,
};
const client = createSqsClient(readSqsSettings(env));
const postgresUp = { checkConnection: async () => ({ ok: true }) } as never;

beforeAll(async () => {
  await provisionWagerEventsQueues(client, {
    wagerEventsQueueName: env.SQS_WAGER_TRANSACTIONS_QUEUE,
    wagerEventsDlqName: env.SQS_WAGER_TRANSACTIONS_DLQ,
  });
});

afterAll(async () => {
  const { QueueUrls } = await client.send(new ListQueuesCommand({ QueueNamePrefix: PREFIX }));
  for (const QueueUrl of QueueUrls ?? []) await client.send(new DeleteQueueCommand({ QueueUrl }));
  client.destroy();
});

describe('readiness e métricas com o SQS habilitado (emulador)', () => {
  test('consumidor ligado e filas existentes: sqs up; DLQ medida no SQS', async () => {
    const dependencies = createObservedDependencies(postgresUp, {
      ...env,
      WAGER_TRANSACTIONS_CONSUMER_ENABLED: 'true',
    });
    const { QueueUrls } = await client.send(
      new ListQueuesCommand({ QueueNamePrefix: env.SQS_WAGER_TRANSACTIONS_DLQ }),
    );
    await client.send(
      new SendMessageCommand({
        QueueUrl: QueueUrls?.[0],
        MessageBody: '{}',
        MessageGroupId: 'g',
        MessageDeduplicationId: randomUUID(),
      }),
    );

    try {
      expect(await dependencies.readiness()).toEqual({
        ready: true,
        checks: { postgres: 'up', sqs: 'up' },
      });
      expect(await dependencies.dlqDepth()).toEqual({
        queue: env.SQS_WAGER_TRANSACTIONS_DLQ,
        messages: 1,
      });
    } finally {
      dependencies.onApplicationShutdown();
    }
  });

  test('publisher ligado e fila de eventos inexistente: sqs down', async () => {
    const dependencies = createObservedDependencies(postgresUp, {
      ...env,
      OUTBOX_PUBLISHER_ENABLED: 'true',
    });
    try {
      expect(await dependencies.readiness()).toEqual({
        ready: false,
        checks: { postgres: 'up', sqs: 'down' },
      });
    } finally {
      dependencies.onApplicationShutdown();
    }
  });
});
