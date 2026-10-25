import { validateReference } from './transaction-reference';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  type WagerTransaction,
} from './wager-transaction';
import { InsufficientFundsError, type Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

export interface ReversalInput {
  /** REFUND ou ROLLBACK em `PENDING` ou `PENDING_REFERENCE`. */
  transaction: WagerTransaction;
  /** Transação resolvida por `(providerId, referenceExternalTransactionId)`, ou `undefined` se ausente. */
  reference: WagerTransaction | undefined;
  /** Wallet da transação. */
  wallet: Wallet;
  /** Id do lançamento a criar, fornecido pelo chamador. */
  ledgerEntryId: string;
  at: Date;
}

export type ReversalOutcome =
  | { outcome: 'AWAITING_REFERENCE' }
  | { outcome: 'PROCESSED'; ledgerEntry: WalletLedgerEntry };

/**
 * Aplica um REFUND ou ROLLBACK (contrato §7) sobre objetos de domínio já carregados.
 *
 * - Referência ausente: a transação vai (ou continua) em `PENDING_REFERENCE` (regra 8).
 * - Referência presente: é validada (`validateReference`); a wallet recebe o movimento na direção de
 *   `ledgerDirectionFor` (ROLLBACK inverte a referência) e a transação vai para `PROCESSED` com o id
 *   interno da referência.
 * - Reversão que deixaria o saldo negativo lança `ReversalWouldOverdrawError`, distinto do saldo
 *   insuficiente de uma aposta (regra 9).
 *
 * Toda validação ocorre antes de qualquer mutação: se algo falhar, transação e wallet ficam
 * inalteradas. Erros de negócio (`InvalidReferenceError`, `ReversalWouldOverdrawError`) não
 * rejeitam a transação aqui: o `failureCode` (§7.2) ainda não tem taxonomia definida.
 *
 * Fora do escopo: impedir reversão dupla da mesma referência (regra 4, garantida pela persistência),
 * atomicidade com persistência, idempotência e o limite de tentativas de `PENDING_REFERENCE` (§7.1).
 */
export function applyReversal(input: ReversalInput): ReversalOutcome {
  const { transaction, reference, wallet } = input;
  if (!transaction.requiresReference()) {
    throw new InvalidWagerTransactionError(
      `applyReversal aceita apenas REFUND ou ROLLBACK; recebido ${transaction.kind}.`,
    );
  }
  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(
      transaction.id,
      transaction.status,
      'applyReversal',
      'o estado atual é terminal.',
    );
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidWagerTransactionError(
      `a transação ${transaction.id} pertence à wallet ${transaction.walletId}, não à ${wallet.id}.`,
    );
  }

  if (reference === undefined) {
    transaction.markPendingReference();
    return { outcome: 'AWAITING_REFERENCE' };
  }

  validateReference(transaction, reference);
  // `markProcessed` exige o id interno; verificado antes do movimento para não falhar depois dele.
  if (typeof reference.id !== 'string' || reference.id.trim() === '') {
    throw new InvalidWagerTransactionError('a referência não tem id interno.');
  }
  const direction = transaction.ledgerDirectionFor(reference);
  const movement = {
    transactionId: transaction.id,
    ledgerEntryId: input.ledgerEntryId,
    money: transaction.money,
    at: input.at,
  };

  let ledgerEntry: WalletLedgerEntry;
  if (direction === LedgerDirection.Credit) {
    ledgerEntry = wallet.credit(movement);
  } else {
    try {
      ledgerEntry = wallet.debit(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new ReversalWouldOverdrawError(transaction, error);
      }
      throw error;
    }
  }

  // Não falha: estado não terminal, referência e data já validados pelo movimento acima.
  transaction.markProcessed(reference.id, input.at);
  return { outcome: 'PROCESSED', ledgerEntry };
}

/**
 * Reversão que produziria saldo negativo (contrato §7, regra 9). Distinta de `InsufficientFundsError`
 * de uma aposta, porque são situações operacionalmente diferentes. Wallet e transação inalteradas.
 */
export class ReversalWouldOverdrawError extends Error {
  override readonly name = 'ReversalWouldOverdrawError';
  readonly transactionId: string;

  constructor(
    transaction: WagerTransaction,
    readonly insufficientFunds: InsufficientFundsError,
  ) {
    super(
      `${transaction.kind} ${transaction.id} produziria saldo negativo: ${insufficientFunds.message}`,
    );
    this.transactionId = transaction.id;
  }
}
