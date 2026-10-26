import { applyRefund } from '../domain/refund';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { FailureCodes, refundFailureCodeFor } from './failure-codes';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import type { ResolvedReference, SubmissionDecision } from './wager-transaction-repository';

export interface RefundAttempt {
  /** REFUND em `PENDING` (submissão) ou `PENDING_REFERENCE` (worker). */
  transaction: WagerTransaction;
  /** Wallet travada pela persistência. */
  wallet: Wallet;
  /** BET lida sob o mesmo lock, ou `null` se ainda não existe. */
  reference: ResolvedReference | null;
  /** Tentativas do worker contando esta (0 na submissão). */
  attempts: number;
  ledgerEntryId: string;
  at: Date;
  policy: ReferenceRetryPolicy;
}

/**
 * Decide um REFUND sobre a wallet travada; usada pela submissão e pelo worker do §7.1, para que as
 * duas entradas apliquem a mesma regra.
 *
 * - Referência válida: crédito e `PROCESSED` (§7, tabela).
 * - Referência existente, mas inválida, ou violação independente da referência: `REJECTED` com o
 *   `failureCode` correspondente, de imediato e sem lançamento (§7, regra 6).
 * - Referência ausente: `PENDING_REFERENCE` com a próxima tentativa (regra 8); esgotado o limite,
 *   `REJECTED` com `REFERENCE_NOT_FOUND` (§7.1).
 *
 * Erros que não são de negócio sobem e desfazem a transação SQL inteira.
 */
export function decideRefund(attempt: RefundAttempt): SubmissionDecision {
  const { transaction, wallet, reference, policy } = attempt;
  try {
    const outcome = applyRefund({
      transaction,
      reference: reference?.transaction,
      alreadyRefunded: reference?.alreadyReversed ?? false,
      wallet,
      ledgerEntryId: attempt.ledgerEntryId,
      at: attempt.at,
    });
    if (outcome.outcome === 'PROCESSED') {
      return { transaction, wallet, ledgerEntry: outcome.ledgerEntry };
    }
  } catch (error) {
    const code = refundFailureCodeFor(error);
    if (code === undefined) throw error;
    // `applyRefund` valida antes de qualquer mutação: wallet e transação estão inalteradas.
    transaction.reject(code);
    return { transaction, wallet, ledgerEntry: null };
  }

  if (policy.isExhausted(attempt.attempts)) {
    transaction.reject(FailureCodes.ReferenceNotFound);
    return { transaction, wallet, ledgerEntry: null };
  }
  return {
    transaction,
    wallet,
    ledgerEntry: null,
    nextReferenceAttemptAt: policy.nextAttemptAt(attempt.attempts, attempt.at),
  };
}
