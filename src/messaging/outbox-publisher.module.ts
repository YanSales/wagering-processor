import { MikroORM } from '@mikro-orm/postgresql';
import { Logger, Module } from '@nestjs/common';
import { OutboxRetryPolicy } from '../application/outbox/outbox-retry-policy';
import { PublishOutbox } from '../application/outbox/publish-outbox';
import { MikroOrmOutboxRepository } from '../database/repositories/outbox.repository';
import { readOutboxPublisherSettings } from './outbox-publisher.config';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { createSqsClient, readSqsSettings } from './sqs.config';
import { SqsEventPublisher } from './sqs-event-publisher';

/**
 * Publisher da Transactional Outbox para a fila FIFO de eventos. Desligado por padrão
 * (`OUTBOX_PUBLISHER_ENABLED`): só quando ligado a configuração do SQS é lida e o cliente é criado,
 * para que a API e o worker de `PENDING_REFERENCE` não dependam do broker para iniciar.
 */
@Module({
  providers: [
    {
      provide: OutboxPublisherWorker,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): OutboxPublisherWorker => {
        const settings = readOutboxPublisherSettings();
        const logger = new Logger('OutboxPublisher');
        if (!settings.enabled) return new OutboxPublisherWorker(null, settings.pollIntervalMs);

        const sqs = readSqsSettings();
        const client = createSqsClient(sqs);
        const publisher = new PublishOutbox(
          new MikroOrmOutboxRepository(orm),
          new SqsEventPublisher(client, sqs.wagerEventsQueueName, settings.sendTimeoutMs),
          {
            maxGroups: settings.maxGroups,
            maxPerGroup: settings.maxPerGroup,
            leaseMs: settings.leaseMs,
            policy: OutboxRetryPolicy.from(settings.retry),
            // Só identificadores e o tipo do erro (§12).
            onError: (message, error) =>
              logger.warn(
                JSON.stringify({
                  event: 'outbox_publish_failed',
                  eventId: message.id,
                  eventType: message.eventType,
                  walletId: message.messageGroupId,
                  attempts: message.attempts + 1,
                  error: error instanceof Error ? error.name : 'unknown',
                }),
              ),
          },
        );
        return new OutboxPublisherWorker(publisher, settings.pollIntervalMs, logger, () =>
          client.destroy(),
        );
      },
    },
  ],
})
export class OutboxPublisherModule {}
