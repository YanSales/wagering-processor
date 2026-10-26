import { describe, expect, test } from 'bun:test';
import { WalletPlayerMismatchError } from '../../src/domain/bet';
import { CurrencyMismatchError, Money } from '../../src/domain/money';
import { applyRefund, ReferenceAlreadyReversedError } from '../../src/domain/refund';
import {
  InvalidReferenceError,
  type ReferenceViolation,
} from '../../src/domain/transaction-reference';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { at, brl, processed, reversalOf, T0, wager } from '../support/wager-fixtures';

const { Bet, Win, Refund } = WagerTransactionKind;

function walletWith(cents: bigint, playerId = 'player-1'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId,
    initialBalance: brl(cents),
    openedAt: T0,
    opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' },
  }).wallet;
}

const state = (tx: WagerTransaction, wallet: Wallet) => ({
  status: tx.status,
  referenceTransactionId: tx.referenceTransactionId,
  failureCode: tx.failureCode,
  cents: wallet.balance.cents,
  version: wallet.version,
});

function refund(
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  wallet: Wallet,
  alreadyRefunded = false,
) {
  return applyRefund({
    transaction,
    reference,
    alreadyRefunded,
    wallet,
    ledgerEntryId: `entry-${transaction.id}`,
    at: at(10),
  });
}

/** Exige a falha `errorType` sem alterar a transação nem a wallet. */
function expectUnchanged(
  operation: () => unknown,
  errorType: abstract new (...args: never[]) => Error,
  transaction: WagerTransaction,
  wallet: Wallet,
) {
  const before = state(transaction, wallet);
  expect(operation).toThrow(errorType);
  expect(state(transaction, wallet)).toEqual(before);
}

/** REFUND em `PENDING_REFERENCE`, como o worker o reidrata do banco. */
function waiting(reference: WagerTransaction): WagerTransaction {
  const pending = reversalOf(Refund, 'refund-1', reference);
  return WagerTransaction.rehydrate({
    id: pending.id,
    providerId: pending.providerId,
    externalTransactionId: pending.externalTransactionId,
    idempotencyKey: pending.idempotencyKey,
    payloadHash: pending.payloadHash,
    walletId: pending.walletId,
    playerId: pending.playerId,
    roundId: pending.roundId,
    gameId: pending.gameId,
    kind: pending.kind,
    money: pending.money,
    referenceExternalTransactionId: pending.referenceExternalTransactionId,
    createdAt: pending.createdAt,
    status: WagerTransactionStatus.PendingReference,
  });
}

describe('applyRefund', () => {
  test('BET ausente: PENDING_REFERENCE, sem movimento (§7, regra 8)', () => {
    const wallet = walletWith(10_000n);
    const tx = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'));

    expect(refund(tx, undefined, wallet)).toEqual({ outcome: 'AWAITING_REFERENCE' });
    expect(state(tx, wallet)).toEqual({
      status: WagerTransactionStatus.PendingReference,
      referenceTransactionId: undefined,
      failureCode: undefined,
      cents: 10_000n,
      version: 1,
    });
  });

  test('BET PROCESSED compatível: crédito de igual valor e PROCESSED com o id interno da BET', () => {
    const wallet = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const tx = reversalOf(Refund, 'refund-1', bet);

    const result = refund(tx, bet, wallet);

    expect(result.outcome).toBe('PROCESSED');
    if (result.outcome !== 'PROCESSED') throw new Error('esperado PROCESSED');
    expect(result.ledgerEntry.direction).toBe(LedgerDirection.Credit);
    expect(result.ledgerEntry.money.equals(bet.money)).toBe(true);
    expect(state(tx, wallet)).toMatchObject({
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: 'bet-1',
      cents: 12_500n,
      version: 2,
    });
  });

  test('a partir de PENDING_REFERENCE (tentativa do worker): resolve da mesma forma', () => {
    const wallet = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const tx = waiting(bet);

    expect(refund(tx, bet, wallet).outcome).toBe('PROCESSED');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('bet-1');
  });

  test('ainda ausente a partir de PENDING_REFERENCE: continua aguardando', () => {
    const wallet = walletWith(10_000n);
    const tx = waiting(processed(Bet, 'bet-1'));

    expect(refund(tx, undefined, wallet)).toEqual({ outcome: 'AWAITING_REFERENCE' });
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('wallet de outro player: WalletPlayerMismatchError antes de olhar a referência', () => {
    const wallet = walletWith(10_000n, 'player-2');
    const tx = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'));

    expectUnchanged(() => refund(tx, undefined, wallet), WalletPlayerMismatchError, tx, wallet);
  });

  test('moeda diferente da wallet: CurrencyMismatchError, mesmo sem a referência (§6.2)', () => {
    const wallet = walletWith(10_000n);
    const tx = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'), {
      money: Money.fromCents(2_500n, 'USD'),
    });

    expectUnchanged(() => refund(tx, undefined, wallet), CurrencyMismatchError, tx, wallet);
  });

  test.each<[string, () => WagerTransaction, ReferenceViolation]>([
    ['outra rodada', () => processed(Bet, 'bet-1', { roundId: 'round-2' }), 'DIFFERENT_ROUND'],
    ['outro player', () => processed(Bet, 'bet-1', { playerId: 'player-2' }), 'DIFFERENT_PLAYER'],
    ['outra wallet', () => processed(Bet, 'bet-1', { walletId: 'wallet-2' }), 'DIFFERENT_WALLET'],
    ['referência WIN', () => processed(Win, 'win-1'), 'KIND_NOT_ALLOWED'],
    ['BET não aplicada', () => wager(Bet, 'bet-1'), 'REFERENCE_NOT_PROCESSED'],
  ])(
    'referência inválida (%s): InvalidReferenceError, nada alterado',
    (_case, makeReference, violation) => {
      const wallet = walletWith(10_000n);
      const reference = makeReference();
      const tx = reversalOf(Refund, 'refund-1', reference, {
        roundId: 'round-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
      });

      expectUnchanged(() => refund(tx, reference, wallet), InvalidReferenceError, tx, wallet);
      expect(() => refund(tx, reference, wallet)).toThrow(violation);
    },
  );

  test('valor diferente do da BET: InvalidReferenceError AMOUNT_MISMATCH (§7, regra 5)', () => {
    const wallet = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const tx = reversalOf(Refund, 'refund-1', bet, { money: brl(2_499n) });

    expectUnchanged(() => refund(tx, bet, wallet), InvalidReferenceError, tx, wallet);
  });

  test('BET já reembolsada: ReferenceAlreadyReversedError (§7, regra 4), nada alterado', () => {
    const wallet = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const tx = reversalOf(Refund, 'refund-1', bet);

    expectUnchanged(() => refund(tx, bet, wallet, true), ReferenceAlreadyReversedError, tx, wallet);
  });

  test('a validação da referência vem antes da regra 4: referência inválida já reembolsada', () => {
    const wallet = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1', { roundId: 'round-2' });
    const tx = reversalOf(Refund, 'refund-1', bet, { roundId: 'round-1' });

    expect(() => refund(tx, bet, wallet, true)).toThrow(InvalidReferenceError);
  });

  test('erros de programação: outro tipo e estado terminal', () => {
    const wallet = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    expect(() => refund(wager(Bet, 'bet-2'), undefined, wallet)).toThrow(
      InvalidWagerTransactionError,
    );
    const done = reversalOf(Refund, 'refund-1', bet);
    refund(done, bet, wallet);
    expect(() => refund(done, bet, wallet)).toThrow(InvalidTransactionStateError);
  });
});
