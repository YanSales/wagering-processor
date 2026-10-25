import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/domain/money';
import {
  InsufficientFundsError,
  InvalidWalletOperationError,
  Wallet,
  type WalletMovement,
} from '../../src/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
const T0 = new Date('2026-10-25T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let sequence = 0;
const movement = (money: Money, seconds = 1): WalletMovement => {
  sequence += 1;
  return {
    transactionId: `tx-${sequence}`,
    ledgerEntryId: `entry-${sequence}`,
    money,
    at: at(seconds),
  };
};

function openWallet(initialCents: bigint, currency = 'BRL') {
  const initialBalance = Money.fromCents(initialCents, currency);
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    openedAt: T0,
    ...(initialCents > 0n
      ? { opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' } }
      : {}),
  });
}

/** Saldo reconstruído pelo ledger (invariante final do contrato §13). */
function replay(entries: WalletLedgerEntry[], currency = 'BRL'): Money {
  return entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Credit
        ? balance.add(entry.money)
        : balance.subtract(entry.money),
    Money.zero(currency),
  );
}

function snapshot(wallet: Wallet) {
  return {
    cents: wallet.balance.cents,
    version: wallet.version,
    updatedAt: wallet.updatedAt.getTime(),
  };
}

describe('Wallet.open', () => {
  test('saldo inicial positivo: version 1 e lançamento CREDIT de abertura', () => {
    const { wallet, openingEntry } = openWallet(100_000n);

    expect(wallet.balance.equals(brl(100_000n))).toBe(true);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt.getTime()).toBe(T0.getTime());
    expect(wallet.updatedAt.getTime()).toBe(T0.getTime());
    expect(openingEntry).not.toBeNull();
    expect(openingEntry?.direction).toBe('CREDIT');
    expect(openingEntry?.transactionId).toBe('opening-tx');
    expect(openingEntry?.walletId).toBe('wallet-1');
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(brl(100_000n))).toBe(true);
  });

  test('saldo inicial zero: version 1 e nenhum lançamento', () => {
    const { wallet, openingEntry } = openWallet(0n);

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeNull();
  });

  test('a moeda da wallet é a do saldo inicial (modelo multi-moeda)', () => {
    expect(openWallet(500n, 'USD').wallet.currency).toBe('USD');
  });

  test('saldo inicial positivo sem a transação OPENING é rejeitado', () => {
    const open = () =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl(100n), openedAt: T0 });

    expect(open).toThrow(InvalidWalletOperationError);
  });

  test('saldo inicial zero com lançamento de abertura é rejeitado', () => {
    const open = () =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl(0n),
        openedAt: T0,
        opening: { transactionId: 't', ledgerEntryId: 'e' },
      });

    expect(open).toThrow('saldo inicial zero');
  });

  test('saldo inicial negativo é rejeitado', () => {
    expect(() => openWallet(-1n)).toThrow('não pode ser negativo');
  });

  test.each([
    ['id vazio', { id: '' }],
    ['playerId em branco', { playerId: ' ' }],
    ['saldo que não é Money', { initialBalance: { cents: 1n } as unknown as Money }],
    ['data inválida', { openedAt: new Date('invalid') }],
  ])('rejeita %s', (_case, overrides) => {
    const props = { id: 'w', playerId: 'p', initialBalance: brl(0n), openedAt: T0, ...overrides };

    expect(() => Wallet.open(props)).toThrow(InvalidWalletOperationError);
  });
});

