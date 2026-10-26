import { assertMovementPreconditions } from './bet';
import { CurrencyMismatchError } from './money';
import { applyReversal, type ReversalOutcome } from './reversal';
import { validateReference } from './transaction-reference';
import { type WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';

export interface RefundInput {
  /** REFUND em `PENDING` (submissão) ou `PENDING_REFERENCE` (reprocessamento). */
  transaction: WagerTransaction;
  /** BET resolvida por `(providerId, referenceExternalTransactionId)`, ou `undefined` se ausente. */
  reference: WagerTransaction | undefined;
  /**
   * `true` se a referência já foi revertida por um REFUND aplicado (§7, regra 4). Vem da persistência,
   * que o consulta sob o lock da wallet; o índice único do banco é a garantia final.
   */
  alreadyRefunded: boolean;
  /** Wallet da transação, já protegida contra concorrência pela persistência. */
  wallet: Wallet;
  /** Id do lançamento a criar, fornecido pelo chamador. */
  ledgerEntryId: string;
  at: Date;
}

/**
 * Aplica um REFUND (contrato §7: crédito, 1 lançamento `CREDIT`, "reverte uma BET `PROCESSED`, uma
 * única vez").
 *
 * - Pré-condições independentes da referência, verificadas primeiro: wallet do mesmo player
 *   (`WalletPlayerMismatchError`) e moeda da wallet (`CurrencyMismatchError`, §6.2).
 * - Referência ausente: a transação vai (ou continua) em `PENDING_REFERENCE` (regra 8), sem
 *   movimento.
 * - Referência presente: validada por `validateReference` (regras 2, 3 e 5; `InvalidReferenceError`)
 *   e pela regra 4 (`ReferenceAlreadyReversedError`); válida, credita a wallet e marca `PROCESSED`
 *   com o id interno da BET (`applyReversal`).
 *
 * Toda validação ocorre antes de qualquer mutação. Converter os erros em `REJECTED` com `failureCode`
 * (§7.2), contar tentativas e rejeitar por esgotamento (§7.1) cabem ao processamento. Um REFUND é
 * crédito: a regra 9 (reversão que deixaria saldo negativo) não se aplica.
 */
export function applyRefund(input: RefundInput): ReversalOutcome {
  const { transaction, wallet, reference } = input;
  assertMovementPreconditions(transaction, wallet, WagerTransactionKind.Refund, 'applyRefund');
  if (transaction.money.currency !== wallet.currency) {
    throw new CurrencyMismatchError('reembolsar', wallet.currency, transaction.money.currency);
  }

  if (reference !== undefined) {
    validateReference(transaction, reference);
    if (input.alreadyRefunded) throw new ReferenceAlreadyReversedError(transaction, reference);
  }
  return applyReversal({
    transaction,
    reference,
    wallet,
    ledgerEntryId: input.ledgerEntryId,
    at: input.at,
  });
}

/**
 * A referência já foi revertida pelo mesmo tipo de operação (contrato §7, regra 4). Erro de negócio:
 * a transação deve ser rejeitada. Wallet e transação inalteradas.
 */
export class ReferenceAlreadyReversedError extends Error {
  override readonly name = 'ReferenceAlreadyReversedError';
  readonly transactionId: string;
  readonly referenceId: string;

  constructor(transaction: WagerTransaction, reference: WagerTransaction) {
    super(
      `${reference.kind} ${reference.id} já foi revertida por ${transaction.kind}; ` +
        `${transaction.id} não pode revertê-la de novo.`,
    );
    this.transactionId = transaction.id;
    this.referenceId = reference.id;
  }
}
