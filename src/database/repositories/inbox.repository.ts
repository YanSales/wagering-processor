import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  InboxRepository,
  ProcessedInboxMessage,
} from '../../application/inbox/handle-wager-transaction-message';
import type { InboxReceipt } from '../../application/wager-transaction-repository';

/**
 * Inbox sobre PostgreSQL (`inbox_messages`). A gravação junto da alteração financeira é feita por
 * `MikroOrmWagerTransactionRepository` (`insertInboxMessage`), na transação da submissão; aqui ficam a
 * consulta e o registro de mensagens processadas sem efeito novo (replay).
 */
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly orm: MikroORM) {}

  async find(consumerName: string, messageId: string): Promise<ProcessedInboxMessage | null> {
    const [row] = (await this.orm.em
      .getConnection()
      .execute(
        'select payload_hash, transaction_id from inbox_messages where consumer_name = ? and message_id = ?',
        [consumerName, messageId],
      )) as { payload_hash: string; transaction_id: string }[];
    return row === undefined
      ? null
      : { payloadHash: row.payload_hash, transactionId: row.transaction_id };
  }

  async record(receipt: InboxReceipt, transactionId: string): Promise<boolean> {
    const rows = (await this.orm.em.getConnection().execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, transaction_id,
         received_at, processed_at)
       values (?, ?, ?, ?, ?, now())
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [
        receipt.consumerName,
        receipt.messageId,
        receipt.payloadHash,
        transactionId,
        receipt.receivedAt,
      ],
      'all',
    )) as unknown[];
    return rows.length === 1;
  }
}
