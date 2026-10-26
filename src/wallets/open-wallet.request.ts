import type { OpenWalletCommand } from '../application/open-wallet';
import { Money, type MoneyProps } from '../domain/money';
import type { Wallet } from '../domain/wallet';

/** Resposta de `POST /wallets` (contrato §9). `balance` usa a forma `MoneyProps` (§6.1). */
export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/** Corpo de `POST /wallets` que não tem a forma do contrato §9. */
export class InvalidOpenWalletRequestError extends Error {
  override readonly name = 'InvalidOpenWalletRequestError';
}

/**
 * Lê o corpo de `POST /wallets` (`{ playerId, initialBalance: { amount, currency } }`, §9).
 *
 * Valida só a forma; o valor monetário é lido por `Money.fromProps`, que aplica as regras do §6.1
 * (string decimal com 2 casas, não negativa, moeda ISO-4217) e lança `InvalidMoneyError`. As demais
 * invariantes ficam com o domínio. Campos extras são ignorados.
 */
export function parseOpenWalletRequest(body: unknown): OpenWalletCommand {
  if (!isPlainObject(body)) {
    throw new InvalidOpenWalletRequestError('o corpo deve ser um objeto JSON.');
  }
  const { playerId, initialBalance } = body;
  if (typeof playerId !== 'string' || playerId.trim() === '') {
    throw new InvalidOpenWalletRequestError('playerId deve ser uma string não vazia.');
  }
  // O PostgreSQL não armazena o caractere NUL em `text`: sem esta checagem, a entrada viraria 500.
  if (playerId.includes('\u0000')) {
    throw new InvalidOpenWalletRequestError('playerId não pode conter o caractere NUL.');
  }
  if (!isPlainObject(initialBalance)) {
    throw new InvalidOpenWalletRequestError(
      'initialBalance deve ser um objeto { amount, currency }.',
    );
  }
  const { amount, currency } = initialBalance;
  return {
    playerId,
    initialBalance: Money.fromProps({ amount, currency } as MoneyProps),
  };
}

export function toWalletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toProps(),
    version: wallet.version,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
