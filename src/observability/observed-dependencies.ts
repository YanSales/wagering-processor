import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { OnApplicationShutdown } from '@nestjs/common';
import { readOutboxPublisherSettings } from '../messaging/outbox-publisher.config';
import { createSqsClient, readSqsSettings } from '../messaging/sqs.config';
import { readWagerTransactionsConsumerSettings } from '../messaging/wager-transactions-consumer.config';
import {
  checkReadiness,
  type DependencyCheck,
  postgresCheck,
  READINESS_TIMEOUT_MS,
  type ReadinessReport,
  sqsQueuesCheck,
} from './readiness';

/**
 * Dependências observadas pelo readiness e pelas métricas. O SQS só entra quando o publisher da
 * outbox ou o consumidor estão habilitados nesta instância, e só as filas que eles usam; desligados,
 * a configuração do SQS não é lida.
 */
export class ObservedDependencies implements OnApplicationShutdown {
  constructor(
    private readonly checks: readonly DependencyCheck[],
    private readonly disabled: readonly string[],
    /** DLQ da entrada, quando o consumidor está habilitado (gauge de mensagens na DLQ). */
    private readonly dlq: { client: SQSClient; queueName: string } | null,
    private readonly dispose: () => void = () => undefined,
  ) {}

  readiness(): Promise<ReadinessReport> {
    return checkReadiness(this.checks, this.disabled);
  }

  /** Mensagens na DLQ da entrada; `null` sem consumidor; lança se o SQS não responder. */
  async dlqDepth(): Promise<{ queue: string; messages: number } | null> {
    if (this.dlq === null) return null;
    const { client, queueName } = this.dlq;
    const signal = { abortSignal: AbortSignal.timeout(READINESS_TIMEOUT_MS) };
    const { QueueUrl } = await client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
      signal,
    );
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
      signal,
    );
    const messages =
      Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    return { queue: queueName, messages };
  }

  onApplicationShutdown(): void {
    this.dispose();
  }
}

export function createObservedDependencies(
  orm: MikroORM,
  env: Record<string, string | undefined> = process.env,
): ObservedDependencies {
  const publisher = readOutboxPublisherSettings(env);
  const consumer = readWagerTransactionsConsumerSettings(env);
  const checks: DependencyCheck[] = [postgresCheck(orm)];
  if (!publisher.enabled && !consumer.enabled) {
    return new ObservedDependencies(checks, ['sqs'], null);
  }

  const sqs = readSqsSettings(env);
  const client = createSqsClient(sqs);
  const queues = [
    ...(publisher.enabled ? [sqs.wagerEventsQueueName] : []),
    ...(consumer.enabled ? [consumer.queueName, consumer.dlqName] : []),
  ];
  checks.push(sqsQueuesCheck(client, queues));
  return new ObservedDependencies(
    checks,
    [],
    consumer.enabled ? { client, queueName: consumer.dlqName } : null,
    () => client.destroy(),
  );
}
