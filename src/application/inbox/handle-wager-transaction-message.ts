import { computeWagerPayloadHash } from '../payload-hash';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  type SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
  UnsupportedSubmissionError,
} from '../submit-wager-transaction';
import {
  type InboxReceipt,
  TransientPersistenceError,
  WalletNotFoundError,
} from '../wager-transaction-repository';
import { AmountOutOfStorageRangeError } from '../wallet-repository';

/** Nome do consumidor de `wager-transactions.fifo` na Inbox. */
export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions';

/** Mensagem já registrada na Inbox. */
export interface ProcessedInboxMessage {
  payloadHash: string;
  transactionId: string;
}

/** Inbox persistente (contrato §6.5). A gravação junto do efeito financeiro é do repositório de transações. */
export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<ProcessedInboxMessage | null>;
  /** Registra uma mensagem processada sem efeito novo (replay); `false` se já estava registrada. */
  record(receipt: InboxReceipt, transactionId: string): Promise<boolean>;
}

/** Mensagem `WagerTransactionRequested` já validada (forma e campos, §10). */
export interface WagerTransactionMessage {
  messageId: string;
  command: SubmitWagerTransactionCommand;
}

/**
 * Destino de uma mensagem depois do processamento:
 * - `ack`: processada (efeito confirmado, replay ou duplicata) ou rejeitada por regra de negócio;
 *   pode ser removida da fila.
 * - `retry`: falha transitória ou inesperada; nada foi confirmado e a mensagem volta à fila.
 * - `dlq`: não pode ser processada como está (conflito, wallet inexistente, tipo não suportado).
 */
export type MessageDisposition =
  | { action: 'ack'; outcome: 'processed' | 'replay' | 'duplicate'; transactionId: string }
  | { action: 'retry'; reason: string }
  | { action: 'dlq'; reason: string };

/**
 * Processa uma mensagem da fila de transações (contrato §10) com o mesmo caso de uso da API.
 *
 * 1. Inbox: `(consumerName, messageId)` já registrado → `ack` sem efeito (o mesmo conteúdo) ou `dlq`
 *    (o mesmo `messageId` com outro conteúdo).
 * 2. `SubmitWagerTransaction.execute(command, receipt)`: numa submissão nova, a Inbox é gravada na
 *    mesma transação SQL do efeito financeiro e dos eventos da outbox. Num replay pela chave de
 *    idempotência (outro `messageId`, ou corrida com uma entrega simultânea), não há efeito novo, e
 *    a Inbox é registrada sozinha.
 * 3. Erros: transitórios e inesperados → `retry` (nada foi confirmado; o limite de tentativas é o
 *    `maxReceiveCount` da fila); erros permanentes da submissão → `dlq`.
 *
 * Rejeição de negócio (ex.: saldo insuficiente) é um resultado gravado com a Inbox: `ack`.
 */
export class HandleWagerTransactionMessage {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly inbox: InboxRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly consumerName: string = WAGER_TRANSACTIONS_CONSUMER,
  ) {}

  async handle(message: WagerTransactionMessage): Promise<MessageDisposition> {
    const receipt: InboxReceipt = {
      consumerName: this.consumerName,
      messageId: message.messageId,
      payloadHash: computeWagerPayloadHash(message.command),
      receivedAt: this.now(),
    };
    try {
      const seen = await this.inbox.find(receipt.consumerName, receipt.messageId);
      if (seen !== null) {
        return seen.payloadHash === receipt.payloadHash
          ? { action: 'ack', outcome: 'duplicate', transactionId: seen.transactionId }
          : { action: 'dlq', reason: 'MESSAGE_ID_CONFLICT' };
      }

      const result = await this.submit.execute(message.command, receipt);
      if (!result.idempotentReplay) {
        return { action: 'ack', outcome: 'processed', transactionId: result.transactionId };
      }
      // Sem efeito novo: registra a mensagem para que uma reentrega pare na Inbox.
      await this.inbox.record(receipt, result.transactionId);
      return { action: 'ack', outcome: 'replay', transactionId: result.transactionId };
    } catch (error) {
      return classify(error);
    }
  }
}

function classify(error: unknown): MessageDisposition {
  if (error instanceof IdempotencyConflictError) {
    return { action: 'dlq', reason: 'IDEMPOTENCY_KEY_CONFLICT' };
  }
  if (error instanceof DuplicateExternalTransactionError) {
    return { action: 'dlq', reason: 'DUPLICATE_EXTERNAL_TRANSACTION' };
  }
  if (error instanceof WalletNotFoundError) return { action: 'dlq', reason: 'WALLET_NOT_FOUND' };
  if (error instanceof UnsupportedSubmissionError) {
    return { action: 'dlq', reason: 'UNSUPPORTED_SUBMISSION' };
  }
  if (error instanceof AmountOutOfStorageRangeError) {
    return { action: 'dlq', reason: 'INVALID_MESSAGE' };
  }
  if (error instanceof TransientPersistenceError) return { action: 'retry', reason: 'TRANSIENT' };
  // Inesperado (defeito, corrida na Inbox): nada foi confirmado. Tentar de novo é seguro, e o
  // `maxReceiveCount` da fila leva a mensagem à DLQ se a falha persistir.
  return { action: 'retry', reason: error instanceof Error ? error.name : 'UnknownError' };
}
