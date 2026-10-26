import { describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AmountOutOfStorageRangeError } from '../../src/application/wallet-repository';
import {
  MikroOrmWalletRepository,
  PG_BIGINT_MAX,
  PG_BIGINT_MIN,
} from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const NOW = new Date('2026-10-25T12:00:00.000Z');

/** ORM falso: só registra se o repositório tentou abrir uma unidade de trabalho. */
function fakeOrm() {
  const calls = { fork: 0 };
  const orm = {
    em: {
      fork() {
        calls.fork += 1;
        return { transactional: async () => undefined };
      },
    },
  } as unknown as MikroORM;
  return { orm, calls };
}

function opened(cents: bigint) {
  const initialBalance = Money.fromCents(cents, 'BRL');
  const opening = WagerTransaction.opening({
    id: 'opening-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    money: initialBalance,
    at: NOW,
  });
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    openedAt: NOW,
    opening: { transactionId: opening.id, ledgerEntryId: 'entry-1' },
  });
  return { wallet, opening, openingEntry, correlationId: 'corr-1' };
}

describe('MikroOrmWalletRepository: faixa do bigint do PostgreSQL', () => {
  test('a faixa é a de um inteiro de 64 bits com sinal', () => {
    expect(PG_BIGINT_MAX).toBe(2n ** 63n - 1n);
    expect(PG_BIGINT_MIN).toBe(-(2n ** 63n));
  });

  test('o maior valor armazenável segue para a transação', async () => {
    const { orm, calls } = fakeOrm();

    await new MikroOrmWalletRepository(orm).insertOpened(opened(PG_BIGINT_MAX));

    expect(calls.fork).toBe(1);
  });

  test('um centavo acima do máximo é recusado antes de abrir a transação', async () => {
    const { orm, calls } = fakeOrm();

    const attempt = new MikroOrmWalletRepository(orm).insertOpened(opened(PG_BIGINT_MAX + 1n));

    await expect(attempt).rejects.toBeInstanceOf(AmountOutOfStorageRangeError);
    await expect(attempt).rejects.toThrow(
      'o valor 92233720368547758.08 BRL está fora da faixa armazenável ' +
        '(de -92233720368547758.08 a 92233720368547758.07).',
    );
    expect(calls.fork).toBe(0);
  });

  test('o erro carrega o valor exato e os limites, em bigint', async () => {
    const { orm } = fakeOrm();
    const tooLarge = 10n ** 40n;

    const error = await new MikroOrmWalletRepository(orm)
      .insertOpened(opened(tooLarge))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AmountOutOfStorageRangeError);
    const range = error as AmountOutOfStorageRangeError;
    expect(range.money.cents).toBe(tooLarge);
    expect(range.minCents).toBe(PG_BIGINT_MIN);
    expect(range.maxCents).toBe(PG_BIGINT_MAX);
  });
});
