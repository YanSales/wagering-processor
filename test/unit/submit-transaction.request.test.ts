import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError, Money } from '../../src/domain/money';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import {
  InvalidSubmissionRequestError,
  parseSubmissionRequest,
  toSubmissionResponse,
} from '../../src/wagering/submit-transaction.request';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const KEY = 'provider-a:transaction-123';

/** Corpo do exemplo do contrato §9. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const without = (field: string) => {
  const copy = body();
  delete copy[field];
  return copy;
};

describe('parseSubmissionRequest', () => {
  test('converte o exemplo do contrato no comando do caso de uso, com centavos bigint', () => {
    const command = parseSubmissionRequest(KEY, body());

    expect(command).toEqual({
      idempotencyKey: KEY,
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: WALLET_ID,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: expect.anything(),
    });
    expect(command.money).toBeInstanceOf(Money);
    expect(command.money.cents).toBe(2_500n);
    expect(command.money.currency).toBe('BRL');
    expect('referenceExternalTransactionId' in command).toBe(false);
  });

  test('valor acima de Number.MAX_SAFE_INTEGER centavos é lido sem perda', () => {
    const command = parseSubmissionRequest(
      KEY,
      body({ money: { amount: '90071992547409.93', currency: 'BRL' } }),
    );

    expect(command.money.cents).toBe(9_007_199_254_740_993n);
  });

  test('repassa referenceExternalTransactionId quando presente e ignora campos extras', () => {
    const command = parseSubmissionRequest(
      KEY,
      body({ referenceExternalTransactionId: 'transaction-100', extra: true }),
    );

    expect(command.referenceExternalTransactionId).toBe('transaction-100');
    expect('extra' in command).toBe(false);
  });

  test.each(['WIN', 'LOSS', 'REFUND', 'ROLLBACK'])(
    'aceita a forma de %s (o processamento decide se é suportado)',
    (kind) => {
      expect(parseSubmissionRequest(KEY, body({ kind })).kind).toBe(kind);
    },
  );

  test.each([
    ['Idempotency-Key ausente', undefined, body()],
    ['Idempotency-Key vazia', '   ', body()],
    ['Idempotency-Key repetida (array)', [KEY, KEY], body()],
    ['corpo ausente', KEY, undefined],
    ['corpo array', KEY, [body()]],
    ['corpo string', KEY, '{}'],
    ...[
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
    ].map((field) => [`${field} ausente`, KEY, without(field)] as const),
    ['providerId vazio', KEY, body({ providerId: '' })],
    ['playerId numérico', KEY, body({ playerId: 42 })],
    ['roundId só com espaços', KEY, body({ roundId: '  ' })],
    ['gameId com NUL', KEY, body({ gameId: 'game\u0000x' })],
    ['walletId que não é UUID', KEY, body({ walletId: 'wallet-1' })],
    ['kind OPENING (interno)', KEY, body({ kind: 'OPENING' })],
    ['kind desconhecido', KEY, body({ kind: 'JACKPOT' })],
    ['kind minúsculo', KEY, body({ kind: 'bet' })],
    ['money ausente', KEY, without('money')],
    ['money string', KEY, body({ money: '25.00 BRL' })],
    ['referência vazia', KEY, body({ referenceExternalTransactionId: '' })],
  ])('recusa forma inválida: %s', (_case, key, input) => {
    expect(() => parseSubmissionRequest(key, input)).toThrow(InvalidSubmissionRequestError);
  });

  test.each([
    ['amount numérico', { amount: 25, currency: 'BRL' }],
    ['sem casas decimais', { amount: '25', currency: 'BRL' }],
    ['três casas decimais', { amount: '25.000', currency: 'BRL' }],
    ['negativo', { amount: '-25.00', currency: 'BRL' }],
    ['notação científica', { amount: '1e3', currency: 'BRL' }],
    ['vírgula decimal', { amount: '25,00', currency: 'BRL' }],
    ['moeda minúscula', { amount: '25.00', currency: 'brl' }],
    ['moeda com 4 letras', { amount: '25.00', currency: 'BRLX' }],
    ['moeda ausente', { amount: '25.00' }],
  ])('recusa money inválido (§6.1): %s', (_case, money) => {
    expect(() => parseSubmissionRequest(KEY, body({ money }))).toThrow(InvalidMoneyError);
  });
});

describe('toSubmissionResponse', () => {
  test('PROCESSED: forma do contrato §9, sem failureCode', () => {
    expect(
      toSubmissionResponse({
        transactionId: 'tx-1',
        status: WagerTransactionStatus.Processed,
        balance: Money.fromCents(97_500n, 'BRL'),
        failureCode: undefined,
        idempotentReplay: false,
      }),
    ).toEqual({
      transactionId: 'tx-1',
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  test('REJECTED: inclui o failureCode (§7.2) e o saldo observado', () => {
    expect(
      toSubmissionResponse({
        transactionId: 'tx-2',
        status: WagerTransactionStatus.Rejected,
        balance: Money.fromCents(2_000n, 'BRL'),
        failureCode: 'INSUFFICIENT_FUNDS',
        idempotentReplay: true,
      }),
    ).toEqual({
      transactionId: 'tx-2',
      status: 'REJECTED',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: true,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });
});
