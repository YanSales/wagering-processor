import { assertMovementPreconditions } from './bet';
import { CurrencyMismatchError } from './money';
import { ReferenceAlreadyReversedError } from './refund';
import { applyReversal, type ReversalOutcome } from './reversal';
import { validateReference } from './transaction-reference';
import { type WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';

export interface RollbackInput {
  /** ROLLBACK em `PENDING` (submissão) ou `PENDING_REFERENCE` (reprocessamento). */
  transaction: WagerTransaction;
  /** BET, WIN ou REFUND resolvida por `(providerId, referenceExternalTransactionId)`, ou `undefined`. */
  reference: WagerTransaction | undefined;
  /**
   * `true` se a referência já foi revertida por um ROLLBACK aplicado (§7, regra 4). Vem da
   * persistência, sob o lock da wallet; o índice único do banco é a garantia final.
   */
  alreadyRolledBack: boolean;
  wallet: Wallet;
  ledgerEntryId: string;
  at: Date;
}

/**
 * Aplica um ROLLBACK (contrato §7: "inverso da referência", 1 lançamento invertido; reverte uma
 * BET, WIN ou REFUND `PROCESSED`, uma única vez, pelo mesmo valor).
 *
 * - Pré-condições independentes da referência: wallet do mesmo player e moeda da wallet.
 * - Referência ausente: `PENDING_REFERENCE` (regra 8), sem movimento.
 * - Referência presente: validada (regras 2, 3 e 5) e pela regra 4; válida, movimenta a wallet no
 *   sentido inverso ao da referência (BET → crédito; WIN ou REFUND → débito) e marca `PROCESSED`.
 * - Débito que deixaria o saldo negativo: `ReversalWouldOverdrawError` (regra 9), distinto do saldo
 *   insuficiente de uma BET.
 *
 * Toda validação ocorre antes de qualquer mutação. Rejeitar com `failureCode`, contar tentativas e
 * rejeitar por esgotamento cabem ao processamento, como no REFUND.
 */
export function applyRollback(input: RollbackInput): ReversalOutcome {
  const { transaction, wallet, reference } = input;
  assertMovementPreconditions(transaction, wallet, WagerTransactionKind.Rollback, 'applyRollback');
  if (transaction.money.currency !== wallet.currency) {
    throw new CurrencyMismatchError('reverter', wallet.currency, transaction.money.currency);
  }

  if (reference !== undefined) {
    validateReference(transaction, reference);
    if (input.alreadyRolledBack) throw new ReferenceAlreadyReversedError(transaction, reference);
  }
  return applyReversal({
    transaction,
    reference,
    wallet,
    ledgerEntryId: input.ledgerEntryId,
    at: input.at,
  });
}
