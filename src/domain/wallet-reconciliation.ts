import { Money } from './money';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

/** Resultado da reconciliação de uma wallet (contrato §9, `POST /wallets/:walletId/reconciliation`). */
export interface WalletReconciliation {
  walletId: string;
  /** Saldo armazenado na wallet. */
  storedBalance: Money;
  /** Saldo reconstruído pelo ledger: soma dos créditos menos soma dos débitos (§13). */
  calculatedBalance: Money;
  /** `storedBalance - calculatedBalance` (interpretação documentada: o contrato só exemplifica 0.00). */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo da wallet com o saldo reconstruído pelos lançamentos informados (contrato §9 e
 * §13: `wallet.balance == saldo reconstruído pelo ledger`). Não altera a wallet nem os lançamentos:
 * divergências não são corrigidas silenciosamente, só sinalizadas (`consistent: false`). Registrar
 * log e métrica cabe à aplicação.
 *
 * Espera todos os lançamentos da wallet; lançamentos de outra wallet ou em outra moeda são erro do
 * chamador e lançam exceção, em vez de serem ignorados.
 */
export function reconcileWallet(
  wallet: Wallet,
  entries: readonly WalletLedgerEntry[],
): WalletReconciliation {
  let calculatedBalance = Money.zero(wallet.currency);
  for (const entry of entries) {
    if (entry.walletId !== wallet.id) {
      throw new InvalidReconciliationInputError(
        `o lançamento ${entry.id} pertence à wallet ${entry.walletId}, não à ${wallet.id}.`,
      );
    }
    calculatedBalance =
      entry.direction === LedgerDirection.Credit
        ? calculatedBalance.add(entry.money)
        : calculatedBalance.subtract(entry.money);
  }

  const difference = wallet.balance.subtract(calculatedBalance);
  return {
    walletId: wallet.id,
    storedBalance: wallet.balance,
    calculatedBalance,
    difference,
    consistent: difference.isZero(),
    checkedEntries: entries.length,
  };
}

/** Entrada de reconciliação inconsistente com a wallet informada (erro do chamador). */
export class InvalidReconciliationInputError extends Error {
  override readonly name = 'InvalidReconciliationInputError';

  constructor(detail: string) {
    super(`Reconciliação inválida: ${detail}`);
  }
}
