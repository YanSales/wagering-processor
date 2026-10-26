import { describe, expect, test } from 'bun:test';
import { applyBet, WalletPlayerMismatchError } from '../../src/domain/bet';
import { CurrencyMismatchError, Money } from '../../src/domain/money';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { InsufficientFundsError, Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
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

describe('applyBet', () => {
  test('saldo suficiente: debita, gera um DEBIT coerente e marca PROCESSED', () => {
    const wallet = walletWith(10_000n);
    const bet = wager(Bet, 'bet-1', { money: brl(8_000n) });

    const entry = applyBet({ transaction: bet, wallet, ledgerEntryId: 'entry-1', at: at(5) });

    expect(wallet.balance.cents).toBe(2_000n);
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.transactionId).toBe('bet-1');
    expect(entry.balanceBefore.cents).toBe(10_000n);
    expect(entry.balanceAfter.cents).toBe(2_000n);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.processedAt?.getTime()).toBe(at(5).getTime());
  });

  test('saldo exatamente igual ao valor: zera o saldo', () => {
    const wallet = walletWith(8_000n);

    applyBet({
      transaction: wager(Bet, 'bet-1', { money: brl(8_000n) }),
      wallet,
      ledgerEntryId: 'e',
      at: at(1),
    });

    expect(wallet.balance.isZero()).toBe(true);
  });

  test.each([
    [
      'saldo insuficiente',
      () => wager(Bet, 'bet-1', { money: brl(10_001n) }),
      walletWith(10_000n),
      InsufficientFundsError,
    ],
    [
      'moeda da aposta diferente da wallet',
      () => wager(Bet, 'bet-1', { money: Money.fromCents(100n, 'USD') }),
      walletWith(10_000n),
      CurrencyMismatchError,
    ],
    [
      'wallet de outro player',
      () => wager(Bet, 'bet-1', { playerId: 'player-2' }),
      walletWith(10_000n),
      WalletPlayerMismatchError,
    ],
  ])(
    '%s: lança erro de domínio sem alterar wallet nem transação',
    (_case, build, wallet, error) => {
      const bet = build();
      const before = snapshot(wallet);

      expect(() => applyBet({ transaction: bet, wallet, ledgerEntryId: 'e', at: at(1) })).toThrow(
        error,
      );
      expect(snapshot(wallet)).toEqual(before);
      expect(bet.status).toBe(WagerTransactionStatus.Pending);
    },
  );

  test('transição inválida: BET já terminal não é aplicada de novo', () => {
    const wallet = walletWith(10_000n);
    const bet = wager(Bet, 'bet-1');
    applyBet({ transaction: bet, wallet, ledgerEntryId: 'e1', at: at(1) });
    const before = snapshot(wallet);

    expect(() => applyBet({ transaction: bet, wallet, ledgerEntryId: 'e2', at: at(2) })).toThrow(
      InvalidTransactionStateError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test('transição inválida: BET rejeitada não pode ser processada', () => {
    const bet = wager(Bet, 'bet-1');
    bet.reject('INSUFFICIENT_FUNDS');

    expect(() =>
      applyBet({ transaction: bet, wallet: walletWith(10_000n), ledgerEntryId: 'e', at: at(1) }),
    ).toThrow(InvalidTransactionStateError);
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
  });

  test('aceita apenas BET', () => {
    expect(() =>
      applyBet({
        transaction: wager(Win, 'win-1'),
        wallet: walletWith(10_000n),
        ledgerEntryId: 'e',
        at: at(1),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('a transação precisa ser da wallet informada', () => {
    expect(() =>
      applyBet({
        transaction: wager(Bet, 'bet-1', { walletId: 'wallet-2' }),
        wallet: walletWith(10_000n),
        ledgerEntryId: 'e',
        at: at(1),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});
