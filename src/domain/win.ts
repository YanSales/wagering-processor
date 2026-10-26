import { assertMovementPreconditions } from './bet';
import {
  InvalidWagerTransactionError,
  type WagerTransaction,
  WagerTransactionKind,
} from './wager-transaction';
import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WinInput {
  /** WIN em `PENDING`, sem referência. */
  transaction: WagerTransaction;
  /** Wallet da transação, já protegida contra concorrência pela persistência. */
  wallet: Wallet;
  /** Id do lançamento a criar, fornecido pelo chamador. */
  ledgerEntryId: string;
  at: Date;
}

/**
 * Aplica um WIN sem referência (contrato §7: crédito, 1 lançamento `CREDIT`) sobre objetos de
 * domínio já carregados: credita a wallet e marca a transação `PROCESSED`.
 *
 * Violações de negócio lançam erros de domínio sem alterar wallet nem transação:
 * - `WalletPlayerMismatchError`: a wallet não pertence ao player da transação;
 * - `CurrencyMismatchError`: moeda do prêmio diferente da moeda da wallet (de `Wallet.credit`).
 * Converter esses erros em `REJECTED` com `failureCode` (§7.2) cabe ao processamento.
 *
 * WIN com referência é recusado: o contrato permite referenciar a BET da rodada (§7), mas não
 * define o caso de uma BET referenciada que não esteja `PROCESSED`. Valor zero também fica fora
 * (`Wallet.credit` exige valor positivo; a regra de negócio não foi definida).
 */
export function applyWin(input: WinInput): WalletLedgerEntry {
  const { transaction, wallet } = input;
  assertMovementPreconditions(transaction, wallet, WagerTransactionKind.Win, 'applyWin');
  if (transaction.referenceExternalTransactionId !== undefined) {
    throw new InvalidWagerTransactionError('WIN com referência ainda não é processado.');
  }

  // `credit` valida moeda e valor antes de alterar a wallet.
  const entry = wallet.credit({
    transactionId: transaction.id,
    ledgerEntryId: input.ledgerEntryId,
    money: transaction.money,
    at: input.at,
  });
  // Não falha: estado não terminal, WIN sem referência e data já validada pelo crédito.
  transaction.markProcessed(undefined, input.at);
  return entry;
}
