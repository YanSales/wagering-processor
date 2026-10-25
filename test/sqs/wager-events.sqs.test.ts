import 'reflect-metadata';
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ListDeadLetterSourceQueuesCommand,
  ListQueuesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Test } from '@nestjs/testing';
import {
  MessagingModule,
  SQS_SETTINGS,
  WagerEventsQueues,
} from '../../src/messaging/messaging.module';
import { createSqsClient, readSqsSettings } from '../../src/messaging/sqs.config';
import {
  provisionWagerEventsQueues,
  WAGER_EVENTS_DLQ_RETENTION_SECONDS,
  WAGER_EVENTS_MAX_RECEIVE_COUNT,
  WAGER_EVENTS_RETENTION_SECONDS,
  WAGER_EVENTS_VISIBILITY_TIMEOUT_SECONDS,
} from '../../src/messaging/wager-events.queues';
import { assertLocalSqsEndpoint } from '../support/test-sqs';

// Requer o emulador local (`bun run sqs:up`); recusa qualquer endpoint fora do loopback.
assertLocalSqsEndpoint();

// Filas efêmeras com nome único: os testes nunca tocam `wager-events.fifo` nem sua DLQ.
const PREFIX = `it-${randomUUID().slice(0, 8)}`;
const settings = readSqsSettings({
  ...process.env,
  SQS_WAGER_EVENTS_QUEUE: `${PREFIX}-wager-events.fifo`,
  SQS_WAGER_EVENTS_DLQ: `${PREFIX}-wager-events-dlq.fifo`,
});
const client = createSqsClient(settings);
const GROUP = 'wager-it';

async function receive(queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const { Messages } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
      MessageSystemAttributeNames: ['All'],
    }),
  );
  return Messages ?? [];
}

async function deleteAll(queueUrl: string, messages: Message[]): Promise<void> {
  for (const { ReceiptHandle } of messages) {
    await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle }));
  }
}

