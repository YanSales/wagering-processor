import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { ClaimedOutboxMessage, EventPublisher } from '../application/outbox/publish-outbox';
import type { SqsSender } from './wager-events.queues';

/**
 * Publica eventos da outbox na fila FIFO de eventos (`wager-events.fifo`).
 *
 * - `MessageGroupId` = wallet: o SQS entrega em ordem dentro do grupo (§8).
 * - `MessageDeduplicationId` = `eventId`: um reenvio dentro da janela de 5 min do SQS é descartado;
 *   fora dela, o consumidor deduplica pelo `eventId` (at-least-once).
 * - Corpo = envelope gravado na outbox; `eventType` também vai como atributo, para roteamento.
 * - Cada envio tem timeout próprio, menor que a reserva do publisher, para não continuar depois de
 *   outro publisher poder assumir a wallet.
 */
export class SqsEventPublisher implements EventPublisher {
  #queueUrl: Promise<string> | undefined;

  constructor(
    private readonly client: SqsSender,
    private readonly queueName: string,
    private readonly sendTimeoutMs: number,
  ) {}

  async publish(message: ClaimedOutboxMessage): Promise<void> {
    const QueueUrl = await this.#resolveQueueUrl();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.messageGroupId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
      { abortSignal: AbortSignal.timeout(this.sendTimeoutMs) },
    );
  }

  #resolveQueueUrl(): Promise<string> {
    if (this.#queueUrl === undefined) {
      const pending = this.client
        .send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
          abortSignal: AbortSignal.timeout(this.sendTimeoutMs),
        })
        .then(({ QueueUrl }) => {
          if (QueueUrl === undefined) {
            throw new Error(`GetQueueUrl não retornou a URL da fila "${this.queueName}".`);
          }
          return QueueUrl;
        });
      // Uma falha não fica em cache: a próxima publicação tenta resolver de novo.
      pending.catch(() => {
        if (this.#queueUrl === pending) this.#queueUrl = undefined;
      });
      this.#queueUrl = pending;
    }
    return this.#queueUrl;
  }
}
