import { describe, expect, test } from 'bun:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { OpenWallet } from '../../src/application/open-wallet';
import {
  AmountOutOfStorageRangeError,
  type OpenedWallet,
  WalletAlreadyExistsError,
  type WalletRepository,
} from '../../src/application/wallet-repository';
import { InvalidMoneyError, Money } from '../../src/domain/money';
import {
  InvalidOpenWalletRequestError,
  parseOpenWalletRequest,
} from '../../src/wallets/open-wallet.request';
import { WalletsController } from '../../src/wallets/wallets.controller';

const NOW = new Date('2026-10-25T12:00:00.000Z');

/** Repositório configurável: grava o que recebe ou lança o erro informado. */
class FakeWalletRepository implements WalletRepository {
  readonly saved: OpenedWallet[] = [];

  constructor(private readonly failure?: Error) {}

  async insertOpened(opened: OpenedWallet): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    this.saved.push(opened);
  }
}

function setup(failure?: Error) {
  const repository = new FakeWalletRepository(failure);
  let sequence = 0;
  const useCase = new OpenWallet(
    repository,
    () => NOW,
    () => `id-${++sequence}`,
  );
  return { repository, controller: new WalletsController(useCase) };
}

const body = (amount: unknown, currency: unknown = 'BRL', playerId: unknown = 'player-1') => ({
  playerId,
  initialBalance: { amount, currency },
});

describe('parseOpenWalletRequest', () => {
  test('lê playerId e initialBalance como Money em centavos bigint', () => {
    const command = parseOpenWalletRequest(body('1000.00'));

    expect(command.playerId).toBe('player-1');
    expect(command.initialBalance.cents).toBe(100_000n);
    expect(command.initialBalance.currency).toBe('BRL');
  });

  test('valor acima de Number.MAX_SAFE_INTEGER centavos é lido sem perda', () => {
    expect(parseOpenWalletRequest(body('90071992547409.93')).initialBalance.cents).toBe(
      9_007_199_254_740_993n,
    );
  });

  test('ignora campos extras', () => {
    const command = parseOpenWalletRequest({ ...body('1.00'), version: 7 });

    expect(command).toEqual(parseOpenWalletRequest(body('1.00')));
  });

  test.each([
    ['corpo nulo', null],
    ['corpo array', [body('1.00')]],
    ['corpo string', '{"playerId":"p"}'],
    ['sem playerId', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['playerId vazio', body('1.00', 'BRL', '')],
    ['playerId só com espaços', body('1.00', 'BRL', '   ')],
    ['playerId numérico', body('1.00', 'BRL', 42)],
    ['playerId com NUL', body('1.00', 'BRL', 'player\u0000x')],
    ['sem initialBalance', { playerId: 'player-1' }],
    ['initialBalance string', { playerId: 'player-1', initialBalance: '1.00 BRL' }],
    ['initialBalance array', { playerId: 'player-1', initialBalance: ['1.00', 'BRL'] }],
  ])('recusa forma inválida: %s', (_case, input) => {
    expect(() => parseOpenWalletRequest(input)).toThrow(InvalidOpenWalletRequestError);
  });

  test.each([
    ['negativo', body('-1.00')],
    ['número em vez de string', body(1000)],
    ['sem casas decimais', body('1000')],
    ['uma casa decimal', body('1000.5')],
    ['três casas decimais', body('1000.000')],
    ['notação científica', body('1e3')],
    ['string vazia', body('')],
    ['NaN', body('NaN')],
    ['Infinity', body('Infinity')],
    ['moeda minúscula', body('1.00', 'brl')],
    ['moeda com 4 letras', body('1.00', 'BRLX')],
    ['moeda ausente', { playerId: 'player-1', initialBalance: { amount: '1.00' } }],
  ])('recusa valor monetário inválido (§6.1): %s', (_case, input) => {
    expect(() => parseOpenWalletRequest(input)).toThrow(InvalidMoneyError);
  });
});

describe('WalletsController.open', () => {
  test('saldo positivo: responde a wallet no formato do contrato e persiste pelo caso de uso', async () => {
    const { controller, repository } = setup();

    const response = await controller.open(body('1000.00'));

    expect(response).toEqual({
      id: 'id-1',
      playerId: 'player-1',
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(repository.saved).toHaveLength(1);
    expect(repository.saved[0]?.opening?.id).toBe('id-2');
    expect(repository.saved[0]?.openingEntry?.balanceAfter.cents).toBe(100_000n);
  });

  test('saldo zero: só a wallet, com balance "0.00"', async () => {
    const { controller, repository } = setup();

    const response = await controller.open(body('0.00'));

    expect(response.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(repository.saved[0]?.opening).toBeNull();
    expect(repository.saved[0]?.openingEntry).toBeNull();
  });

  test('payload inválido vira 400 sem chamar o repositório', async () => {
    const { controller, repository } = setup();

    await expect(controller.open(body('-1.00'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.open({ playerId: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.saved).toEqual([]);
  });

  test('wallet duplicada vira 409', async () => {
    const { controller } = setup(new WalletAlreadyExistsError('player-1', 'BRL'));

    await expect(controller.open(body('1.00'))).rejects.toBeInstanceOf(ConflictException);
  });

  test('saldo fora da faixa armazenável vira 400 citando initialBalance', async () => {
    const outOfRange = new AmountOutOfStorageRangeError(
      Money.fromCents(9_223_372_036_854_775_808n, 'BRL'),
      -9_223_372_036_854_775_808n,
      9_223_372_036_854_775_807n,
    );
    const { controller } = setup(outOfRange);

    const error = await controller.open(body('92233720368547758.08')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(`initialBalance: ${outOfRange.message}`);
  });

  test('erro inesperado é propagado sem ser reclassificado como 400 ou 409', async () => {
    const unexpected = new Error('falha de infraestrutura');
    const { controller } = setup(unexpected);

    await expect(controller.open(body('1.00'))).rejects.toBe(unexpected);
  });
});
