import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type {
  HandleWagerTransactionMessage,
  MessageDisposition,
} from '../application/inbox/handle-wager-transaction-message';
import { metrics } from '../observability/metrics';
import type { SqsSender } from './wager-events.queues';
import {
  InvalidWagerTransactionMessageError,
  parseWagerTransactionMessage,
} from './wager-transaction-message';

export interface WagerTransactionsConsumerOptions {
  queueName: string;
  dlqName: string;
  waitTimeSeconds: number;
  maxMessages: number;
  /** Visibilidade (s) após a primeira falha transitória; dobra a cada recebimento. 0 nos testes. */
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

/** Contagem de um lote recebido, para log e testes. */
export interface ConsumeSummary {
  received: number;
  acked: number;
  retried: number;
  deadLettered: number;
  /** Devolvidas sem processar: atrás de uma falha do mesmo grupo, ou no shutdown. */
  released: number;
  /** Ações na fila que falharam (a mensagem volta pela visibilidade). */
  queueErrors: number;
}

export type ConsumerLogger = Pick<Logger, 'log' | 'warn' | 'error'>;

/**
 * Consumidor de `wager-transactions.fifo` (contrato §10).
 *
 * - **ACK só depois do commit**: a mensagem é apagada depois de `HandleWagerTransactionMessage`
 *   devolver `ack`, isto é, depois de a transação (efeito, Inbox e outbox) ser confirmada. Se o
 *   processo cair antes do `DeleteMessage`, a mensagem volta e para na Inbox.
 * - **Falha transitória**: a mensagem não é apagada; a visibilidade passa ao backoff
 *   (`retryBaseSeconds · 2^(recebimentos − 1)`, até `retryMaxSeconds`). O limite de tentativas é o
 *   `maxReceiveCount` da redrive policy da fila: excedido, o próprio SQS a move para a DLQ.
 * - **Mensagem inválida ou erro permanente**: enviada à DLQ (com o motivo como atributo) e então
 *   apagada da fila principal, sem consumir tentativas.
 * - **Ordem por wallet**: o lote é processado em sequência. Depois de uma falha transitória num grupo,
 *   as mensagens seguintes desse grupo no lote não são processadas e voltam à fila; o SQS FIFO não
 *   entrega o grupo de novo enquanto a mensagem que falhou estiver em voo.
 * - **Shutdown**: termina a mensagem em andamento e devolve as demais do lote (visibilidade 0).
 */
export class WagerTransactionsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  #queueUrl: string | undefined;
  #dlqUrl: string | undefined;
  #loop: Promise<void> | undefined;
  #stopped = false;

  constructor(
    private readonly client: SqsSender,
    private readonly handler: Pick<HandleWagerTransactionMessage, 'handle'>,
    private readonly options: WagerTransactionsConsumerOptions,
    private readonly logger: ConsumerLogger = new Logger('WagerTransactionsConsumer'),
    private readonly dispose: () => void = () => undefined,
  ) {}

  onApplicationBootstrap(): void {
    this.#loop = this.#run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.#stopped = true;
    await this.#loop;
    this.dispose();
  }

