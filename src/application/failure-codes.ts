import { WalletPlayerMismatchError } from '../domain/bet';
import { CurrencyMismatchError } from '../domain/money';
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
