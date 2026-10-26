import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueNameExists,
  type SQSClient,
} from '@aws-sdk/client-sqs';

/**
 * Definição versionada das filas de eventos de apostas e do seu provisionamento.
 *
 * - Fila principal FIFO com redrive para uma DLQ FIFO após `WAGER_EVENTS_MAX_RECEIVE_COUNT`
 *   recebimentos sem exclusão.
 * - `ContentBasedDeduplication` desligado: todo envio deve informar `MessageDeduplicationId`
 *   explicitamente. A deduplicação do SQS vale só numa janela de 5 minutos e não substitui a
 *   idempotência da aplicação.
 * - A DLQ apenas isola mensagens que falharam repetidamente; reprocessá-las ou descartá-las é uma
 *   decisão operacional ainda não implementada.
 */
export const WAGER_EVENTS_MAX_RECEIVE_COUNT = 5;
export const WAGER_EVENTS_VISIBILITY_TIMEOUT_SECONDS = 30;
/** 4 dias, o padrão do SQS. */
export const WAGER_EVENTS_RETENTION_SECONDS = 345_600;
/** 14 dias, o máximo do SQS: a DLQ deve reter mensagens por mais tempo que a fila de origem. */
export const WAGER_EVENTS_DLQ_RETENTION_SECONDS = 1_209_600;

export type SqsSender = Pick<SQSClient, 'send'>;

export interface WagerEventsQueueNames {
  wagerEventsQueueName: string;
  wagerEventsDlqName: string;
}

export interface QueueDescription {
  name: string;
  url: string;
  attributes: Record<string, string>;
}

export interface WagerEventsQueuesDescription {
  main: QueueDescription;
  dlq: QueueDescription;
}

export interface ProvisionedWagerEventsQueues extends WagerEventsQueuesDescription {
  /**
   * Atributos definidos que o provedor aceitou, mas não reporta em `GetQueueAttributes` e que,
   * portanto, não puderam ser conferidos. O MiniStack reporta todos; outros emuladores podem omitir
   * `MessageRetentionPeriod`.
   */
  unverifiedAttributes: { main: string[]; dlq: string[] };
}

export function dlqAttributes(): Record<string, string> {
  return {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    MessageRetentionPeriod: String(WAGER_EVENTS_DLQ_RETENTION_SECONDS),
  };
}

export function mainQueueAttributes(dlqArn: string): Record<string, string> {
  return {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: String(WAGER_EVENTS_VISIBILITY_TIMEOUT_SECONDS),
    MessageRetentionPeriod: String(WAGER_EVENTS_RETENTION_SECONDS),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: WAGER_EVENTS_MAX_RECEIVE_COUNT,
    }),
  };
}

/**
 * Cria (ou reutiliza) a DLQ e a fila principal e confere os atributos resultantes.
 *
 * Idempotente: `CreateQueue` com os mesmos atributos devolve a fila existente. Se a fila existir
 * com atributos diferentes, ou se um atributo reportado divergir da definição, falha em vez de
 * alterar a fila silenciosamente. Atributos não reportados pelo provedor são devolvidos em
 * `unverifiedAttributes`.
 */
export async function provisionWagerEventsQueues(
  client: SqsSender,
  names: WagerEventsQueueNames,
): Promise<ProvisionedWagerEventsQueues> {
  const dlqUrl = await createQueue(client, names.wagerEventsDlqName, dlqAttributes());
  const dlqArn = await getQueueArn(client, dlqUrl);
  const expectedMain = mainQueueAttributes(dlqArn);
  await createQueue(client, names.wagerEventsQueueName, expectedMain);

  const description = await describeWagerEventsQueues(client, names);
  return {
    ...description,
    unverifiedAttributes: {
      dlq: verifyAttributes(description.dlq, dlqAttributes()),
      main: verifyAttributes(description.main, expectedMain),
    },
  };
}

/** Consulta as filas sem criá-las. Falha com `QueueDoesNotExist` se alguma não existir. */
export async function describeWagerEventsQueues(
  client: SqsSender,
  names: WagerEventsQueueNames,
): Promise<WagerEventsQueuesDescription> {
  const main = await describeQueue(client, names.wagerEventsQueueName);
  const dlq = await describeQueue(client, names.wagerEventsDlqName);
  return { main, dlq };
}

async function createQueue(
  client: SqsSender,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  let queueUrl: string | undefined;
  try {
    ({ QueueUrl: queueUrl } = await client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    ));
  } catch (error) {
    if (error instanceof QueueNameExists) {
      throw new Error(
        `A fila "${name}" já existe com atributos diferentes da definição versionada. ` +
          'Revise a fila manualmente; o provisionamento não altera filas existentes.',
      );
    }
    throw error;
  }
  if (queueUrl === undefined) {
    throw new Error(`CreateQueue não retornou a URL da fila "${name}".`);
  }
  return queueUrl;
}

async function getQueueArn(client: SqsSender, queueUrl: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = Attributes?.QueueArn;
  if (arn === undefined) {
    throw new Error(`GetQueueAttributes não retornou o ARN de ${queueUrl}.`);
  }
  return arn;
}

async function describeQueue(client: SqsSender, name: string): Promise<QueueDescription> {
  const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (QueueUrl === undefined) {
    throw new Error(`GetQueueUrl não retornou a URL da fila "${name}".`);
  }
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }),
  );
  return { name, url: QueueUrl, attributes: Attributes ?? {} };
}

/** Falha se um atributo reportado divergir; devolve os atributos que o provedor não reporta. */
function verifyAttributes(queue: QueueDescription, expected: Record<string, string>): string[] {
  const reported = Object.entries(expected).filter(([key]) => queue.attributes[key] !== undefined);
  const divergent = reported
    .filter(([key, value]) => normalize(key, queue.attributes[key]) !== normalize(key, value))
    .map(([key]) => key);
  if (divergent.length > 0) {
    throw new Error(
      `A fila "${queue.name}" diverge da definição versionada em: ${divergent.join(', ')}.`,
    );
  }
  return Object.keys(expected).filter((key) => queue.attributes[key] === undefined);
}

// O SQS devolve a RedrivePolicy como JSON com `maxReceiveCount` numérico; compare o conteúdo.
function normalize(key: string, value: string | undefined): string | undefined {
  if (key !== 'RedrivePolicy' || value === undefined) {
    return value;
  }
  const policy = JSON.parse(value) as { deadLetterTargetArn?: unknown; maxReceiveCount?: unknown };
  return `${String(policy.deadLetterTargetArn)}|${Number(policy.maxReceiveCount)}`;
}
