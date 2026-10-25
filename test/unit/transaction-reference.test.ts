import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import {
  InvalidReferenceError,
  type ReferenceViolation,
  UnsupportedReferenceError,
  validateReference,
} from '../../src/domain/transaction-reference';
import {
  type CreateWagerTransactionProps,
  type WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction';
import { brl, processed, reversalOf, wager } from '../support/wager-fixtures';

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;

function violationOf(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): ReferenceViolation {
  try {
    validateReference(transaction, reference);
  } catch (error) {
    if (error instanceof InvalidReferenceError) {
      return error.violation;
    }
    throw error;
  }
  throw new Error('validateReference deveria ter lançado InvalidReferenceError');
}

describe('validateReference: combinações válidas (contrato §7)', () => {
  test('REFUND de uma BET processada de mesmo valor', () => {
    const bet = processed(Bet, 'bet-1');

    expect(() => validateReference(reversalOf(Refund, 'refund-1', bet), bet)).not.toThrow();
  });

  test.each([
    ['BET', () => processed(Bet, 'bet-1')],
    ['WIN', () => processed(Win, 'win-1')],
    [
      'REFUND',
      () => {
        const bet = processed(Bet, 'bet-1');
        return processed(
          Refund,
          'refund-1',
          {
            referenceExternalTransactionId: bet.externalTransactionId,
          },
          bet.id,
        );
      },
    ],
  ])('ROLLBACK de um %s processado de mesmo valor', (_kind, makeReference) => {
    const reference = makeReference();

    expect(() =>
      validateReference(reversalOf(Rollback, 'rollback-1', reference), reference),
    ).not.toThrow();
  });

  test('WIN que referencia uma BET processada da mesma rodada', () => {
    const bet = processed(Bet, 'bet-1');
    const win = wager(Win, 'win-1', { referenceExternalTransactionId: bet.externalTransactionId });

    expect(() => validateReference(win, bet)).not.toThrow();
  });

  test('não altera a transação nem a referência', () => {
    const bet = processed(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', bet);

    validateReference(refund, bet);

    expect(refund.status).toBe('PENDING');
    expect(bet.status).toBe('PROCESSED');
  });
});

describe('validateReference: regra 2 — resolução e pertencimento', () => {
  test('referência de outro provider não é a transação referenciada', () => {
    const bet = processed(Bet, 'bet-1', { providerId: 'provider-b' });

    expect(violationOf(reversalOf(Refund, 'refund-1', bet), bet)).toBe(
      'NOT_THE_REFERENCED_TRANSACTION',
    );
  });

  test('referência cujo id externo não é o referenciado', () => {
    const bet = processed(Bet, 'bet-1');
    const other = processed(Bet, 'bet-2');

    expect(violationOf(reversalOf(Refund, 'refund-1', bet), other)).toBe(
      'NOT_THE_REFERENCED_TRANSACTION',
    );
  });

  test.each([
    ['DIFFERENT_PLAYER', { playerId: 'player-2' }],
    ['DIFFERENT_WALLET', { walletId: 'wallet-2' }],
    ['DIFFERENT_ROUND', { roundId: 'round-2' }],
    ['DIFFERENT_CURRENCY', { money: Money.fromCents(2_500n, 'USD') }],
  ] as Array<[ReferenceViolation, Partial<CreateWagerTransactionProps>]>)(
    '%s',
    (violation, referenceOverrides) => {
      const bet = processed(Bet, 'bet-1', referenceOverrides);
      const refund = reversalOf(Refund, 'refund-1', bet, { money: brl(2_500n) });

      expect(violationOf(refund, bet)).toBe(violation);
    },
  );
});

describe('validateReference: regra 3 e tabela — tipos permitidos', () => {
  test.each([
    ['REFUND de WIN', Refund, Win],
    ['REFUND de REFUND', Refund, Refund],
    ['ROLLBACK de ROLLBACK', Rollback, Rollback],
    ['ROLLBACK de LOSS', Rollback, Loss],
    ['WIN de WIN', Win, Win],
  ] as const)('%s não é permitido', (_case, kind, referenceKind) => {
    const reference =
      referenceKind === Refund || referenceKind === Rollback
        ? processed(referenceKind, 'ref-1', { referenceExternalTransactionId: 'ext-x' }, 'tx-x')
        : processed(referenceKind, 'ref-1');
    const transaction = wager(kind, 'tx-1', {
      referenceExternalTransactionId: reference.externalTransactionId,
      money: reference.money,
    });

    expect(violationOf(transaction, reference)).toBe('KIND_NOT_ALLOWED');
  });
});

describe('validateReference: reversões exigem referência PROCESSED de mesmo valor', () => {
  test.each([
    ['PENDING', (tx: WagerTransaction) => tx],
    [
      'REJECTED',
      (tx: WagerTransaction) => {
        tx.reject('EXAMPLE_RULE_CODE');
        return tx;
      },
    ],
    [
      'FAILED',
      (tx: WagerTransaction) => {
        tx.fail('EXAMPLE_INFRA_CODE');
        return tx;
      },
    ],
  ])('%s → REFERENCE_NOT_PROCESSED', (_status, toStatus) => {
    const bet = toStatus(wager(Bet, 'bet-1'));

    expect(violationOf(reversalOf(Refund, 'refund-1', bet), bet)).toBe('REFERENCE_NOT_PROCESSED');
    expect(violationOf(reversalOf(Rollback, 'rollback-1', bet), bet)).toBe(
      'REFERENCE_NOT_PROCESSED',
    );
  });

  test.each([
    ['menor', 2_499n],
    ['maior', 2_501n],
  ])('valor %s que a referência → AMOUNT_MISMATCH (regra 5)', (_case, cents) => {
    const bet = processed(Bet, 'bet-1');

    expect(violationOf(reversalOf(Refund, 'refund-1', bet, { money: brl(cents) }), bet)).toBe(
      'AMOUNT_MISMATCH',
    );
  });
});

describe('validateReference: tipos sem regra de referência no contrato', () => {
  test.each([Bet, Loss])('%s com referência é recusada como decisão pendente', (kind) => {
    const bet = processed(Bet, 'bet-1');
    const transaction = wager(kind, 'tx-1', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    expect(() => validateReference(transaction, bet)).toThrow(UnsupportedReferenceError);
  });
});
