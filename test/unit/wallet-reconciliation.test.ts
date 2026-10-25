import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/domain/money';
import { applyReversal } from '../../src/domain/reversal';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import {
  InvalidReconciliationInputError,
  reconcileWallet,
} from '../../src/domain/wallet-reconciliation';
import { at, brl, processed, reversalOf, T0 } from '../support/wager-fixtures';

function scenario() {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(100_000n),
    openedAt: T0,
    opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' },
  });
  const ledger: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
  ledger.push(
    wallet.debit({
      transactionId: 'bet-1',
      ledgerEntryId: 'entry-1',
      money: brl(2_500n),
      at: at(1),
    }),
  );
  ledger.push(
    wallet.credit({
      transactionId: 'win-1',
      ledgerEntryId: 'entry-2',
      money: brl(5_000n),
      at: at(2),
    }),
  );
  const bet = processed(WagerTransactionKind.Bet, 'bet-1');
  const refund = reversalOf(WagerTransactionKind.Refund, 'refund-1', bet);
  const result = applyReversal({
    transaction: refund,
    reference: bet,
    wallet,
    ledgerEntryId: 'entry-3',
    at: at(3),
  });
  if (result.outcome === 'PROCESSED') ledger.push(result.ledgerEntry);
  return { wallet, ledger };
}

describe('reconcileWallet (contrato §9 e §13)', () => {
  test('saldo armazenado igual ao reconstruído pelo ledger → consistente', () => {
    const { wallet, ledger } = scenario();

    const result = reconcileWallet(wallet, ledger);

    expect(result.walletId).toBe('wallet-1');
    expect(result.storedBalance.toProps()).toEqual({ amount: '1050.00', currency: 'BRL' });
    expect(result.calculatedBalance.equals(result.storedBalance)).toBe(true);
    expect(result.difference.toProps()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(4);
  });

  test('wallet sem lançamentos e saldo zero → consistente, 0 lançamentos', () => {
    const { wallet } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl(0n),
      openedAt: T0,
    });

    const result = reconcileWallet(wallet, []);

    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
    expect(result.calculatedBalance.isZero()).toBe(true);
  });

  test('a ordem dos lançamentos não altera o resultado', () => {
    const { wallet, ledger } = scenario();

    expect(reconcileWallet(wallet, [...ledger].reverse()).consistent).toBe(true);
  });

  test('lançamento ausente → divergência sinalizada, sem corrigir a wallet', () => {
    const { wallet, ledger } = scenario();
    const before = { cents: wallet.balance.cents, version: wallet.version };

    const result = reconcileWallet(wallet, ledger.slice(0, -1));

    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(3);
    expect(result.calculatedBalance.equals(brl(102_500n))).toBe(true);
    expect({ cents: wallet.balance.cents, version: wallet.version }).toEqual(before);
  });

  test('difference = storedBalance - calculatedBalance (interpretação documentada)', () => {
    const { wallet, ledger } = scenario();

    expect(reconcileWallet(wallet, ledger.slice(0, -1)).difference.toProps()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    const extra = WalletLedgerEntry.rehydrate({
      id: 'entry-x',
      walletId: 'wallet-1',
      transactionId: 'tx-x',
      direction: LedgerDirection.Credit,
      money: brl(100n),
      balanceBefore: brl(0n),
      balanceAfter: brl(100n),
      createdAt: T0,
    });
    expect(reconcileWallet(wallet, [...ledger, extra]).difference.toProps()).toEqual({
      amount: '-1.00',
      currency: 'BRL',
    });
  });

  test('saldo armazenado divergente (estado reidratado) é detectado', () => {
    const { ledger } = scenario();
    const corrupted = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: brl(999_999n),
      version: 4,
      createdAt: T0,
      updatedAt: at(3),
    });

    expect(reconcileWallet(corrupted, ledger).consistent).toBe(false);
  });

  test('lançamento de outra wallet é erro do chamador, não é ignorado', () => {
    const { wallet, ledger } = scenario();
    const foreign = WalletLedgerEntry.create({
      id: 'entry-foreign',
      walletId: 'wallet-2',
      transactionId: 'tx-f',
      direction: LedgerDirection.Credit,
      money: brl(100n),
      balanceBefore: brl(0n),
      balanceAfter: brl(100n),
      createdAt: T0,
    });

    expect(() => reconcileWallet(wallet, [...ledger, foreign])).toThrow(
      InvalidReconciliationInputError,
    );
  });

  test('lançamento em outra moeda lança CurrencyMismatchError', () => {
    const { wallet, ledger } = scenario();
    const usd = (cents: bigint) => Money.fromCents(cents, 'USD');
    const other = WalletLedgerEntry.create({
      id: 'entry-usd',
      walletId: 'wallet-1',
      transactionId: 'tx-u',
      direction: LedgerDirection.Credit,
      money: usd(100n),
      balanceBefore: usd(0n),
      balanceAfter: usd(100n),
      createdAt: T0,
    });

    expect(() => reconcileWallet(wallet, [...ledger, other])).toThrow(CurrencyMismatchError);
  });
});
