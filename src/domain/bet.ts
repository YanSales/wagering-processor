import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  type WagerTransaction,
  WagerTransactionKind,
} from './wager-transaction';
import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export interface BetInput {
  /** BET em `PENDING`. */
  transaction: WagerTransaction;
  /** Wallet da transação, já protegida contra concorrência pela persistência. */
  wallet: Wallet;
  /** Id do lançamento a criar, fornecido pelo chamador. */
  ledgerEntryId: string;
  at: Date;
}

/**
 * Aplica uma BET (contrato §7: débito, 1 lançamento `DEBIT`, rejeitar se o saldo for insuficiente)
 * sobre objetos de domínio já carregados: debita a wallet e marca a transação `PROCESSED`.
 *
 * Violações de negócio lançam erros de domínio sem alterar wallet nem transação:
 * - `WalletPlayerMismatchError`: a wallet não pertence ao player da transação;
 * - `CurrencyMismatchError`: moeda da aposta diferente da moeda da wallet (de `Wallet.debit`);
 * - `InsufficientFundsError`: saldo insuficiente (de `Wallet.debit`).
 * Converter esses erros em `REJECTED` com `failureCode` (§7.2) cabe ao processamento.
 *
 * Fora do escopo: valor zero (`Wallet.debit` exige valor positivo; a regra de negócio ainda não foi
 * definida), referências em BET, idempotência e concorrência.
 */
export function applyBet(input: BetInput): WalletLedgerEntry {
  const { transaction, wallet } = input;
  if (transaction.kind !== WagerTransactionKind.Bet) {
    throw new InvalidWagerTransactionError(
      `applyBet aceita apenas BET; recebido ${transaction.kind}.`,
    );
  }
  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(
      transaction.id,
      transaction.status,
      'applyBet',
      'o estado atual é terminal.',
    );
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidWagerTransactionError(
      `a transação ${transaction.id} pertence à wallet ${transaction.walletId}, não à ${wallet.id}.`,
    );
  }
  if (transaction.playerId !== wallet.playerId) {
    throw new WalletPlayerMismatchError(wallet.id, wallet.playerId, transaction.playerId);
  }

  // `debit` valida moeda, valor e saldo antes de alterar a wallet.
  const entry = wallet.debit({
    transactionId: transaction.id,
    ledgerEntryId: input.ledgerEntryId,
    money: transaction.money,
    at: input.at,
  });
  // Não falha: estado não terminal, BET sem referência e data já validada pelo débito.
  transaction.markProcessed(undefined, input.at);
  return entry;
}

/** Erro de domínio: a wallet informada pertence a outro player. Wallet e transação inalteradas. */
export class WalletPlayerMismatchError extends Error {
  override readonly name = 'WalletPlayerMismatchError';

  constructor(
    readonly walletId: string,
    readonly walletPlayerId: string,
    readonly transactionPlayerId: string,
  ) {
    super(
      `a wallet ${walletId} pertence ao player ${walletPlayerId}, não ao ${transactionPlayerId}.`,
    );
  }
}
