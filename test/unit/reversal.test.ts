import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { applyReversal, ReversalWouldOverdrawError } from '../../src/domain/reversal';
import { InvalidReferenceError } from '../../src/domain/transaction-reference';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  type WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction';
import { InsufficientFundsError, Wallet } from '../../src/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { at, brl, processed, reversalOf, T0, wager } from '../support/wager-fixtures';

const { Bet, Win, Refund, Rollback } = WagerTransactionKind;

function walletWith(cents: bigint): { wallet: Wallet; ledger: WalletLedgerEntry[] } {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(cents),
    openedAt: T0,
    ...(cents > 0n ? { opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' } } : {}),
  });
  return { wallet, ledger: openingEntry ? [openingEntry] : [] };
}

const walletState = (wallet: Wallet) => ({
  cents: wallet.balance.cents,
  version: wallet.version,
  updatedAt: wallet.updatedAt.getTime(),
});
const txState = (tx: WagerTransaction) => ({
  status: tx.status,
  referenceTransactionId: tx.referenceTransactionId,
  failureCode: tx.failureCode,
  processedAt: tx.processedAt?.getTime(),
});

function reverse(
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  wallet: Wallet,
) {
  return applyReversal({
    transaction,
    reference,
    wallet,
    ledgerEntryId: `entry-${transaction.id}`,
    at: at(10),
  });
}

/** Exige que a operação falhe com `errorType` sem alterar a transação nem a wallet. */
function expectUnchanged(
  operation: () => unknown,
  errorType: abstract new (...args: never[]) => Error,
  transaction: WagerTransaction,
  wallet: Wallet,
) {
  const before = { tx: txState(transaction), wallet: walletState(wallet) };
  expect(operation).toThrow(errorType);
  expect({ tx: txState(transaction), wallet: walletState(wallet) }).toEqual(before);
}

