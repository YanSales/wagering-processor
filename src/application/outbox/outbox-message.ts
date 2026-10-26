import type { IntegrationEvent, IntegrationEventEnvelope } from '../events/integration-event';
import type { TransactionEvent } from '../events/transaction-events';

/** Tipos de evento gravados na outbox (contrato §11, eventos mínimos). */
export const OUTBOX_EVENT_TYPES = [
  'WagerTransactionProcessed',
  'WagerTransactionRejected',
  'WagerTransactionPendingReference',
  'WalletBalanceChanged',
] as const satisfies readonly TransactionEvent['eventType'][];

/** Todo evento de outbox identifica a wallet (grupo FIFO) e a transação de origem no `data`. */
interface OutboxEventData {
  walletId: string;
  transactionId: string;
}

/**
 * Evento enfileirado para publicação (contrato §6.5). Nasce da serialização do evento de integração,
 * e o `payload` é esse envelope, imutável: uma republicação envia exatamente os mesmos bytes lógicos,
 * com o mesmo `eventId`, para que o consumidor reconheça a duplicata.
 *
 * Só o enfileiramento existe nesta etapa. Publicação, tentativas e lease (`markPublished`,
 * `scheduleRetry`, `isDue`) entram com o publisher.
 */
export class OutboxMessage {
  readonly #occurredAt: Date;

  private constructor(
    readonly id: string,
    readonly transactionId: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly eventVersion: number,
    /** Grupo FIFO: a wallet, unidade de ordenação (§8). */
    readonly messageGroupId: string,
    readonly correlationId: string,
    readonly payload: Readonly<IntegrationEventEnvelope<string, OutboxEventData>>,
    occurredAt: Date,
  ) {
    this.#occurredAt = new Date(occurredAt.getTime());
    Object.freeze(this);
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt.getTime());
  }

  static enqueue(event: IntegrationEvent<string, OutboxEventData>): OutboxMessage {
    // `toJSON()` já devolve uma cópia; o congelamento impede alterar o snapshot depois daqui.
    const payload = deepFreeze(event.toJSON());
    return new OutboxMessage(
      payload.eventId,
      payload.data.transactionId,
      payload.aggregateId,
      payload.eventType,
      payload.version,
      payload.data.walletId,
      payload.correlationId,
      payload,
      event.occurredAt,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