describe('Wallet.debit', () => {
  test('debita, incrementa a versão, atualiza updatedAt e devolve o lançamento DEBIT', () => {
    const { wallet } = openWallet(100_000n);
    const move = movement(brl(2_500n), 30);

    const entry = wallet.debit(move);

    expect(wallet.balance.equals(brl(97_500n))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.getTime()).toBe(at(30).getTime());
    expect(entry.direction).toBe('DEBIT');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe(move.transactionId);
    expect(entry.id).toBe(move.ledgerEntryId);
    expect(entry.balanceBefore.equals(brl(100_000n))).toBe(true);
    expect(entry.balanceAfter.equals(brl(97_500n))).toBe(true);
  });

  test('debitar exatamente o saldo leva a zero', () => {
    const { wallet } = openWallet(8_000n);

    wallet.debit(movement(brl(8_000n)));

    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente lança InsufficientFundsError e não altera a wallet', () => {
    const { wallet } = openWallet(8_000n);
    const before = snapshot(wallet);

    expect(() => wallet.debit(movement(brl(8_001n)))).toThrow(InsufficientFundsError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test('InsufficientFundsError informa wallet, saldo e valor pedido', () => {
    const { wallet } = openWallet(1_000n);
    let caught: unknown;

    try {
      wallet.debit(movement(brl(1_500n)));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InsufficientFundsError);
    const insufficient = caught as InsufficientFundsError;
    expect(insufficient.walletId).toBe('wallet-1');
    expect(insufficient.balance.equals(brl(1_000n))).toBe(true);
    expect(insufficient.requested.equals(brl(1_500n))).toBe(true);
  });
});

describe('Wallet.credit', () => {
  test('credita, incrementa a versão e devolve o lançamento CREDIT', () => {
    const { wallet } = openWallet(0n);

    const entry = wallet.credit(movement(brl(5_000n), 10));

    expect(wallet.balance.equals(brl(5_000n))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.getTime()).toBe(at(10).getTime());
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.isZero()).toBe(true);
  });

  test('mantém precisão além de Number.MAX_SAFE_INTEGER', () => {
    const { wallet } = openWallet(9_007_199_254_740_993n);

    wallet.credit(movement(brl(2n)));

    expect(wallet.balance.cents).toBe(9_007_199_254_740_995n);
  });
});

describe('Wallet: movimentações inválidas não alteram o estado', () => {
  test.each([
    ['debit', (w: Wallet, m: WalletMovement) => w.debit(m)],
    ['credit', (w: Wallet, m: WalletMovement) => w.credit(m)],
  ])('%s em outra moeda lança CurrencyMismatchError', (_name, operation) => {
    const { wallet } = openWallet(10_000n);
    const before = snapshot(wallet);

    expect(() => operation(wallet, movement(Money.fromCents(100n, 'USD')))).toThrow(
      CurrencyMismatchError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each([
    ['debit zero', (w: Wallet) => w.debit(movement(brl(0n)))],
    ['credit zero', (w: Wallet) => w.credit(movement(brl(0n)))],
    ['debit negativo', (w: Wallet) => w.debit(movement(brl(-100n)))],
    ['credit negativo', (w: Wallet) => w.credit(movement(brl(-100n)))],
  ])('%s é rejeitado: sem alteração de saldo não há lançamento', (_name, operation) => {
    const { wallet } = openWallet(10_000n);
    const before = snapshot(wallet);

    expect(() => operation(wallet)).toThrow(InvalidWalletOperationError);
    expect(snapshot(wallet)).toEqual(before);
  });

  test.each([
    ['transactionId vazio', { transactionId: '' }],
    ['ledgerEntryId vazio', { ledgerEntryId: '' }],
    ['data inválida', { at: new Date('invalid') }],
  ])('lançamento inválido (%s) não altera a wallet', (_case, overrides) => {
    const { wallet } = openWallet(10_000n);
    const before = snapshot(wallet);

    expect(() => wallet.credit({ ...movement(brl(100n)), ...overrides })).toThrow();
    expect(snapshot(wallet)).toEqual(before);
  });

  test('money que não é Money é rejeitado', () => {
    const { wallet } = openWallet(10_000n);
    const fake = { cents: 100n, currency: 'BRL' } as unknown as Money;

    expect(() => wallet.debit(movement(fake))).toThrow(InvalidWalletOperationError);
  });
});

describe('Wallet: invariantes de saldo, versão e ledger', () => {
  test('cenário §8 (sequencial): 100.00 e duas apostas de 80.00 → um débito, saldo 20.00', () => {
    const { wallet, openingEntry } = openWallet(10_000n);
    const ledger: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];

    ledger.push(wallet.debit(movement(brl(8_000n))));
    expect(() => wallet.debit(movement(brl(8_000n)))).toThrow(InsufficientFundsError);

    expect(wallet.balance.toProps()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(ledger.filter((entry) => entry.direction === 'DEBIT')).toHaveLength(1);
    expect(wallet.version).toBe(2);
  });

  test('version incrementa uma vez por movimentação aplicada e nunca em falhas', () => {
    const { wallet } = openWallet(10_000n);

    wallet.credit(movement(brl(500n)));
    expect(() => wallet.debit(movement(brl(1_000_000n)))).toThrow(InsufficientFundsError);
    wallet.debit(movement(brl(500n)));

    expect(wallet.version).toBe(3);
  });

  test('saldo da wallet == saldo reconstruído pelo ledger, com lançamentos encadeados', () => {
    const { wallet, openingEntry } = openWallet(100_000n);
    const ledger: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];

    ledger.push(wallet.debit(movement(brl(2_500n))));
    ledger.push(wallet.credit(movement(brl(5_000n))));
    ledger.push(wallet.debit(movement(brl(102_500n))));
    ledger.push(wallet.credit(movement(brl(1n))));

    expect(replay(ledger).equals(wallet.balance)).toBe(true);
    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i]?.balanceBefore.equals(ledger[i - 1]?.balanceAfter as Money)).toBe(true);
    }
    expect(ledger.every((entry) => entry.isBalanced())).toBe(true);
    // A abertura não incrementa a versão; cada movimentação posterior incrementa uma vez.
    expect(wallet.version).toBe(ledger.length);
  });
});

describe('Wallet.rehydrate e encapsulamento', () => {
  test('rehydrate reconstrói o estado persistido sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      balance: brl(4_200n),
      version: 7,
      createdAt: T0,
      updatedAt: at(60),
    });

    expect(wallet.balance.equals(brl(4_200n))).toBe(true);
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt.getTime()).toBe(at(60).getTime());

    wallet.debit(movement(brl(200n)));
    expect(wallet.version).toBe(8);
  });

  test('estado só muda por debit/credit: campos protegidos e datas copiadas', () => {
    const openedAt = new Date(T0.getTime());
    const { wallet } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl(0n), openedAt });

    expect(Object.isFrozen(wallet)).toBe(true);
    expect(() => {
      (wallet as unknown as { id: string }).id = 'other';
    }).toThrow(TypeError);
    expect(() => {
      (wallet as unknown as { balance: Money }).balance = brl(1n);
    }).toThrow(TypeError);
    openedAt.setUTCFullYear(2000);
    wallet.updatedAt.setUTCFullYear(1999);

    expect(wallet.id).toBe('w');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.createdAt.getTime()).toBe(T0.getTime());
    expect(wallet.updatedAt.getTime()).toBe(T0.getTime());
  });
});
