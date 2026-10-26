import { describe, expect, test } from 'bun:test';
import { WalletPlayerMismatchError } from '../../src/domain/bet';
import { applyLoss } from '../../src/domain/loss';
import { CurrencyMismatchError, Money } from '../../src/domain/money';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { at, brl, T0, wager } from '../support/wager-fixtures';

const { Bet, Loss } = WagerTransactionKind;

function walletWith(cents: bigint, currency = 'BRL') {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    balance: Money.fromCents(cents, currency),
    version: 3,
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

describe('applyLoss (contrato §7: registra o resultado sem mover saldo)', () => {
  test('marca PROCESSED sem lançamento e sem alterar saldo, versão nem updatedAt', () => {
    const wallet = walletWith(2_000n);
    const before = snapshot(wallet);
    const loss = wager(Loss, 'loss-1', { money: brl(5_000n) });

    const entry = applyLoss({ transaction: loss, wallet, at: at(5) });

    expect(entry).toBeNull();
    expect(snapshot(wallet)).toEqual(before);
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.processedAt?.getTime()).toBe(at(5).getTime());
    expect(loss.affectsBalance()).toBe(false);
  });

  test('valor maior que o saldo não importa: não há débito', () => {
    const wallet = walletWith(0n);

    applyLoss({ transaction: wager(Loss, 'loss-1', { money: brl(99_999n) }), wallet, at: at(1) });

    expect(wallet.balance.cents).toBe(0n);
  });

  test('valor zero é registrado (sem movimentação, nenhuma invariante envolvida)', () => {
    const loss = wager(Loss, 'loss-1', { money: brl(0n) });

    expect(applyLoss({ transaction: loss, wallet: walletWith(100n), at: at(1) })).toBeNull();
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
  });

  test.each([
    [
      'moeda diferente da wallet (§6.2)',
      () => wager(Loss, 'loss-1', { money: Money.fromCents(100n, 'USD') }),
      CurrencyMismatchError,
    ],
    [
      'wallet de outro player',
      () => wager(Loss, 'loss-1', { playerId: 'player-2' }),
      WalletPlayerMismatchError,
    ],
    [
      'LOSS com referência (regra não definida)',
      () => wager(Loss, 'loss-1', { referenceExternalTransactionId: 'ext-bet-1' }),
      InvalidWagerTransactionError,
    ],
  ])('%s: lança erro sem alterar wallet nem transação', (_case, build, error) => {
    const wallet = walletWith(10_000n);
    const loss = build();
    const before = snapshot(wallet);

    expect(() => applyLoss({ transaction: loss, wallet, at: at(1) })).toThrow(error);
    expect(snapshot(wallet)).toEqual(before);
    expect(loss.status).toBe(WagerTransactionStatus.Pending);
  });

  test('transição inválida: LOSS já processado não é aplicado de novo', () => {
    const wallet = walletWith(10_000n);
    const loss = wager(Loss, 'loss-1');
    applyLoss({ transaction: loss, wallet, at: at(1) });

    expect(() => applyLoss({ transaction: loss, wallet, at: at(2) })).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('aceita apenas LOSS', () => {
    expect(() =>
      applyLoss({ transaction: wager(Bet, 'bet-1'), wallet: walletWith(10_000n), at: at(1) }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('a transação precisa ser da wallet informada', () => {
    expect(() =>
      applyLoss({
        transaction: wager(Loss, 'loss-1', { walletId: 'wallet-2' }),
        wallet: walletWith(10_000n),
        at: at(1),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});