describe('applyReversal: reversão com referência válida', () => {
  test('REFUND de uma BET credita o valor e marca PROCESSED com o id interno da referência', () => {
    const { wallet } = walletWith(7_500n);
    const bet = processed(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', bet);

    const result = reverse(refund, bet, wallet);

    expect(result.outcome).toBe('PROCESSED');
    const entry = result.outcome === 'PROCESSED' ? result.ledgerEntry : undefined;
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.transactionId).toBe('refund-1');
    expect(entry?.balanceBefore.equals(brl(7_500n))).toBe(true);
    expect(wallet.balance.equals(brl(10_000n))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(refund.status).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe('bet-1');
    expect(refund.processedAt?.getTime()).toBe(at(10).getTime());
  });

  test.each([
    ['BET', () => processed(Bet, 'bet-1'), LedgerDirection.Credit, 12_500n],
    ['WIN', () => processed(Win, 'win-1'), LedgerDirection.Debit, 7_500n],
    [
      'REFUND',
      () => processed(Refund, 'refund-1', { referenceExternalTransactionId: 'ext-bet-0' }, 'bet-0'),
      LedgerDirection.Debit,
      7_500n,
    ],
  ])('ROLLBACK de %s inverte a direção', (_kind, makeReference, direction, expectedCents) => {
    const { wallet } = walletWith(10_000n);
    const reference = makeReference();
    const rollback = reversalOf(Rollback, 'rollback-1', reference);

    const result = reverse(rollback, reference, wallet);

    expect(result.outcome === 'PROCESSED' ? result.ledgerEntry.direction : undefined).toBe(
      direction,
    );
    expect(wallet.balance.cents).toBe(expectedCents);
    expect(rollback.referenceTransactionId).toBe(reference.id);
  });

  test('não altera os lançamentos já existentes no ledger', () => {
    const { wallet, ledger } = walletWith(10_000n);
    const opening = ledger[0] as WalletLedgerEntry;
    const view = (e: WalletLedgerEntry) => ({
      before: e.balanceBefore.cents,
      after: e.balanceAfter.cents,
      money: e.money.cents,
      frozen: Object.isFrozen(e),
    });
    const before = view(opening);
    const bet = processed(Bet, 'bet-1');

    reverse(reversalOf(Refund, 'refund-1', bet), bet, wallet);

    expect(view(opening)).toEqual(before);
  });
});

describe('applyReversal: referência ausente (contrato §7, regra 8)', () => {
  test('vai para PENDING_REFERENCE sem mexer na wallet', () => {
    const { wallet } = walletWith(10_000n);
    const before = walletState(wallet);
    const refund = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'));

    expect(reverse(refund, undefined, wallet)).toEqual({ outcome: 'AWAITING_REFERENCE' });
    expect(refund.status).toBe('PENDING_REFERENCE');
    expect(walletState(wallet)).toEqual(before);
  });

  test('continua aguardando enquanto a referência não aparece e processa quando ela chega', () => {
    const { wallet } = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', bet);

    reverse(refund, undefined, wallet);
    reverse(refund, undefined, wallet);
    expect(refund.status).toBe('PENDING_REFERENCE');

    expect(reverse(refund, bet, wallet).outcome).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe('bet-1');
    expect(wallet.balance.equals(brl(12_500n))).toBe(true);
  });

  test('referência inválida a partir de PENDING_REFERENCE é recusada e a transação segue aguardando', () => {
    const { wallet } = walletWith(10_000n);
    const refund = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'));
    reverse(refund, undefined, wallet);
    const wrongRound = processed(Bet, 'bet-1', { roundId: 'round-2' });

    expectUnchanged(
      () => reverse(refund, wrongRound, wallet),
      InvalidReferenceError,
      refund,
      wallet,
    );
    expect(refund.status).toBe('PENDING_REFERENCE');
  });
});

describe('applyReversal: proteção contra saldo negativo (contrato §7, regra 9)', () => {
  test('ROLLBACK de WIN acima do saldo lança erro distinto de saldo insuficiente, sem alterações', () => {
    const { wallet } = walletWith(1_000n);
    const win = processed(Win, 'win-1');
    const rollback = reversalOf(Rollback, 'rollback-1', win);
    const before = { tx: txState(rollback), wallet: walletState(wallet) };
    let caught: unknown;

    try {
      reverse(rollback, win, wallet);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ReversalWouldOverdrawError);
    expect(caught).not.toBeInstanceOf(InsufficientFundsError);
    const overdraw = caught as ReversalWouldOverdrawError;
    expect(overdraw.transactionId).toBe('rollback-1');
    expect(overdraw.insufficientFunds.requested.equals(brl(2_500n))).toBe(true);
    expect({ tx: txState(rollback), wallet: walletState(wallet) }).toEqual(before);
  });

  test('ROLLBACK que zera exatamente o saldo é permitido', () => {
    const { wallet } = walletWith(2_500n);
    const win = processed(Win, 'win-1');

    reverse(reversalOf(Rollback, 'rollback-1', win), win, wallet);

    expect(wallet.balance.isZero()).toBe(true);
  });
});

describe('applyReversal: falhas não alteram transação nem wallet', () => {
  test('referência de valor diferente', () => {
    const { wallet } = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', bet, { money: brl(2_400n) });

    expectUnchanged(() => reverse(refund, bet, wallet), InvalidReferenceError, refund, wallet);
  });

  test('referência ainda não processada', () => {
    const { wallet } = walletWith(10_000n);
    const pendingBet = wager(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', pendingBet);

    expectUnchanged(
      () => reverse(refund, pendingBet, wallet),
      InvalidReferenceError,
      refund,
      wallet,
    );
  });

  test('transação que não é reversão', () => {
    const { wallet } = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const win = wager(Win, 'win-1', { referenceExternalTransactionId: bet.externalTransactionId });

    expectUnchanged(() => reverse(win, bet, wallet), InvalidWagerTransactionError, win, wallet);
  });

  test('transação em estado terminal', () => {
    const { wallet } = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', bet);
    refund.reject('EXAMPLE_RULE_CODE');

    expectUnchanged(
      () => reverse(refund, bet, wallet),
      InvalidTransactionStateError,
      refund,
      wallet,
    );
    expectUnchanged(
      () => reverse(refund, undefined, wallet),
      InvalidTransactionStateError,
      refund,
      wallet,
    );
  });

  test('reversão já PROCESSED não pode ser aplicada de novo', () => {
    const { wallet, ledger } = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', bet);
    const first = reverse(refund, bet, wallet);
    if (first.outcome !== 'PROCESSED') throw new Error('a primeira aplicação deveria processar');
    ledger.push(first.ledgerEntry);
    const entryView = (entry: WalletLedgerEntry) => ({
      id: entry.id,
      direction: entry.direction,
      money: entry.money.cents,
      before: entry.balanceBefore.cents,
      after: entry.balanceAfter.cents,
      frozen: Object.isFrozen(entry),
    });
    const ledgerBefore = ledger.map(entryView);
    expect(refund.status).toBe('PROCESSED');
    expect(wallet.balance.equals(brl(12_500n))).toBe(true);

    // Mesma instância, mesma referência e um novo id de lançamento: seria um segundo crédito.
    expectUnchanged(
      () =>
        applyReversal({
          transaction: refund,
          reference: bet,
          wallet,
          ledgerEntryId: 'entry-again',
          at: at(20),
        }),
      InvalidTransactionStateError,
      refund,
      wallet,
    );
    expectUnchanged(
      () => reverse(refund, undefined, wallet),
      InvalidTransactionStateError,
      refund,
      wallet,
    );

    expect(wallet.balance.equals(brl(12_500n))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(refund.referenceTransactionId).toBe('bet-1');
    expect(ledger.map(entryView)).toEqual(ledgerBefore);
  });

  test('wallet diferente da transação', () => {
    const { wallet } = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1', { walletId: 'wallet-2' });
    const refund = reversalOf(Refund, 'refund-1', bet, { walletId: 'wallet-2' });

    expectUnchanged(
      () => reverse(refund, bet, wallet),
      InvalidWagerTransactionError,
      refund,
      wallet,
    );
  });

  test('data inválida do lançamento', () => {
    const { wallet } = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', bet);
    const before = { tx: txState(refund), wallet: walletState(wallet) };

    expect(() =>
      applyReversal({
        transaction: refund,
        reference: bet,
        wallet,
        ledgerEntryId: 'e',
        at: new Date('x'),
      }),
    ).toThrow();
    expect({ tx: txState(refund), wallet: walletState(wallet) }).toEqual(before);
  });

  test('moeda da reversão diferente da wallet', () => {
    const { wallet } = walletWith(10_000n);
    const bet = processed(Bet, 'bet-1', { money: Money.fromCents(2_500n, 'USD') });
    const refund = reversalOf(Refund, 'refund-1', bet);
    const before = { tx: txState(refund), wallet: walletState(wallet) };

    expect(() => reverse(refund, bet, wallet)).toThrow();
    expect({ tx: txState(refund), wallet: walletState(wallet) }).toEqual(before);
  });
});
