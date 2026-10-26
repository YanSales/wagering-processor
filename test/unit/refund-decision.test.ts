import { describe, expect, test } from 'bun:test';
import { FailureCodes, refundFailureCodeFor } from '../../src/application/failure-codes';
import {
  DEFAULT_REFERENCE_RETRY,
  ReferenceRetryPolicy,
} from '../../src/application/reference-retry-policy';
import { decideRefund } from '../../src/application/refund-decision';
import type { ResolvedReference } from '../../src/application/wager-transaction-repository';
import { Money } from '../../src/domain/money';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { at, brl, processed, reversalOf, T0, wager } from '../support/wager-fixtures';

const { Bet, Win, Refund } = WagerTransactionKind;
const policy = ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);

function walletWith(cents: bigint, playerId = 'player-1'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId,
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
  return decideRefund({
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

describe('decideRefund', () => {
  test('referência válida: PROCESSED com lançamento, sem agendamento', () => {
    const bet = processed(Bet, 'bet-1');
    const decision = decide(reversalOf(Refund, 'refund-1', bet), found(bet));

    expect(decision.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(decision.ledgerEntry).not.toBeNull();
    expect(decision.wallet.balance.cents).toBe(12_500n);
    expect(decision.nextReferenceAttemptAt).toBeUndefined();
  });

  test('referência ausente na submissão: PENDING_REFERENCE agendado para 2 s depois', () => {
    const decision = decide(reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1')), null);

    expect(decision.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(decision.ledgerEntry).toBeNull();
    expect(decision.nextReferenceAttemptAt?.getTime()).toBe(at(12).getTime());
  });

  test('referência ausente na 9ª tentativa: reagenda; na 10ª: REJECTED REFERENCE_NOT_FOUND', () => {
    const bet = processed(Bet, 'bet-1');
    const ninth = decide(reversalOf(Refund, 'refund-1', bet), null, walletWith(10_000n), 9);
    expect(ninth.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(ninth.nextReferenceAttemptAt?.getTime()).toBe(at(10 + 300).getTime());

    const tenth = decide(reversalOf(Refund, 'refund-2', bet), null, walletWith(10_000n), 10);
    expect(tenth.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(tenth.transaction.failureCode).toBe(FailureCodes.ReferenceNotFound);
    expect(tenth.ledgerEntry).toBeNull();
    expect(tenth.nextReferenceAttemptAt).toBeUndefined();
  });

  test.each<[string, () => [WagerTransaction, ResolvedReference | null, Wallet?], string]>([
    [
      'outra rodada',
      () => {
        const bet = processed(Bet, 'bet-1', { roundId: 'round-2' });
        return [reversalOf(Refund, 'r', bet, { roundId: 'round-1' }), found(bet)];
      },
      FailureCodes.ReferenceMismatch,
    ],
    [
      'referência WIN',
      () => {
        const win = processed(Win, 'win-1');
        return [reversalOf(Refund, 'r', win), found(win)];
      },
      FailureCodes.ReferenceKindNotAllowed,
    ],
    [
      'BET não aplicada',
      () => {
        const bet = wager(Bet, 'bet-1');
        return [reversalOf(Refund, 'r', bet), found(bet)];
      },
      FailureCodes.ReferenceNotProcessed,
    ],
    [
      'valor diferente',
      () => {
        const bet = processed(Bet, 'bet-1');
        return [reversalOf(Refund, 'r', bet, { money: brl(1n) }), found(bet)];
      },
      FailureCodes.ReferenceAmountMismatch,
    ],
    [
      'BET já reembolsada',
      () => {
        const bet = processed(Bet, 'bet-1');
        return [reversalOf(Refund, 'r', bet), found(bet, true)];
      },
      FailureCodes.ReferenceAlreadyReversed,
    ],
    [
      'moeda diferente da wallet',
      () => [
        reversalOf(Refund, 'r', processed(Bet, 'bet-1'), {
          money: Money.fromCents(2_500n, 'USD'),
        }),
        null,
      ],
      FailureCodes.CurrencyMismatch,
    ],
    [
      'wallet de outro player',
      () => [reversalOf(Refund, 'r', processed(Bet, 'bet-1')), null, walletWith(1n, 'player-9')],
      FailureCodes.PlayerWalletMismatch,
    ],
  ])('%s: REJECTED de imediato, sem lançamento nem agendamento', (_case, make, code) => {
    const [transaction, reference, wallet] = make();
    const decision = decide(transaction, reference, wallet ?? walletWith(10_000n));

    expect(decision.transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(decision.transaction.failureCode).toBe(code);
    expect(decision.ledgerEntry).toBeNull();
    expect(decision.nextReferenceAttemptAt).toBeUndefined();
    expect(decision.wallet.version).toBe(1);
  });

  test('erro que não é de negócio sobe (a transação SQL é desfeita)', () => {
    expect(() => decide(wager(Bet, 'bet-1'), null)).toThrow('applyRefund aceita apenas REFUND');
  });
});

describe('refundFailureCodeFor', () => {
  test('erro desconhecido: undefined', () => {
    expect(refundFailureCodeFor(new Error('bug'))).toBeUndefined();
  });
});
