import { EntitySchema } from '@mikro-orm/core';

/** Linha persistida de `inbox_messages` (modelo de persistência, separado do domínio). */
export class InboxMessageRecord {
  /** Consumidor que processou a mensagem (`wager-transactions`). */
  consumerName!: string;
  /** `messageId` do envelope da mensagem: estável entre reentregas e reenvios. */
  messageId!: string;
  /** Hash canônico da submissão (`computeWagerPayloadHash`): o mesmo `messageId` com outro conteúdo é conflito. */
  payloadHash!: string;
  /** Transação de negócio resultante (nova ou já existente, num replay). */
  transactionId!: string;
  receivedAt!: Date;
  processedAt!: Date;
}

/**
 * Inbox idempotente do consumidor SQS (contrato §6.5 e §10). Uma linha por `(consumer_name,
 * message_id)`, gravada somente quando a mensagem foi processada: na mesma transação SQL da
 * alteração financeira (submissão nova) ou, num replay sem efeito, sozinha. Mensagens enviadas à DLQ
 * não são registradas, para que possam ser reprocessadas depois de corrigidas.
 */
export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'text' },
    transactionId: { type: 'uuid' },
    receivedAt: { type: 'timestamptz' },
    processedAt: { type: 'timestamptz' },
  },
});