describe('filas FIFO de eventos de apostas no emulador SQS', () => {
  afterAll(async () => {
    for (const name of [settings.wagerEventsQueueName, settings.wagerEventsDlqName]) {
      const { QueueUrls } = await client.send(new ListQueuesCommand({ QueueNamePrefix: name }));
      for (const QueueUrl of QueueUrls ?? []) {
        await client.send(new DeleteQueueCommand({ QueueUrl }));
      }
    }
    const { QueueUrls } = await client.send(new ListQueuesCommand({ QueueNamePrefix: PREFIX }));
    client.destroy();
    expect(QueueUrls ?? []).toEqual([]);
  });

  test('provisiona fila principal e DLQ FIFO com a redrive policy versionada', async () => {
    const { main, dlq, unverifiedAttributes } = await provisionWagerEventsQueues(client, settings);
    // Atributo definido e conferido, ou explicitamente não reportado pelo emulador.
    const expectRetention = (
      attributes: Record<string, string>,
      unverified: string[],
      seconds: number,
    ) => {
      if (unverified.includes('MessageRetentionPeriod')) {
        expect(attributes.MessageRetentionPeriod).toBeUndefined();
      } else {
        expect(attributes.MessageRetentionPeriod).toBe(String(seconds));
      }
    };

    expect(main.attributes.FifoQueue).toBe('true');
    expect(dlq.attributes.FifoQueue).toBe('true');
    expect(main.attributes.ContentBasedDeduplication).toBe('false');
    expect(main.attributes.VisibilityTimeout).toBe(String(WAGER_EVENTS_VISIBILITY_TIMEOUT_SECONDS));
    expectRetention(main.attributes, unverifiedAttributes.main, WAGER_EVENTS_RETENTION_SECONDS);
    expectRetention(dlq.attributes, unverifiedAttributes.dlq, WAGER_EVENTS_DLQ_RETENTION_SECONDS);
    // Somente atributos não reportados podem ficar sem conferência; nunca os essenciais.
    for (const keys of [unverifiedAttributes.main, unverifiedAttributes.dlq]) {
      expect(keys.filter((key) => key !== 'MessageRetentionPeriod')).toEqual([]);
    }
    expect(JSON.parse(main.attributes.RedrivePolicy as string)).toEqual({
      deadLetterTargetArn: dlq.attributes.QueueArn,
      maxReceiveCount: WAGER_EVENTS_MAX_RECEIVE_COUNT,
    });

    const { queueUrls } = await client.send(
      new ListDeadLetterSourceQueuesCommand({ QueueUrl: dlq.url }),
    );
    expect(queueUrls).toEqual([main.url]);
  });

  test('reexecutar o provisionamento é idempotente', async () => {
    const first = await provisionWagerEventsQueues(client, settings);
    const second = await provisionWagerEventsQueues(client, settings);

    expect(second.main.url).toBe(first.main.url);
    expect(second.dlq.url).toBe(first.dlq.url);
  });

  test('envia e recebe uma mensagem; reenvio com o mesmo MessageDeduplicationId é descartado', async () => {
    const { main } = await provisionWagerEventsQueues(client, settings);
    const message = { QueueUrl: main.url, MessageGroupId: GROUP, MessageDeduplicationId: 'evt-1' };

    const sent = await client.send(new SendMessageCommand({ ...message, MessageBody: 'teste' }));
    const resent = await client.send(new SendMessageCommand({ ...message, MessageBody: 'teste' }));
    expect(resent.MessageId).toBe(sent.MessageId as string);

    const received = await receive(main.url);
    expect(received.map((m) => [m.Body, m.Attributes?.MessageGroupId])).toEqual([['teste', GROUP]]);
    await deleteAll(main.url, received);
    expect(await receive(main.url)).toEqual([]);
  });

  test('preserva a ordem de envio dentro do mesmo MessageGroupId', async () => {
    const { main } = await provisionWagerEventsQueues(client, settings);
    for (const body of ['a', 'b', 'c']) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: main.url,
          MessageGroupId: GROUP,
          MessageDeduplicationId: `order-${body}`,
          MessageBody: body,
        }),
      );
    }

    const received = await receive(main.url);
    expect(received.map((m) => m.Body)).toEqual(['a', 'b', 'c']);
    await deleteAll(main.url, received);
  });

  test(`move para a DLQ após ${WAGER_EVENTS_MAX_RECEIVE_COUNT} recebimentos sem exclusão`, async () => {
    const { main, dlq } = await provisionWagerEventsQueues(client, settings);
    await client.send(
      new SendMessageCommand({
        QueueUrl: main.url,
        MessageGroupId: GROUP,
        MessageDeduplicationId: 'poison-1',
        MessageBody: 'poison',
      }),
    );

    for (let attempt = 1; attempt <= WAGER_EVENTS_MAX_RECEIVE_COUNT; attempt++) {
      const [message] = await receive(main.url);
      expect(message?.Attributes?.ApproximateReceiveCount).toBe(String(attempt));
      // Devolve a mensagem imediatamente, simulando uma falha de processamento.
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: main.url,
          ReceiptHandle: message?.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }

    expect(await receive(main.url)).toEqual([]);
    const deadLetters = await receive(dlq.url);
    expect(deadLetters.map((m) => [m.Body, m.Attributes?.MessageGroupId])).toEqual([
      ['poison', GROUP],
    ]);
    await deleteAll(dlq.url, deadLetters);
  }, 15_000);

  test('MessagingModule verifica o acesso às filas e destrói o cliente no shutdown', async () => {
    await provisionWagerEventsQueues(client, settings);
    const moduleRef = await Test.createTestingModule({ imports: [MessagingModule] })
      .overrideProvider(SQS_SETTINGS)
      .useValue(settings)
      .compile();
    await moduleRef.init();
    const destroy = spyOn(moduleRef.get(SQSClient), 'destroy');

    const check = await moduleRef.get(WagerEventsQueues).checkAccess();
    expect(check).toEqual({
      ok: true,
      queueUrls: {
        main: expect.stringContaining(settings.wagerEventsQueueName),
        dlq: expect.stringContaining(settings.wagerEventsDlqName),
      },
    });

    await moduleRef.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('MessagingModule reporta fila inexistente sem lançar exceção', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MessagingModule] })
      .overrideProvider(SQS_SETTINGS)
      .useValue({ ...settings, wagerEventsQueueName: `${PREFIX}-inexistente.fifo` })
      .compile();
    await moduleRef.init();

    const check = await moduleRef.get(WagerEventsQueues).checkAccess();
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.reason).toContain('QueueDoesNotExist');

    await moduleRef.close();
  });
});
