import { SQSClient } from '@aws-sdk/client-sqs';
import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { createSqsClient, readSqsSettings, type SqsSettings } from './sqs.config';
import { describeWagerEventsQueues } from './wager-events.queues';

export const SQS_SETTINGS = Symbol('SQS_SETTINGS');

export type QueueAccessCheck =
  | { ok: true; queueUrls: { main: string; dlq: string } }
  | { ok: false; reason: string };

/**
 * Acesso mínimo às filas de eventos de apostas. Não publica nem consome mensagens: apenas confere
 * que as filas configuradas existem e estão acessíveis (base para o futuro `/health/ready`).
 */
export class WagerEventsQueues implements OnApplicationShutdown {
  constructor(
    private readonly settings: SqsSettings,
    private readonly client: SQSClient,
  ) {}

  async checkAccess(): Promise<QueueAccessCheck> {
    try {
      const { main, dlq } = await describeWagerEventsQueues(this.client, this.settings);
      return { ok: true, queueUrls: { main: main.url, dlq: dlq.url } };
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return { ok: false, reason };
    }
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

/**
 * Infraestrutura de mensageria. A configuração é validada na inicialização do módulo; o cliente
 * SQS não abre conexões até o primeiro comando. Ainda não é importado pelo `AppModule`: entra junto
 * com o primeiro uso real (publicação de eventos).
 */
@Module({
  providers: [
    { provide: SQS_SETTINGS, useFactory: (): SqsSettings => readSqsSettings() },
    {
      provide: SQSClient,
      inject: [SQS_SETTINGS],
      useFactory: (settings: SqsSettings): SQSClient => createSqsClient(settings),
    },
    {
      provide: WagerEventsQueues,
      inject: [SQS_SETTINGS, SQSClient],
      useFactory: (settings: SqsSettings, client: SQSClient): WagerEventsQueues =>
        new WagerEventsQueues(settings, client),
    },
  ],
  exports: [WagerEventsQueues],
})
export class MessagingModule {}
