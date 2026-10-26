import { describe, expect, test } from 'bun:test';
import { WalletPlayerMismatchError } from '../../src/domain/bet';
import { CurrencyMismatchError, Money } from '../../src/domain/money';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { applyWin } from '../../src/domain/win';
import { at, brl, T0, wager } from '../support/wager-fixtures';

const { Bet, Win } = WagerTransactionKind;

function walletWith(cents: bigint, currency = 'BRL') {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    balance: Money.fromCents(cents, currency),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

function snapshot(wallet: Wallet) {
  return {
    balance: wallet.balance.cents,
    version: wallet.version,
    updatedAt: wallet.updatedAt.getTime(),
  };
}

describe('applyWin (contrato §7: crédito, 1 lançamento CREDIT)', () => {
  test('credita, gera um CREDIT coerente e marca PROCESSED', () => {
    const wallet = walletWith(2_000n);
    const win = wager(Win, 'win-1', { money: brl(5_000n) });

    const entry = applyWin({ transaction: win, wallet, ledgerEntryId: 'entry-1', at: at(5) });

    expect(wallet.balance.cents).toBe(7_000n);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.getTime()).toBe(at(5).getTime());
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.transactionId).toBe('win-1');
    expect(entry.balanceBefore.cents).toBe(2_000n);
    expect(entry.balanceAfter.cents).toBe(7_000n);
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.processedAt?.getTime()).toBe(at(5).getTime());
    expect(win.referenceTransactionId).toBeUndefined();
  });

  test('credita uma wallet com saldo zero', () => {
    const wallet = walletWith(0n);

    applyWin({ transaction: wager(Win, 'win-1'), wallet, ledgerEntryId: 'e', at: at(1) });

    expect(wallet.balance.cents).toBe(2_500n);
  });

  test.each([
    [
      'moeda do prêmio diferente da wallet',
      () => wager(Win, 'win-1', { money: Money.fromCents(100n, 'USD') }),
      CurrencyMismatchError,
    ],
    [
      'wallet de outro player',
      () => wager(Win, 'win-1', { playerId: 'player-2' }),
      WalletPlayerMismatchError,
    ],
  ])('%s: lança erro de domínio sem alterar wallet nem transação', (_case, build, error) => {
    const wallet = walletWith(10_000n);
    const win = build();
    const before = snapshot(wallet);

    expect(() => applyWin({ transaction: win, wallet, ledgerEntryId: 'e', at: at(1) })).toThrow(
      error,
    );
    expect(snapshot(wallet)).toEqual(before);
    expect(win.status).toBe(WagerTransactionStatus.Pending);
  });

  test('WIN com referência não é processado nesta etapa', () => {
    const wallet = walletWith(10_000n);
    const win = wager(Win, 'win-1', { referenceExternalTransactionId: 'ext-bet-1' });
    const before = snapshot(wallet);

    expect(() => applyWin({ transaction: win, wallet, ledgerEntryId: 'e', at: at(1) })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(snapshot(wallet)).toEqual(before);
    expect(win.status).toBe(WagerTransactionStatus.Pending);
  });

  test('transição inválida: WIN já processado não credita de novo', () => {
    const wallet = walletWith(10_000n);
    const win = wager(Win, 'win-1');
    applyWin({ transaction: win, wallet, ledgerEntryId: 'e1', at: at(1) });
    const before = snapshot(wallet);

    expect(() => applyWin({ transaction: win, wallet, ledgerEntryId: 'e2', at: at(2) })).toThrow(
      InvalidTransactionStateError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test('aceita apenas WIN', () => {
    expect(() =>
      applyWin({
        transaction: wager(Bet, 'bet-1'),
        wallet: walletWith(10_000n),
        ledgerEntryId: 'e',
        at: at(1),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('a transação precisa ser da wallet informada', () => {
    expect(() =>
      applyWin({
        transaction: wager(Win, 'win-1', { walletId: 'wallet-2' }),
        wallet: walletWith(10_000n),
        ledgerEntryId: 'e',
        at: at(1),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});
