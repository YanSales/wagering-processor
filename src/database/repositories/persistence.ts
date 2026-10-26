import type { EntityManager } from '@mikro-orm/core';
import type { OutboxMessage } from '../../application/outbox/outbox-message';
import type { InboxReceipt } from '../../application/wager-transaction-repository';
import { AmountOutOfStorageRangeError } from '../../application/wallet-repository';
import type { Money } from '../../domain/money';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { WagerTransactionRecord } from '../schema/wager-transaction.schema';
import type { WalletRecord } from '../schema/wallet.schema';

/** Faixa das colunas `bigint` (inteiro de 64 bits com sinal) do PostgreSQL, em centavos. */
export const PG_BIGINT_MIN = -9_223_372_036_854_775_808n;
export const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

/** Recusa, antes de gravar, um valor que a coluna `bigint` não comporta. */
export function assertStorable(money: Money): void {
  if (money.cents < PG_BIGINT_MIN || money.cents > PG_BIGINT_MAX) {
    throw new AmountOutOfStorageRangeError(money, PG_BIGINT_MIN, PG_BIGINT_MAX);
  }
}

/** Campos de persistência que o domínio não carrega. */
export interface TransactionRecordExtras {
  /** Correlação da operação que cria a transação; os eventos posteriores a reutilizam. */
  correlationId: string;
  /** Linha da referência resolvida (o id interno vem de `transaction.referenceTransactionId`). */
  referenceTransaction?: WagerTransactionRecord | null;
  /** Próxima tentativa de resolução, somente em `PENDING_REFERENCE` (§7.1). */
  nextReferenceAttemptAt?: Date | null;
}

/**
 * Linha de `wager_transactions` a partir do domínio. `resultBalance` é o saldo da wallet observado ao
 * concluir a transação (contrato §7, regra 7); a `OPENING` não o registra.
 */
export function toTransactionRecord(
  transaction: WagerTransaction,
  wallet: WalletRecord,
  resultBalance: Money | null,
  extras: TransactionRecordExtras,
): WagerTransactionRecord {
  return {
    id: transaction.id,
    wallet,
    playerId: transaction.playerId,
    kind: transaction.kind,
    status: transaction.status,
    providerId: transaction.providerId ?? null,
    externalTransactionId: transaction.externalTransactionId ?? null,
    idempotencyKey: transaction.idempotencyKey ?? null,
    payloadHash: transaction.payloadHash ?? null,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    moneyCents: transaction.money.cents,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    // Só uma reversão aplicada aponta para a referência: o índice de reversão única (§7, regra 4)
    // não pode ser ocupado por uma rejeição.
    referenceTransaction: extras.referenceTransaction ?? null,
    failureCode: transaction.failureCode ?? null,
    resultBalanceCents: resultBalance === null ? null : resultBalance.cents,
    referenceAttempts: 0,
    nextReferenceAttemptAt: extras.nextReferenceAttemptAt ?? null,
    processingFailures: 0,
    correlationId: extras.correlationId,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

/**
 * Insere o lançamento com SQL cru no contexto transacional do `em`
 * (`em.getTransactionContext()`). Os placeholders `?` são substituídos
 * pelo MikroORM no cliente, com os valores formatados e escapados; eles
 * não são enviados ao PostgreSQL como parâmetros separados.
 *
 * O MikroORM 7.2.5 não preenche a FK composta `(wallet_id, currency) ->
 * wallets (id, currency)` (que não é a PK): envia `currency` como
 * `undefined`. Todo lançamento usa este caminho.
 */
export async function insertLedgerEntry(
  em: EntityManager,
  entry: WalletLedgerEntry,
): Promise<void> {
  try {
    await em.getConnection().execute(
      `insert into "wallet_ledger_entries" ("id", "wallet_id", "currency", "transaction_id", "direction",
         "money_cents", "balance_before_cents", "balance_after_cents", "created_at")
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        // Moeda do próprio lançamento: a FK composta confere que é a da wallet.
        entry.money.currency,
        entry.transactionId,
        entry.direction,
        entry.money.cents.toString(),
        entry.balanceBefore.cents.toString(),
        entry.balanceAfter.cents.toString(),
        entry.createdAt,
      ],
      'run',
      em.getTransactionContext(),
    );
  } catch (error) {
    // O SQL cru não passa pelo conversor do ORM; converte para o mesmo tipo que o `flush` lança.
    throw em.getDriver().convertException(error as Error);
  }
}

/**
 * Grava a mensagem processada na Inbox, no contexto transacional do `em` (contrato §6.5): confirmada
 * no mesmo commit da alteração financeira. Uma mensagem já registrada viola a PK
 * `(consumer_name, message_id)` e desfaz a transação inteira.
 */
export async function insertInboxMessage(
  em: EntityManager,
  inbox: InboxReceipt,
  transactionId: string,
): Promise<void> {
  try {
    await em.getConnection().execute(
      `insert into "inbox_messages" ("consumer_name", "message_id", "payload_hash",
         "transaction_id", "received_at", "processed_at")
       values (?, ?, ?, ?, ?, now())`,
      [inbox.consumerName, inbox.messageId, inbox.payloadHash, transactionId, inbox.receivedAt],
      'run',
      em.getTransactionContext(),
    );
  } catch (error) {
    throw em.getDriver().convertException(error as Error);
  }
}

/**
 * Grava os eventos na outbox, no contexto transacional do `em` (contrato §11): confirmados no mesmo
 * commit da alteração financeira, ou desfeitos com ela. Nada é publicado aqui.
 *
 * Um `INSERT` por evento, na ordem recebida: o `seq` acompanha essa ordem (`Processed` antes de
 * `WalletBalanceChanged`). `next_attempt_at` usa o relógio do banco, para que o evento fique elegível
 * assim que for confirmado. O payload é o envelope serializado (`MoneyProps`, sem `bigint`); o `jsonb`
 * preserva o conteúdo, não a ordem das chaves.
 */
export async function insertOutboxMessages(
  em: EntityManager,
  messages: readonly OutboxMessage[],
): Promise<void> {
  for (const message of messages) {
    try {
      await em.getConnection().execute(
        `insert into "outbox_messages" ("id", "transaction_id", "aggregate_id", "event_type",
           "event_version", "message_group_id", "correlation_id", "payload", "occurred_at",
           "next_attempt_at")
         values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, now())`,
        [
          message.id,
          message.transactionId,
          message.aggregateId,
          message.eventType,
          message.eventVersion,
          message.messageGroupId,
          message.correlationId,
          JSON.stringify(message.payload),
          message.occurredAt,
        ],
        'run',
        em.getTransactionContext(),
      );
    } catch (error) {
      throw em.getDriver().convertException(error as Error);
    }
  }
}
