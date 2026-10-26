import { describe, expect, test } from 'bun:test';
import { OpenWallet } from '../../src/application/open-wallet';
import {
  type OpenedWallet,
  WalletAlreadyExistsError,
  type WalletRepository,
} from '../../src/application/wallet-repository';
import { CurrencyMismatchError, Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { InvalidWalletOperationError } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
const NOW = new Date('2026-10-25T12:00:00.000Z');

/** Repositório em memória: guarda o que recebe e recusa player + moeda repetidos, como o banco. */
class InMemoryWalletRepository implements WalletRepository {
  readonly saved: OpenedWallet[] = [];

  async insertOpened(opened: OpenedWallet): Promise<void> {
    const { playerId, currency } = opened.wallet;
    if (this.saved.some((s) => s.wallet.playerId === playerId && s.wallet.currency === currency)) {
      throw new WalletAlreadyExistsError(playerId, currency);
    }
    this.saved.push(opened);
  }
}

function setup() {
  const repository = new InMemoryWalletRepository();
  let sequence = 0;
  const useCase = new OpenWallet(
    repository,
    () => NOW,
    () => `id-${++sequence}`,
    () => 'corr-1',
  );
  return { repository, useCase };
}

describe('OpenWallet', () => {
  test('a correlação gerada para a abertura segue para a persistência', async () => {
    const { repository, useCase } = setup();

    await useCase.execute({ playerId: 'player-1', initialBalance: brl(100n) });

    expect(repository.saved[0]?.correlationId).toBe('corr-1');
  });

  test('saldo inicial zero: só a wallet, sem OPENING nem lançamento', async () => {
    const { repository, useCase } = setup();

    const wallet = await useCase.execute({ playerId: 'player-1', initialBalance: brl(0n) });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0]?.opening).toBeNull();
    expect(repository.saved[0]?.openingEntry).toBeNull();
  });

  test('saldo inicial positivo: wallet, OPENING processada e CREDIT coerentes entre si', async () => {
    const { repository, useCase } = setup();

    const wallet = await useCase.execute({ playerId: 'player-1', initialBalance: brl(100_000n) });

    const saved = repository.saved[0] as OpenedWallet;
    const opening = saved.opening;
    const entry = saved.openingEntry;
    expect(saved.wallet).toBe(wallet);
    expect(wallet.balance.equals(brl(100_000n))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(opening?.kind).toBe(WagerTransactionKind.Opening);
    expect(opening?.status).toBe(WagerTransactionStatus.Processed);
    expect(opening?.walletId).toBe(wallet.id);
    expect(opening?.playerId).toBe('player-1');
    expect(opening?.money.equals(wallet.balance)).toBe(true);
    expect(opening?.idempotencyKey).toBeUndefined();
    expect(entry?.walletId).toBe(wallet.id);
    expect(entry?.transactionId).toBe(opening?.id as string);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.isZero()).toBe(true);
    expect(entry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry?.money.equals(wallet.balance)).toBe(true);
  });

  test('usa ids distintos e o mesmo instante para wallet, OPENING e lançamento', async () => {
    const { repository, useCase } = setup();

    await useCase.execute({ playerId: 'player-1', initialBalance: brl(1n) });

    const { wallet, opening, openingEntry } = repository.saved[0] as OpenedWallet;
    expect(new Set([wallet.id, opening?.id, openingEntry?.id]).size).toBe(3);
    expect(
      [wallet.createdAt, opening?.createdAt, openingEntry?.createdAt].map((d) => d?.getTime()),
    ).toEqual([NOW.getTime(), NOW.getTime(), NOW.getTime()]);
  });

  test('a moeda da wallet é a do saldo inicial', async () => {
    const { useCase } = setup();

    const wallet = await useCase.execute({
      playerId: 'player-1',
      initialBalance: Money.fromCents(500n, 'USD'),
    });

    expect(wallet.currency).toBe('USD');
  });

  test('saldo inicial negativo é recusado sem gravar nada', async () => {
    const { repository, useCase } = setup();

    await expect(
      useCase.execute({ playerId: 'player-1', initialBalance: brl(-1n) }),
    ).rejects.toThrow(InvalidWalletOperationError);
    expect(repository.saved).toHaveLength(0);
  });

  test('playerId vazio é recusado sem gravar nada', async () => {
    const { repository, useCase } = setup();

    await expect(useCase.execute({ playerId: ' ', initialBalance: brl(100n) })).rejects.toThrow();
    expect(repository.saved).toHaveLength(0);
  });

  test('wallet duplicada para o mesmo player e moeda é conflito e não grava nada novo', async () => {
    const { repository, useCase } = setup();
    await useCase.execute({ playerId: 'player-1', initialBalance: brl(100n) });

    await expect(
      useCase.execute({ playerId: 'player-1', initialBalance: brl(200n) }),
    ).rejects.toThrow(WalletAlreadyExistsError);
    expect(repository.saved).toHaveLength(1);
  });

  test('o mesmo player pode ter wallets em moedas diferentes', async () => {
    const { repository, useCase } = setup();
    await useCase.execute({ playerId: 'player-1', initialBalance: brl(100n) });

    await useCase.execute({ playerId: 'player-1', initialBalance: Money.fromCents(100n, 'USD') });

    expect(repository.saved).toHaveLength(2);
  });

  test('não mistura moedas: o lançamento herda a moeda do saldo inicial', async () => {
    const { repository, useCase } = setup();

    await useCase.execute({ playerId: 'player-1', initialBalance: Money.fromCents(100n, 'USD') });

    const { wallet, openingEntry } = repository.saved[0] as OpenedWallet;
    expect(openingEntry?.money.currency).toBe('USD');
    expect(() => wallet.balance.add(brl(1n))).toThrow(CurrencyMismatchError);
  });
});
