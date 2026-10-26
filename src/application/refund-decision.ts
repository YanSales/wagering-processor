import { applyRefund } from '../domain/refund';
import type { ReversalOutcome } from '../domain/reversal';
import { applyRollback } from '../domain/rollback';
import type { FailureCode, WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { FailureCodes, refundFailureCodeFor, rollbackFailureCodeFor } from './failure-codes';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import type { ResolvedReference, SubmissionDecision } from './wager-transaction-repository';

export interface RefundAttempt {
  /** REFUND ou ROLLBACK em `PENDING` (submissão) ou `PENDING_REFERENCE` (worker). */
  transaction: WagerTransaction;
  /** Wallet travada pela persistência. */
  wallet: Wallet;
  /** Referência lida sob o mesmo lock, ou `null` se ainda não existe. */
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
  return decideReversal(
    attempt,
    (reference) =>
      applyRefund({
        transaction: attempt.transaction,
        reference: reference?.transaction,
        alreadyRefunded: reference?.alreadyReversed ?? false,
        wallet: attempt.wallet,
        ledgerEntryId: attempt.ledgerEntryId,
        at: attempt.at,
      }),
    refundFailureCodeFor,
  );
}

/**
 * Decide um ROLLBACK com a mesma política do REFUND (rejeição imediata de referência inválida,
 * espera pela referência ausente e esgotamento). Movimenta no sentido inverso ao da referência; um
 * débito que deixaria saldo negativo vira `REJECTED` com `REVERSAL_WOULD_OVERDRAW` (§7, regra 9).
 */
export function decideRollback(attempt: RefundAttempt): SubmissionDecision {
  return decideReversal(
    attempt,
    (reference) =>
      applyRollback({
        transaction: attempt.transaction,
        reference: reference?.transaction,
        alreadyRolledBack: reference?.alreadyReversed ?? false,
        wallet: attempt.wallet,
        ledgerEntryId: attempt.ledgerEntryId,
        at: attempt.at,
      }),
    rollbackFailureCodeFor,
  );
}

function decideReversal(
  attempt: RefundAttempt,
  apply: (reference: ResolvedReference | null) => ReversalOutcome,
  failureCodeFor: (error: unknown) => FailureCode | undefined,
): SubmissionDecision {
  const { transaction, wallet, reference, policy } = attempt;
  try {
    const outcome = apply(reference);
    if (outcome.outcome === 'PROCESSED') {
      return { transaction, wallet, ledgerEntry: outcome.ledgerEntry };
    }
  } catch (error) {
    const code = failureCodeFor(error);
    if (code === undefined) throw error;
    // A aplicação valida antes de qualquer mutação: wallet e transação estão inalteradas.
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
