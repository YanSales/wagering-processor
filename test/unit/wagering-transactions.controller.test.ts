import { describe, expect, test } from 'bun:test';
import { HttpException } from '@nestjs/common';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  type SubmissionResult,
  type SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
  UnsupportedSubmissionError,
} from '../../src/application/submit-wager-transaction';
import {
  TransientPersistenceError,
  WalletNotFoundError,
} from '../../src/application/wager-transaction-repository';
import { AmountOutOfStorageRangeError } from '../../src/application/wallet-repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { WageringTransactionsController } from '../../src/wagering/wagering-transactions.controller';

const KEY = 'provider-a:transaction-123';
const BODY = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

/** Caso de uso falso: registra os comandos e devolve o resultado ou lança o erro configurado. */
function setup(outcome: SubmissionResult | Error) {
  const calls: SubmitWagerTransactionCommand[] = [];
  const useCase = {
    async execute(command: SubmitWagerTransactionCommand) {
      calls.push(command);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  } as unknown as SubmitWagerTransaction;
  const statuses: number[] = [];
  const response = { status: (code: number) => statuses.push(code) };
  return { controller: new WageringTransactionsController(useCase), calls, statuses, response };
}

const result = (status: WagerTransactionStatus, failureCode?: string): SubmissionResult => ({
  transactionId: 'tx-1',
  status,
  balance: Money.fromCents(7_500n, 'BRL'),
  failureCode,
  idempotentReplay: false,
});

async function httpError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return { status: http.getStatus(), body: http.getResponse() as Record<string, unknown> };
}

describe('WageringTransactionsController.submit', () => {
  test('PROCESSED: 200 e corpo do contrato; o comando chega com a chave e centavos bigint', async () => {
    const { controller, calls, statuses, response } = setup(
      result(WagerTransactionStatus.Processed),
    );

    const body = await controller.submit(KEY, BODY, response);

    expect(statuses).toEqual([200]);
    expect(body).toEqual({
      transactionId: 'tx-1',
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.idempotencyKey).toBe(KEY);
    expect(calls[0]?.money.cents).toBe(2_500n);
  });

  test('REJECTED: 422 com o resultado gravado (não um envelope de erro)', async () => {
    const { controller, statuses, response } = setup(
      result(WagerTransactionStatus.Rejected, 'INSUFFICIENT_FUNDS'),
    );

    const body = await controller.submit(KEY, BODY, response);

    expect(statuses).toEqual([422]);
    expect(body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('PENDING_REFERENCE: 202, aceito e gravado, ainda não aplicado', async () => {
    const { controller, statuses, response } = setup(
      result(WagerTransactionStatus.PendingReference),
    );

    const body = await controller.submit(KEY, BODY, response);

    expect(statuses).toEqual([202]);
    expect(body).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(body).not.toHaveProperty('failureCode');
  });

  test.each([
    ['sem Idempotency-Key', undefined, BODY],
    ['money inválido', KEY, { ...BODY, money: { amount: '25', currency: 'BRL' } }],
    ['walletId inválido', KEY, { ...BODY, walletId: 'x' }],
    ['kind OPENING', KEY, { ...BODY, kind: 'OPENING' }],
  ])(
    'entrada inválida (%s): 400 INVALID_REQUEST sem chamar o caso de uso',
    async (_c, key, body) => {
      const { controller, calls, response } = setup(result(WagerTransactionStatus.Processed));

      const error = await httpError(controller.submit(key, body, response));

      expect(error.status).toBe(400);
      expect(error.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_REQUEST',
      });
      expect(calls).toEqual([]);
    },
  );

  test.each([
    [new IdempotencyConflictError(KEY), 409, 'IDEMPOTENCY_KEY_CONFLICT'],
    [
      new DuplicateExternalTransactionError(
        { idempotencyKey: KEY, providerId: 'provider-a', externalTransactionId: 'transaction-123' },
        'chave-original',
      ),
      409,
      'DUPLICATE_EXTERNAL_TRANSACTION',
    ],
    [new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    [new UnsupportedSubmissionError('WIN ainda não'), 501, 'UNSUPPORTED_SUBMISSION'],
    [
      new AmountOutOfStorageRangeError(Money.fromCents(10n ** 30n, 'BRL'), -1n, 1n),
      400,
      'INVALID_REQUEST',
    ],
    [new TransientPersistenceError({ cause: new Error('x') }), 503, 'TRANSIENT_FAILURE'],
  ])('%s → %i %s', async (failure, status, code) => {
    const { controller, response } = setup(failure);

    const error = await httpError(controller.submit(KEY, BODY, response));

    expect(error.status).toBe(status);
    expect(error.body).toMatchObject({ statusCode: status, code });
  });

  test('operação externa duplicada não expõe a chave de idempotência original', async () => {
    const { controller, response } = setup(
      new DuplicateExternalTransactionError(
        { idempotencyKey: KEY, providerId: 'provider-a', externalTransactionId: 'transaction-123' },
        'chave-original-secreta',
      ),
    );

    const error = await httpError(controller.submit(KEY, BODY, response));

    expect(JSON.stringify(error.body)).not.toContain('chave-original-secreta');
  });

  test('falha transitória: mensagem fixa, sem a causa do driver', async () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.5:5432 senha=segredo');
    const { controller, response } = setup(new TransientPersistenceError({ cause }));

    const error = await httpError(controller.submit(KEY, BODY, response));

    expect(JSON.stringify(error.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(error.body)).not.toContain('segredo');
  });

  test('erro inesperado é propagado sem reclassificação (vira o 500 genérico do Nest)', async () => {
    const unexpected = new Error('bug');
    const { controller, response } = setup(unexpected);

    await expect(controller.submit(KEY, BODY, response)).rejects.toBe(unexpected);
  });
});
