import { assertMovementPreconditions } from './bet';
import { CurrencyMismatchError } from './money';
import {
  InvalidWagerTransactionError,
  type WagerTransaction,
  WagerTransactionKind,
} from './wager-transaction';
import type { Wallet } from './wallet';

export interface LossInput {
  /** LOSS em `PENDING`, sem referência. */
  transaction: WagerTransaction;
  /** Wallet da transação, já protegida contra concorrência pela persistência. */
  wallet: Wallet;
  at: Date;
}

/**
 * Aplica um LOSS sem referência (contrato §7: "registra o resultado sem mover saldo"; nenhum efeito
 * no saldo e nenhum lançamento, §6.4): marca a transação `PROCESSED` sem tocar na wallet. Não há
 * lançamento a devolver.
 *
 * Violações de negócio lançam erros de domínio sem alterar wallet nem transação:
 * - `WalletPlayerMismatchError`: a wallet não pertence ao player da transação;
 * - `CurrencyMismatchError`: moeda da operação diferente da moeda da wallet (§6.2, sem exceção para
 *   LOSS).
 * Converter esses erros em `REJECTED` com `failureCode` (§7.2) cabe ao processamento.
 *
 * Valor zero é aceito: sem movimentação, não há lançamento a validar (regra do projeto: LOSS com
 * valor maior ou igual a zero não altera o saldo). LOSS com referência é recusado: o contrato não diz
 * se ela é permitida nem o que pode referenciar.
 */
export function applyLoss(input: LossInput): null {
  const { transaction, wallet } = input;
  assertMovementPreconditions(transaction, wallet, WagerTransactionKind.Loss, 'applyLoss');
  if (transaction.referenceExternalTransactionId !== undefined) {
    throw new InvalidWagerTransactionError('LOSS com referência ainda não é processado.');
  }
  if (transaction.money.currency !== wallet.currency) {
    throw new CurrencyMismatchError('registrar', wallet.currency, transaction.money.currency);
  }
  // Não falha: estado não terminal, LOSS sem referência; a data é validada pela transição.
  transaction.markProcessed(undefined, input.at);
  return null;
}
