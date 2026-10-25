import { describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  QueueNameExists,
} from '@aws-sdk/client-sqs';
import {
  describeWagerEventsQueues,
  mainQueueAttributes,
  provisionWagerEventsQueues,
  type SqsSender,
  WAGER_EVENTS_MAX_RECEIVE_COUNT,
} from '../../src/messaging/wager-events.queues';

const NAMES = {
  wagerEventsQueueName: 'wager-events.fifo',
  wagerEventsDlqName: 'wager-events-dlq.fifo',
};
const METADATA = { $metadata: {} };

/** SQS em memória com a semântica de CreateQueue observada no SQS/ElasticMQ. */
function fakeSqs(
  options: { mutateStoredAttributes?: (attrs: Record<string, string>) => void } = {},
) {
  const queues = new Map<string, Record<string, string>>();
  const calls: string[] = [];
  const url = (name: string) => `http://sqs.local/000000000000/${name}`;
  const nameOf = (queueUrl: string) => queueUrl.split('/').pop() as string;

  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof CreateQueueCommand) {
      const name = command.input.QueueName as string;
      const attributes = { ...(command.input.Attributes ?? {}) };
      calls.push(`CreateQueue ${name}`);
      const existing = queues.get(name);
      if (existing !== undefined) {
        const { QueueArn: _arn, ...stored } = existing;
        if (JSON.stringify(stored) !== JSON.stringify(attributes)) {
          throw new QueueNameExists({ message: 'exists', ...METADATA });
        }
        return { QueueUrl: url(name) };
      }
      options.mutateStoredAttributes?.(attributes);
      queues.set(name, { ...attributes, QueueArn: `arn:aws:sqs:local:000000000000:${name}` });
      return { QueueUrl: url(name) };
    }
    if (command instanceof GetQueueUrlCommand) {
      const name = command.input.QueueName as string;
      calls.push(`GetQueueUrl ${name}`);
      if (!queues.has(name)) {
        throw new QueueDoesNotExist({ message: 'missing', ...METADATA });
      }
      return { QueueUrl: url(name) };
    }
    if (command instanceof GetQueueAttributesCommand) {
      const name = nameOf(command.input.QueueUrl as string);
      calls.push(`GetQueueAttributes ${name}`);
      return { Attributes: queues.get(name) };
    }
    throw new Error(`Comando inesperado: ${String(command)}`);
  };

  return { client: { send } as unknown as SqsSender, queues, calls };
}

describe('mainQueueAttributes', () => {
  test('define FIFO sem deduplicação por conteúdo e redrive para a DLQ', () => {
    const attributes = mainQueueAttributes('arn:dlq');

    expect(attributes.FifoQueue).toBe('true');
    expect(attributes.ContentBasedDeduplication).toBe('false');
    expect(JSON.parse(attributes.RedrivePolicy as string)).toEqual({
      deadLetterTargetArn: 'arn:dlq',
      maxReceiveCount: WAGER_EVENTS_MAX_RECEIVE_COUNT,
    });
  });
});

describe('provisionWagerEventsQueues', () => {
  test('cria a DLQ antes da fila principal e liga o redrive ao ARN da DLQ', async () => {
    const sqs = fakeSqs();

    const result = await provisionWagerEventsQueues(sqs.client, NAMES);

    expect(sqs.calls.slice(0, 3)).toEqual([
      'CreateQueue wager-events-dlq.fifo',
      'GetQueueAttributes wager-events-dlq.fifo',
      'CreateQueue wager-events.fifo',
    ]);
    const redrive = JSON.parse(result.main.attributes.RedrivePolicy as string);
    expect(redrive.deadLetterTargetArn).toBe(result.dlq.attributes.QueueArn);
    expect(result.main.attributes.FifoQueue).toBe('true');
    expect(result.dlq.attributes.FifoQueue).toBe('true');
  });

  test('é idempotente: reexecutar reutiliza as filas existentes', async () => {
    const sqs = fakeSqs();

    const first = await provisionWagerEventsQueues(sqs.client, NAMES);
    const second = await provisionWagerEventsQueues(sqs.client, NAMES);

    expect(second).toEqual(first);
    expect(sqs.queues.size).toBe(2);
  });

  test('falha com mensagem clara se a fila existir com atributos diferentes', async () => {
    const sqs = fakeSqs();
    sqs.queues.set(NAMES.wagerEventsDlqName, { FifoQueue: 'true', MessageRetentionPeriod: '60' });

    await expect(provisionWagerEventsQueues(sqs.client, NAMES)).rejects.toThrow(
      'já existe com atributos diferentes',
    );
  });

  test('falha se um atributo reportado divergir da definição', async () => {
    const sqs = fakeSqs({
      mutateStoredAttributes: (attributes) => {
        attributes.ContentBasedDeduplication = 'true';
      },
    });

    await expect(provisionWagerEventsQueues(sqs.client, NAMES)).rejects.toThrow(
      'diverge da definição versionada em: ContentBasedDeduplication',
    );
  });

  test('lista como não verificados os atributos que o provedor não reporta', async () => {
    const sqs = fakeSqs({
      mutateStoredAttributes: (attributes) => {
        delete attributes.MessageRetentionPeriod;
      },
    });

    const result = await provisionWagerEventsQueues(sqs.client, NAMES);

    expect(result.unverifiedAttributes).toEqual({
      main: ['MessageRetentionPeriod'],
      dlq: ['MessageRetentionPeriod'],
    });
  });

  test('sem lacunas de verificação quando o provedor reporta todos os atributos', async () => {
    const result = await provisionWagerEventsQueues(fakeSqs().client, NAMES);

    expect(result.unverifiedAttributes).toEqual({ main: [], dlq: [] });
  });
});

describe('describeWagerEventsQueues', () => {
  test('não cria filas e propaga QueueDoesNotExist', async () => {
    const sqs = fakeSqs();

    await expect(describeWagerEventsQueues(sqs.client, NAMES)).rejects.toBeInstanceOf(
      QueueDoesNotExist,
    );
    expect(sqs.calls.some((call) => call.startsWith('CreateQueue'))).toBe(false);
  });
});