  /** Recebe e processa um lote. Erros de recebimento sobem; os de cada mensagem não. */
  async pollOnce(): Promise<ConsumeSummary> {
    const queueUrl = await this.#url('queue');
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    const summary: ConsumeSummary = {
      received: Messages.length,
      acked: 0,
      retried: 0,
      deadLettered: 0,
      released: 0,
      queueErrors: 0,
    };
    const blockedGroups = new Set<string>();

    for (const message of Messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      if (this.#stopped || blockedGroups.has(group)) {
        await this.#queueAction(summary, () => this.#setVisibility(message, 0));
        summary.released += 1;
        continue;
      }
      const disposition = await metrics.processingDuration.time({ channel: 'sqs' }, () =>
        this.#dispose(message),
      );
      if (disposition.action === 'ack') {
        if (disposition.outcome === 'duplicate') {
          metrics.duplicates.inc({ channel: 'sqs', type: 'inbox' });
        } else if (disposition.outcome === 'replay') {
          metrics.duplicates.inc({ channel: 'sqs', type: 'idempotency_replay' });
        }
        if (await this.#queueAction(summary, () => this.#delete(message))) summary.acked += 1;
      } else if (disposition.action === 'dlq') {
        const moved = await this.#queueAction(summary, async () => {
          await this.#sendToDlq(message, disposition.reason);
          await this.#delete(message);
        });
        if (moved) {
          summary.deadLettered += 1;
          metrics.deadLettered.inc({ reason: disposition.reason });
        }
        this.#logMessage('warn', 'wager_message_dead_lettered', message, disposition.reason);
      } else {
        blockedGroups.add(group);
        await this.#queueAction(summary, () =>
          this.#setVisibility(message, this.#retryDelay(message)),
        );
        summary.retried += 1;
        metrics.retries.inc({ component: 'sqs_consumer' });
        this.#logMessage('warn', 'wager_message_retry', message, disposition.reason);
      }
    }
    return summary;
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      try {
        const summary = await this.pollOnce();
        if (summary.received > 0) {
          this.logger.log(JSON.stringify({ event: 'wager_messages_batch', ...summary }));
        }
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'wager_messages_receive_failed',
            error: error instanceof Error ? error.name : 'unknown',
          }),
        );
        // Fila ou rede indisponível: espera antes de tentar de novo, sem laço apertado.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  async #dispose(message: Message): Promise<MessageDisposition> {
    let parsed: ReturnType<typeof parseWagerTransactionMessage>;
    try {
      parsed = parseWagerTransactionMessage(message.Body);
    } catch (error) {
      if (error instanceof InvalidWagerTransactionMessageError) {
        return { action: 'dlq', reason: 'INVALID_MESSAGE' };
      }
      throw error;
    }
    return this.handler.handle(parsed);
  }

  #retryDelay(message: Message): number {
    const received = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const exponent = Math.max(0, Math.min(Number.isFinite(received) ? received - 1 : 0, 30));
    return Math.min(this.options.retryBaseSeconds * 2 ** exponent, this.options.retryMaxSeconds);
  }

  /** `true` se a ação foi aceita; uma falha só é contada (a visibilidade devolve a mensagem). */
  async #queueAction(summary: ConsumeSummary, action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      summary.queueErrors += 1;
      this.logger.error(
        JSON.stringify({
          event: 'wager_message_queue_action_failed',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return false;
    }
  }

  async #delete(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.#url('queue'),
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  async #setVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.#url('queue'),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async #sendToDlq(message: Message, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.#url('dlq'),
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid',
        // O id da mensagem no SQS: um reenvio à DLQ (queda antes do delete) é deduplicado.
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason } },
      }),
    );
  }

  async #url(which: 'queue' | 'dlq'): Promise<string> {
    const cached = which === 'queue' ? this.#queueUrl : this.#dlqUrl;
    if (cached !== undefined) return cached;
    const QueueName = which === 'queue' ? this.options.queueName : this.options.dlqName;
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName }));
    if (QueueUrl === undefined)
      throw new Error(`GetQueueUrl não retornou a URL de "${QueueName}".`);
    if (which === 'queue') this.#queueUrl = QueueUrl;
    else this.#dlqUrl = QueueUrl;
    return QueueUrl;
  }

  #logMessage(level: 'warn', event: string, message: Message, reason: string): void {
    // Identificadores e motivo apenas; sem corpo nem valores (§12).
    this.logger[level](
      JSON.stringify({
        event,
        sqsMessageId: message.MessageId,
        walletId: message.Attributes?.MessageGroupId,
        receiveCount: message.Attributes?.ApproximateReceiveCount,
        reason,
      }),
    );
  }
}
