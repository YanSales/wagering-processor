import { describe, expect, test } from 'bun:test';
import { FailureCodes } from '../../src/application/failure-codes';
import {
  DEFAULT_REFERENCE_RETRY,
  ReferenceRetryPolicy,
} from '../../src/application/reference-retry-policy';
import { decideRollback } from '../../src/application/refund-decision';
import type { ResolvedReference } from '../../src/application/wager-transaction-repository';
import { applyRollback } from '../../src/domain/rollback';
import {
  InvalidWagerTransactionError,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { at, brl, processed, reversalOf, T0, wager } from '../support/wager-fixtures';

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const policy = ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);

function walletWith(cents: bigint): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(cents),
    openedAt: T0,
    opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' },
  }).wallet;
}

function decide(
  transaction: WagerTransaction,
  reference: ResolvedReference | null,
  wallet = walletWith(10_000n),
  attempts = 0,
) {
  return decideRollback({
    transaction,
    wallet,
    reference,
    attempts,
    ledgerEntryId: 'entry-1',
    at: at(10),
    policy,
  });
}

const found = (transaction: WagerTransaction, alreadyReversed = false): ResolvedReference => ({
  transaction,
  alreadyReversed,
});

describe('decideRollback (contrato §7: inverso da referência)', () => {
  test('ROLLBACK de BET: crédito, PROCESSED com o id interno da BET', () => {
    const bet = processed(Bet, 'bet-1');
    const decision = decide(reversalOf(Rollback, 'rb-1', bet), found(bet));

    expect(decision.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(decision.transaction.referenceTransactionId).toBe('bet-1');
    expect(decision.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(decision.wallet.balance.cents).toBe(12_500n);
    expect(decision.nextReferenceAttemptAt).toBeUndefined();
  });

  test.each([
    ['WIN', Win],
    ['REFUND', Refund],
  ])('ROLLBACK de %s: débito', (_name, kind) => {
    // Um REFUND processado carrega a própria referência (a BET que ele reembolsou).
    const reference = processed(
      kind,
      'ref-1',
      kind === Refund ? { referenceExternalTransactionId: 'ext-bet-0' } : {},
      kind === Refund ? 'bet-0' : undefined,
    );
    const decision = decide(reversalOf(Rollback, 'rb-1', reference), found(reference));

    expect(decision.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(decision.wallet.balance.cents).toBe(7_500n);
  });

  test('débito que deixaria saldo negativo: REJECTED REVERSAL_WOULD_OVERDRAW, sem efeito (regra 9)', () => {
    const win = processed(Win, 'win-1');
    const wallet = walletWith(1_000n);
    const decision = decide(reversalOf(Rollback, 'rb-1', win), found(win), wallet);

    expect(decision.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(decision.transaction.failureCode).toBe(FailureCodes.ReversalWouldOverdraw);
    expect(decision.transaction.failureCode).not.toBe(FailureCodes.InsufficientFunds);
    expect(decision.ledgerEntry).toBeNull();
    expect(wallet.balance.cents).toBe(1_000n);
    expect(wallet.version).toBe(1);
  });

  test.each([
    [
      'já revertida por ROLLBACK (regra 4)',
      (bet: WagerTransaction) => found(bet, true),
      FailureCodes.ReferenceAlreadyReversed,
    ],
    [
      'BET não processada',
      () => {
        const rejected = wager(Bet, 'bet-1');
        rejected.reject(FailureCodes.InsufficientFunds);
        return found(rejected);
      },
      FailureCodes.ReferenceNotProcessed,
    ],
    [
      'outra rodada (regra 2)',
      () => found(processed(Bet, 'bet-1', { roundId: 'round-2' })),
      FailureCodes.ReferenceMismatch,
    ],
    [
      'LOSS não pode ser revertida (regra 3)',
      () => found(processed(Loss, 'bet-1')),
      FailureCodes.ReferenceKindNotAllowed,
    ],
  ])('referência inválida, %s: REJECTED sem lançamento', (_case, reference, code) => {
    const bet = processed(Bet, 'bet-1');
    const decision = decide(reversalOf(Rollback, 'rb-1', bet), reference(bet));

    expect(decision.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(decision.transaction.failureCode).toBe(code);
    expect(decision.ledgerEntry).toBeNull();
    expect(decision.wallet.balance.cents).toBe(10_000n);
  });

  test('valor diferente da referência: REFERENCE_AMOUNT_MISMATCH (regra 5)', () => {
    const bet = processed(Bet, 'bet-1');
    const rollback = reversalOf(Rollback, 'rb-1', bet, { money: brl(100n) });

    expect(decide(rollback, found(bet)).transaction.failureCode).toBe(
      FailureCodes.ReferenceAmountMismatch,
    );
  });

  test('referência ausente: PENDING_REFERENCE agendado; esgotado, REFERENCE_NOT_FOUND', () => {
    const bet = processed(Bet, 'bet-1');
    const pending = decide(reversalOf(Rollback, 'rb-1', bet), null);
    expect(pending.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.nextReferenceAttemptAt).toBeInstanceOf(Date);

    const exhausted = decide(
      reversalOf(Rollback, 'rb-2', bet),
      null,
      walletWith(10_000n),
      DEFAULT_REFERENCE_RETRY.maxAttempts,
    );
    expect(exhausted.transaction.failureCode).toBe(FailureCodes.ReferenceNotFound);
  });

  test('applyRollback recusa outro tipo de transação', () => {
    expect(() =>
      applyRollback({
        transaction: wager(Bet, 'bet-1'),
        reference: undefined,
        alreadyRolledBack: false,
        wallet: walletWith(10_000n),
        ledgerEntryId: 'e',
        at: at(1),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});
