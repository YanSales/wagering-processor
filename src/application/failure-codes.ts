import { WalletPlayerMismatchError } from '../domain/bet';
import { CurrencyMismatchError } from '../domain/money';
import { ReferenceAlreadyReversedError } from '../domain/refund';
import { ReversalWouldOverdrawError } from '../domain/reversal';
import { InvalidReferenceError, type ReferenceViolation } from '../domain/transaction-reference';
import type { FailureCode } from '../domain/wager-transaction';
import { InsufficientFundsError } from '../domain/wallet';

/**
 * Códigos de falha das rejeições de negócio (contrato §7.2: "a taxonomia é sua"). Estáveis e legíveis
 * por máquina: o provedor decide por eles se corrige o payload ou desiste, sem interpretar mensagens.
 * Só os códigos que o processamento atual produz; novos entram com as operações que os exigem.
 */
export const FailureCodes = {
  /** BET maior que o saldo disponível (§7, tabela). Reenviar o mesmo payload não muda o resultado. */
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  /** Moeda da operação diferente da moeda da wallet (§6.2). */
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  /** A wallet informada pertence a outro player. */
  PlayerWalletMismatch: 'PLAYER_WALLET_MISMATCH',
  /** A referência não apareceu até o fim das tentativas (§7.1). */
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  /** A referência é de outro player, wallet, moeda ou rodada (§7, regra 2). */
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  /** A referência é de um tipo que a operação não pode referenciar (§7, regra 3). */
  ReferenceKindNotAllowed: 'REFERENCE_KIND_NOT_ALLOWED',
  /** A referência existe, mas não foi aplicada (ex.: BET `REJECTED`; §7, tabela). */
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  /** Valor diferente do valor da referência; reversão parcial está fora de escopo (§7, regra 5). */
  ReferenceAmountMismatch: 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já foi revertida pelo mesmo tipo de operação (§7, regra 4). */
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  /**
   * ROLLBACK de WIN ou REFUND (débito) que deixaria o saldo negativo (§7, regra 9). Distinto de
   * `INSUFFICIENT_FUNDS`: não é aposta sem saldo, e a transação continua auditável.
   */
  ReversalWouldOverdraw: 'REVERSAL_WOULD_OVERDRAW',
} as const satisfies Record<string, FailureCode>;

/**
 * Código de rejeição de negócio para um erro de domínio de uma submissão (BET, WIN, LOSS), ou
 * `undefined` se não for um. WIN e LOSS só produzem `CURRENCY_MISMATCH` e `PLAYER_WALLET_MISMATCH`.
 */
export function movementFailureCodeFor(error: unknown): FailureCode | undefined {
  if (error instanceof InsufficientFundsError) return FailureCodes.InsufficientFunds;
  if (error instanceof CurrencyMismatchError) return FailureCodes.CurrencyMismatch;
  if (error instanceof WalletPlayerMismatchError) return FailureCodes.PlayerWalletMismatch;
  return undefined;
}

/**
 * `NOT_THE_REFERENCED_TRANSACTION` não tem código: a persistência resolve a referência pelo próprio
 * `(providerId, referenceExternalTransactionId)`, então essa violação é erro de programação.
 */
const REFERENCE_VIOLATION_CODES: Readonly<Partial<Record<ReferenceViolation, FailureCode>>> = {
  DIFFERENT_PLAYER: FailureCodes.ReferenceMismatch,
  DIFFERENT_WALLET: FailureCodes.ReferenceMismatch,
  DIFFERENT_CURRENCY: FailureCodes.ReferenceMismatch,
  DIFFERENT_ROUND: FailureCodes.ReferenceMismatch,
  KIND_NOT_ALLOWED: FailureCodes.ReferenceKindNotAllowed,
  REFERENCE_NOT_PROCESSED: FailureCodes.ReferenceNotProcessed,
  AMOUNT_MISMATCH: FailureCodes.ReferenceAmountMismatch,
};

/**
 * Código de rejeição de negócio para um erro de domínio de um REFUND, ou `undefined` se não for um:
 * os de qualquer submissão (`CURRENCY_MISMATCH`, `PLAYER_WALLET_MISMATCH`) e os de referência
 * existente, mas inválida, que é rejeitada de imediato, sem esperar novas tentativas.
 */
export function refundFailureCodeFor(error: unknown): FailureCode | undefined {
  if (error instanceof InvalidReferenceError) return REFERENCE_VIOLATION_CODES[error.violation];
  if (error instanceof ReferenceAlreadyReversedError) return FailureCodes.ReferenceAlreadyReversed;
  if (error instanceof CurrencyMismatchError) return FailureCodes.CurrencyMismatch;
  if (error instanceof WalletPlayerMismatchError) return FailureCodes.PlayerWalletMismatch;
  return undefined;
}

/** Código de rejeição de um ROLLBACK: os do REFUND e a reversão que deixaria saldo negativo (regra 9). */
export function rollbackFailureCodeFor(error: unknown): FailureCode | undefined {
  if (error instanceof ReversalWouldOverdrawError) return FailureCodes.ReversalWouldOverdraw;
  return refundFailureCodeFor(error);
}
