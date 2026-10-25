import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  type LedgerEntryState,
  WalletLedgerEntry,
} from '../../src/domain/wallet-ledger-entry';

const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');

const debit = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl(2_500n),
  balanceBefore: brl(100_000n),
  balanceAfter: brl(97_500n),
  createdAt: new Date('2026-10-25T12:00:00.000Z'),
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  test('cria débito balanceado: before - money = after', () => {
    const entry = WalletLedgerEntry.create(debit());

    expect(entry.direction).toBe('DEBIT');
    expect(entry.balanceAfter.equals(brl(97_500n))).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test('cria crédito balanceado: before + money = after', () => {
    const entry = WalletLedgerEntry.create(
      debit({ direction: LedgerDirection.Credit, balanceAfter: brl(102_500n) }),
    );

    expect(entry.direction).toBe('CREDIT');
    expect(entry.isBalanced()).toBe(true);
  });

  test('débito que zera o saldo é válido', () => {
    const entry = WalletLedgerEntry.create(
      debit({ balanceBefore: brl(2_500n), balanceAfter: brl(0n) }),
    );

    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test.each([
    ['débito com saldo posterior errado', debit({ balanceAfter: brl(97_501n) })],
    ['crédito calculado como débito', debit({ direction: LedgerDirection.Credit })],
    ['débito calculado como crédito', debit({ balanceAfter: brl(102_500n) })],
  ])('rejeita aritmética inválida: %s', (_case, state) => {
    expect(() => WalletLedgerEntry.create(state)).toThrow(InvalidLedgerEntryError);
  });

  test.each([
    ['zero', 0n],
    ['negativo', -2_500n],
  ])('rejeita valor %s (todo lançamento altera o saldo)', (_case, cents) => {
    const state = debit({ money: brl(cents), balanceAfter: brl(100_000n - cents) });

    expect(() => WalletLedgerEntry.create(state)).toThrow('deve ser positivo');
  });

  test('rejeita saldo negativo, mesmo com aritmética correta', () => {
    const state = debit({ balanceBefore: brl(1_000n), balanceAfter: brl(-1_500n) });

    expect(() => WalletLedgerEntry.create(state)).toThrow('não podem ser negativos');
  });

  test.each([
    ['money', { money: Money.fromCents(2_500n, 'USD') }],
    ['balanceBefore', { balanceBefore: Money.fromCents(100_000n, 'USD') }],
    ['balanceAfter', { balanceAfter: Money.fromCents(97_500n, 'USD') }],
  ])('rejeita moeda divergente em %s', (_case, overrides) => {
    expect(() => WalletLedgerEntry.create(debit(overrides))).toThrow('moedas divergentes');
  });

  test.each([
    ['id vazio', { id: '' }],
    ['walletId em branco', { walletId: '  ' }],
    ['transactionId ausente', { transactionId: undefined as unknown as string }],
    ['direção desconhecida', { direction: 'REFUND' as unknown as LedgerDirection }],
    ['money que não é Money', { money: { cents: 2_500n } as unknown as Money }],
    ['data inválida', { createdAt: new Date('invalid') }],
    ['data que não é Date', { createdAt: '2026-10-25' as unknown as Date }],
  ])('rejeita %s', (_case, overrides) => {
    expect(() => WalletLedgerEntry.create(debit(overrides))).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry: imutabilidade estrutural', () => {
  test('a instância é congelada', () => {
    const entry = WalletLedgerEntry.create(debit());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl(0n);
    }).toThrow(TypeError);
    expect(entry.balanceAfter.equals(brl(97_500n))).toBe(true);
  });

  test('não expõe métodos de transição', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(methods.sort()).toEqual(['createdAt', 'isBalanced']);
  });

  test('a data é copiada na entrada e na saída', () => {
    const createdAt = new Date('2026-10-25T12:00:00.000Z');
    const entry = WalletLedgerEntry.create(debit({ createdAt }));

    createdAt.setUTCFullYear(2000);
    entry.createdAt.setUTCFullYear(1999);

    expect(entry.createdAt.toISOString()).toBe('2026-10-25T12:00:00.000Z');
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar', () => {
    const entry = WalletLedgerEntry.rehydrate(debit({ balanceAfter: brl(1n) }));

    expect(entry.balanceAfter.equals(brl(1n))).toBe(true);
    expect(entry.isBalanced()).toBe(false);
  });
});
