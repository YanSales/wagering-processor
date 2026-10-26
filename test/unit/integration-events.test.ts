import { describe, expect, test } from 'bun:test';
import { InvalidIntegrationEventError } from '../../src/application/events/integration-event';
import {
  eventsForTransition,
  eventsForWalletOpening,
  type TransactionEventEnvelope,
} from '../../src/application/events/transaction-events';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  type WagerTransactionProcessedData,
  WagerTransactionRejected,
  type WagerTransactionRejectedData,
} from '../../src/application/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../src/application/events/wallet-balance-changed';
import { FailureCodes } from '../../src/application/failure-codes';
import { applyBet, WalletPlayerMismatchError } from '../../src/domain/bet';
import { applyLoss } from '../../src/domain/loss';
import { Money } from '../../src/domain/money';
import { applyRefund } from '../../src/domain/refund';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { applyWin } from '../../src/domain/win';
import { at, brl, processed, reversalOf, T0, wager } from '../support/wager-fixtures';

const { Bet, Win, Loss, Refund } = WagerTransactionKind;
const { Pending, PendingReference, Processed } = WagerTransactionStatus;
const CORRELATION = 'corr-1';
const ctx = (eventId = 'evt-1') => ({ eventId, correlationId: CORRELATION });

function openWallet(cents = 10_000n, playerId = 'player-1'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId,
    initialBalance: brl(cents),
    openedAt: T0,
    opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' },
  }).wallet;
}

/** Ids previsíveis, na ordem em que os eventos os pedem. */
function ids() {
  let n = 0;
  return () => `evt-${++n}`;
}

/** Transação reidratada em `PENDING_REFERENCE`, como o worker a lê do banco. */
function waiting(transaction: WagerTransaction): WagerTransaction {
  return rehydrated(transaction, PendingReference);
}

/** Transação reidratada no estado informado, sem passar pelas transições (§6.0). */
function rehydrated(
  transaction: WagerTransaction,
  status: WagerTransactionStatus,
  processedAt?: Date,
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    createdAt: transaction.createdAt,
    status,
    ...(processedAt === undefined ? {} : { processedAt }),
  });
}

/** Lançamento criado (e validado) diretamente pelo domínio, fora de uma movimentação de wallet. */
function entry(
  transactionId: string,
  direction: LedgerDirection,
  cents: bigint,
  beforeCents: bigint,
  id = 'entry-9',
): WalletLedgerEntry {
  const money = brl(cents);
  const balanceBefore = brl(beforeCents);
  return WalletLedgerEntry.create({
    id,
    walletId: 'wallet-1',
    transactionId,
    direction,
    money,
    balanceBefore,
    balanceAfter:
      direction === LedgerDirection.Credit
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money),
    createdAt: at(5),
  });
}

function placedBet(cents = 2_500n) {
  const wallet = openWallet();
  const transaction = wager(Bet, 'bet-1', { money: brl(cents) });
  const ledgerEntry = applyBet({ transaction, wallet, ledgerEntryId: 'entry-1', at: at(5) });
  return { wallet, transaction, ledgerEntry };
}

describe('envelope (contrato §11)', () => {
  test('toJSON: campos do README, occurredAt em ISO-8601, version 1, sem causationId omitido', () => {
    const { transaction } = placedBet();

    const json = WagerTransactionProcessed.from(transaction, ctx()).toJSON();

    expect(Object.keys(json).sort()).toEqual(
      [
        'aggregateId',
        'correlationId',
        'data',
        'eventId',
        'eventType',
        'occurredAt',
        'version',
      ].sort(),
    );
    expect(json).toMatchObject({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'bet-1',
      correlationId: CORRELATION,
      occurredAt: at(5).toISOString(),
      version: 1,
    });
  });

  test('causationId, quando informado, entra no envelope', () => {
    const { transaction } = placedBet();

    const json = WagerTransactionProcessed.from(transaction, {
      ...ctx(),
      causationId: 'evt-0',
    }).toJSON();

    expect(json.causationId).toBe('evt-0');
  });

  test('JSON estável: serializável, sem instâncias de Money, e igual ao toJSON depois do parse', () => {
    const { wallet, ledgerEntry } = placedBet();
    const event = WalletBalanceChanged.from(wallet, ledgerEntry, ctx());

    const text = JSON.stringify(event);

    expect(JSON.parse(text)).toEqual(event.toJSON());
    expect(event.toJSON().data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(event.data.money).not.toBeInstanceOf(Money);
  });

  test('imutável: data congelado, datas copiadas, toJSON devolve cópias', () => {
    const { transaction } = placedBet();
    const event = WagerTransactionProcessed.from(transaction, ctx());

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    event.occurredAt.setTime(0);
    expect(event.occurredAt.getTime()).toBe(at(5).getTime());
    const json = event.toJSON();
    // Mutação deliberada da cópia devolvida (os tipos são readonly; o teste força a escrita).
    (json.data.money as { amount: string }).amount = '0.00';
    expect(event.data.money.amount).toBe('25.00');
  });

  test.each([
    ['eventId vazio', { eventId: ' ', correlationId: CORRELATION }],
    ['correlationId vazio', { eventId: 'evt-1', correlationId: '' }],
    ['causationId vazio', { eventId: 'evt-1', correlationId: CORRELATION, causationId: '' }],
  ])('%s: InvalidIntegrationEventError', (_case, context) => {
    const { transaction } = placedBet();

    expect(() => WagerTransactionProcessed.from(transaction, context)).toThrow(
      InvalidIntegrationEventError,
    );
  });

  test('instante inválido: InvalidIntegrationEventError', () => {
    const transaction = wager(Bet, 'bet-1');
    transaction.reject(FailureCodes.InsufficientFunds);

    expect(() => WagerTransactionRejected.from(transaction, ctx(), new Date(Number.NaN))).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('WagerTransactionProcessed', () => {
  test('BET: data exato, sem saldo, gameId, idempotencyKey nem payloadHash', () => {
    const { transaction } = placedBet();

    expect(WagerTransactionProcessed.from(transaction, ctx()).toJSON().data).toEqual({
      transactionId: 'bet-1',
      kind: 'BET',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-bet-1',
      roundId: 'round-1',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
    });
  });

  test('REFUND aplicado: referência externa e id interno da BET resolvida', () => {
    const wallet = openWallet();
    const bet = processed(Bet, 'bet-1');
    const refund = reversalOf(Refund, 'refund-1', bet);
    applyRefund({
      transaction: refund,
      reference: bet,
      alreadyRefunded: false,
      wallet,
      ledgerEntryId: 'entry-1',
      at: at(5),
    });

    expect(WagerTransactionProcessed.from(refund, ctx()).toJSON().data).toEqual({
      transactionId: 'refund-1',
      kind: 'REFUND',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-refund-1',
      roundId: 'round-1',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-bet-1',
      referenceTransactionId: 'bet-1',
    });
  });

  test('WIN aplicado: data exato', () => {
    const transaction = wager(Win, 'win-1');
    applyWin({ transaction, wallet: openWallet(), ledgerEntryId: 'entry-1', at: at(5) });

    expect(WagerTransactionProcessed.from(transaction, ctx()).toJSON().data).toEqual({
      transactionId: 'win-1',
      kind: 'WIN',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-win-1',
      roundId: 'round-1',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
    });
  });

  test('LOSS aplicado: data exato, com o valor informado mesmo sem mover saldo', () => {
    const transaction = wager(Loss, 'loss-1');
    applyLoss({ transaction, wallet: openWallet(), at: at(5) });

    expect(WagerTransactionProcessed.from(transaction, ctx()).toJSON().data).toEqual({
      transactionId: 'loss-1',
      kind: 'LOSS',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-loss-1',
      roundId: 'round-1',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
    });
  });

  test('OPENING: campos externos nulos (só nela), occurredAt da abertura', () => {
    const opening = WagerTransaction.opening({
      id: 'opening-tx',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl(10_000n),
      at: T0,
    });

    const json = WagerTransactionProcessed.from(opening, ctx()).toJSON();

    expect(json.data).toEqual({
      transactionId: 'opening-tx',
      kind: 'OPENING',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: null,
      externalTransactionId: null,
      roundId: null,
      money: { amount: '100.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
    });
    expect(json.occurredAt).toBe(T0.toISOString());
  });

  test.each([
    ['pendente', () => wager(Bet, 'bet-1')],
    [
      'rejeitada',
      () => {
        const tx = wager(Bet, 'bet-1');
        tx.reject(FailureCodes.InsufficientFunds);
        return tx;
      },
    ],
  ])('transação %s: InvalidIntegrationEventError', (_case, make) => {
    expect(() => WagerTransactionProcessed.from(make(), ctx())).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('WagerTransactionRejected', () => {
  test('failureCode do domínio, nunca mensagem; sem referenceTransactionId', () => {
    const wallet = openWallet(1_000n);
    const transaction = wager(Bet, 'bet-1', { money: brl(5_000n) });
    expect(() => applyBet({ transaction, wallet, ledgerEntryId: 'entry-1', at: at(5) })).toThrow();
    transaction.reject(FailureCodes.InsufficientFunds);

    const json = WagerTransactionRejected.from(transaction, ctx(), at(5)).toJSON();

    expect(json.data).toEqual({
      transactionId: 'bet-1',
      kind: 'BET',
      walletId: 'wallet-1',
      playerId: 'player-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-bet-1',
      roundId: 'round-1',
      money: { amount: '50.00', currency: 'BRL' },
      failureCode: 'INSUFFICIENT_FUNDS',
      referenceExternalTransactionId: null,
    });
    expect(json.data).not.toHaveProperty('referenceTransactionId');
    expect(json.occurredAt).toBe(at(5).toISOString());
  });

  test('REFUND rejeitado por esgotamento: referência externa preservada', () => {
    const refund = waiting(reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1')));
    refund.reject(FailureCodes.ReferenceNotFound);

    expect(WagerTransactionRejected.from(refund, ctx(), at(9)).data).toMatchObject({
      kind: 'REFUND',
      failureCode: 'REFERENCE_NOT_FOUND',
      referenceExternalTransactionId: 'ext-bet-1',
    });
  });

  test('transação não rejeitada: InvalidIntegrationEventError', () => {
    expect(() => WagerTransactionRejected.from(wager(Bet, 'bet-1'), ctx(), at(1))).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('WagerTransactionPendingReference', () => {
  test('REFUND aguardando: a referência aguardada, sem saldo', () => {
    const refund = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'));
    refund.markPendingReference();

    expect(WagerTransactionPendingReference.from(refund, ctx(), at(3)).toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionPendingReference',
      aggregateId: 'refund-1',
      correlationId: CORRELATION,
      occurredAt: at(3).toISOString(),
      version: 1,
      data: {
        transactionId: 'refund-1',
        kind: 'REFUND',
        walletId: 'wallet-1',
        playerId: 'player-1',
        providerId: 'provider-a',
        externalTransactionId: 'ext-refund-1',
        roundId: 'round-1',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ext-bet-1',
      },
    });
  });

  test('transação fora de PENDING_REFERENCE: InvalidIntegrationEventError', () => {
    const refund = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'));

    expect(() => WagerTransactionPendingReference.from(refund, ctx(), at(3))).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('WalletBalanceChanged (data do README)', () => {
  test('débito de BET: exatamente os campos do contrato', () => {
    const { wallet, ledgerEntry } = placedBet();

    expect(WalletBalanceChanged.from(wallet, ledgerEntry, ctx()).toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: CORRELATION,
      occurredAt: at(5).toISOString(),
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'bet-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('wallet que não está no estado posterior ao lançamento: InvalidIntegrationEventError', () => {
    const { ledgerEntry } = placedBet();

    expect(() => WalletBalanceChanged.from(openWallet(), ledgerEntry, ctx())).toThrow(
      InvalidIntegrationEventError,
    );
  });

  test('lançamento de outra wallet: InvalidIntegrationEventError', () => {
    const { ledgerEntry } = placedBet();
    const other = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      initialBalance: brl(7_500n),
      openedAt: T0,
      opening: { transactionId: 'opening-2', ledgerEntryId: 'entry-9' },
    }).wallet;

    expect(() => WalletBalanceChanged.from(other, ledgerEntry, ctx())).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('eventsForTransition', () => {
  const transition = (
    transaction: WagerTransaction,
    previousStatus: WagerTransactionStatus,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | null,
  ) =>
    eventsForTransition({
      transaction,
      previousStatus,
      wallet,
      ledgerEntry,
      correlationId: CORRELATION,
      at: at(5),
      newId: ids(),
    });
  const types = (events: { eventType: string }[]) => events.map((e) => e.eventType);

  test('BET aplicada: Processed antes de WalletBalanceChanged, ids em ordem, mesma correlação', () => {
    const { wallet, transaction, ledgerEntry } = placedBet();

    const events = transition(transaction, Pending, wallet, ledgerEntry);

    expect(types(events)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events.map((e) => e.eventId)).toEqual(['evt-1', 'evt-2']);
    expect(events.map((e) => e.aggregateId)).toEqual(['bet-1', 'wallet-1']);
    expect(events.every((e) => e.correlationId === CORRELATION)).toBe(true);
  });

  test('WIN aplicada: Processed e crédito', () => {
    const wallet = openWallet();
    const transaction = wager(Win, 'win-1');
    const ledgerEntry = applyWin({ transaction, wallet, ledgerEntryId: 'entry-1', at: at(5) });

    const events = transition(transaction, Pending, wallet, ledgerEntry);

    expect(types(events)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect((events[1] as WalletBalanceChanged).data.direction).toBe('CREDIT');
  });

  test('LOSS: só Processed, sem WalletBalanceChanged', () => {
    const wallet = openWallet();
    const transaction = wager(Loss, 'loss-1');
    applyLoss({ transaction, wallet, at: at(5) });

    expect(types(transition(transaction, Pending, wallet, null))).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  test('rejeição: só Rejected, nunca Processed nem WalletBalanceChanged', () => {
    const wallet = openWallet(1_000n);
    const transaction = wager(Bet, 'bet-1', { money: brl(5_000n) });
    transaction.reject(FailureCodes.InsufficientFunds);

    expect(types(transition(transaction, Pending, wallet, null))).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  test('entrada em PENDING_REFERENCE (submissão): só PendingReference', () => {
    const wallet = openWallet();
    const refund = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'));
    applyRefund({
      transaction: refund,
      reference: undefined,
      alreadyRefunded: false,
      wallet,
      ledgerEntryId: 'entry-1',
      at: at(5),
    });

    expect(types(transition(refund, Pending, wallet, null))).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  test('reagendamento (PENDING_REFERENCE → PENDING_REFERENCE): nenhum evento', () => {
    const wallet = openWallet();
    const refund = waiting(reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1')));
    applyRefund({
      transaction: refund,
      reference: undefined,
      alreadyRefunded: false,
      wallet,
      ledgerEntryId: 'entry-1',
      at: at(5),
    });
    expect(refund.status).toBe(PendingReference);

    expect(transition(refund, PendingReference, wallet, null)).toEqual([]);
  });

  test('resolução tardia (PENDING_REFERENCE → PROCESSED): Processed com o id interno da BET e crédito', () => {
    const wallet = openWallet();
    const bet = processed(Bet, 'bet-1');
    const refund = waiting(reversalOf(Refund, 'refund-1', bet));
    const outcome = applyRefund({
      transaction: refund,
      reference: bet,
      alreadyRefunded: false,
      wallet,
      ledgerEntryId: 'entry-1',
      at: at(5),
    });
    if (outcome.outcome !== 'PROCESSED') throw new Error('esperado PROCESSED');

    const events = transition(refund, PendingReference, wallet, outcome.ledgerEntry);

    expect(types(events)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect((events[0] as WagerTransactionProcessed).data.referenceTransactionId).toBe('bet-1');
    expect((events[1] as WalletBalanceChanged).data).toMatchObject({
      direction: 'CREDIT',
      transactionId: 'refund-1',
      walletVersion: 2,
    });
  });

  test('esgotamento (PENDING_REFERENCE → REJECTED): só Rejected com REFERENCE_NOT_FOUND', () => {
    const wallet = openWallet();
    const refund = waiting(reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1')));
    refund.reject(FailureCodes.ReferenceNotFound);

    const events = transition(refund, PendingReference, wallet, null);

    expect(types(events)).toEqual(['WagerTransactionRejected']);
    expect((events[0] as WagerTransactionRejected).data.failureCode).toBe('REFERENCE_NOT_FOUND');
  });

  test('rejeição por player divergente: Rejected (o player só é conferido com movimento)', () => {
    const wallet = openWallet(10_000n, 'player-2');
    const transaction = wager(Bet, 'bet-1');
    expect(() => applyBet({ transaction, wallet, ledgerEntryId: 'entry-1', at: at(5) })).toThrow(
      WalletPlayerMismatchError,
    );
    transaction.reject(FailureCodes.PlayerWalletMismatch);

    expect(types(transition(transaction, Pending, wallet, null))).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  /** REFUND do player-1 entrando em `PENDING_REFERENCE` na wallet-1 (saldo 100,00). */
  function waitingRefund() {
    const wallet = openWallet();
    const refund = reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1'));
    applyRefund({
      transaction: refund,
      reference: undefined,
      alreadyRefunded: false,
      wallet,
      ledgerEntryId: 'entry-1',
      at: at(5),
    });
    return { wallet, refund };
  }

  test.each([
    [
      'rejeição com lançamento',
      /REJECTED não pode ter lançamento/,
      () => {
        const { wallet, ledgerEntry } = placedBet();
        const rejected = wager(Bet, 'bet-1');
        rejected.reject(FailureCodes.InsufficientFunds);
        return { transaction: rejected, previous: Pending, wallet, ledgerEntry };
      },
    ],
    [
      'PENDING_REFERENCE com lançamento',
      /PENDING_REFERENCE não pode ter lançamento/,
      () => {
        const { wallet, refund } = waitingRefund();
        const credit = entry('refund-1', LedgerDirection.Credit, 2_500n, 10_000n);
        return { transaction: refund, previous: Pending, wallet, ledgerEntry: credit };
      },
    ],
    [
      'BET aplicada sem lançamento',
      /BET bet-1 aplicada sem lançamento/,
      () => {
        const { wallet, transaction } = placedBet();
        return { transaction, previous: Pending, wallet, ledgerEntry: null };
      },
    ],
    [
      'LOSS aplicada com lançamento',
      /LOSS bet-1 aplicada com lançamento/,
      () => {
        const { wallet, ledgerEntry } = placedBet();
        const loss = wager(Loss, 'bet-1');
        applyLoss({ transaction: loss, wallet, at: at(5) });
        return { transaction: loss, previous: Pending, wallet, ledgerEntry };
      },
    ],
    [
      'estado anterior terminal',
      /a partir de PROCESSED/,
      () => {
        const { wallet, transaction, ledgerEntry } = placedBet();
        return { transaction, previous: Processed, wallet, ledgerEntry };
      },
    ],
    [
      'transação ainda PENDING',
      /Nenhum evento definido/,
      () => ({
        transaction: wager(Bet, 'bet-1'),
        previous: Pending,
        wallet: openWallet(),
        ledgerEntry: null,
      }),
    ],
    [
      'lançamento de outra transação',
      /não pertence à transação win-9/,
      () => {
        // A WIN é aplicada, mas recebe o lançamento da BET.
        const { wallet, ledgerEntry: betEntry } = placedBet();
        const win = wager(Win, 'win-9');
        applyWin({ transaction: win, wallet, ledgerEntryId: 'entry-9', at: at(6) });
        return { transaction: win, previous: Pending, wallet, ledgerEntry: betEntry };
      },
    ],
    [
      'BET aplicada com lançamento CREDIT',
      /é CREDIT; BET exige DEBIT/,
      () => {
        // Saldo 100,00 → 75,00 pela BET; o lançamento informado credita 50,00 → 75,00.
        const { wallet, transaction } = placedBet();
        const credit = entry('bet-1', LedgerDirection.Credit, 2_500n, 5_000n);
        return { transaction, previous: Pending, wallet, ledgerEntry: credit };
      },
    ],
    [
      'valor do lançamento diferente do da transação',
      /tem valor 10\.00 BRL; a transação bet-1, 25\.00 BRL/,
      () => {
        const { wallet, transaction } = placedBet();
        const debit = entry('bet-1', LedgerDirection.Debit, 1_000n, 8_500n);
        return { transaction, previous: Pending, wallet, ledgerEntry: debit };
      },
    ],
    [
      'wallet diferente da transação',
      /não é da wallet wallet-2/,
      () => {
        const { transaction, ledgerEntry } = placedBet();
        const other = Wallet.open({
          id: 'wallet-2',
          playerId: 'player-1',
          initialBalance: brl(7_500n),
          openedAt: T0,
          opening: { transactionId: 'opening-2', ledgerEntryId: 'entry-8' },
        }).wallet;
        return { transaction, previous: Pending, wallet: other, ledgerEntry };
      },
    ],
    [
      'aplicada na wallet de outro player',
      /é do player player-1; a wallet wallet-1, do player-2/,
      () => ({
        transaction: processed(Loss, 'loss-1'),
        previous: Pending,
        wallet: openWallet(10_000n, 'player-2'),
        ledgerEntry: null,
      }),
    ],
    [
      'em espera na wallet de outro player',
      /é do player player-1; a wallet wallet-1, do player-2/,
      () => {
        const { refund } = waitingRefund();
        return {
          transaction: refund,
          previous: Pending,
          wallet: openWallet(10_000n, 'player-2'),
          ledgerEntry: null,
        };
      },
    ],
    [
      'BET vinda de PENDING_REFERENCE (não referencia nada)',
      /não poderia aguardar referência/,
      () => {
        const { wallet, transaction, ledgerEntry } = placedBet();
        return { transaction, previous: PendingReference, wallet, ledgerEntry };
      },
    ],
    [
      'REFUND aplicado sem o id interno da referência',
      /REFUND refund-1 aplicada sem o id interno da referência/,
      () => {
        // Estado que `markProcessed` recusa; só uma reidratação o produz.
        const refund = rehydrated(
          reversalOf(Refund, 'refund-1', processed(Bet, 'bet-1')),
          Processed,
          at(5),
        );
        return { transaction: refund, previous: Pending, wallet: openWallet(), ledgerEntry: null };
      },
    ],
  ])('inconsistente (%s): InvalidIntegrationEventError', (_case, message, make) => {
    const { transaction, previous, wallet, ledgerEntry } = make();

    expect(() => transition(transaction, previous, wallet, ledgerEntry)).toThrow(
      InvalidIntegrationEventError,
    );
    expect(() => transition(transaction, previous, wallet, ledgerEntry)).toThrow(message);
  });

  test('FAILED não tem evento definido', () => {
    const transaction = wager(Bet, 'bet-1');
    transaction.fail('INFRASTRUCTURE_ERROR');

    expect(() => transition(transaction, Pending, openWallet(), null)).toThrow(
      InvalidIntegrationEventError,
    );
  });

  test('OPENING não passa por aqui', () => {
    const opening = WagerTransaction.opening({
      id: 'opening-tx',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl(10_000n),
      at: T0,
    });

    expect(() => transition(opening, Pending, openWallet(), null)).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('eventsForWalletOpening (interpretação do projeto)', () => {
  function open(cents: bigint) {
    const opening =
      cents > 0n
        ? WagerTransaction.opening({
            id: 'opening-tx',
            walletId: 'wallet-1',
            playerId: 'player-1',
            money: brl(cents),
            at: T0,
          })
        : null;
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl(cents),
      openedAt: T0,
      ...(opening === null
        ? {}
        : { opening: { transactionId: opening.id, ledgerEntryId: 'entry-0' } }),
    });
    return { wallet, opening, openingEntry };
  }

  test('saldo inicial positivo: Processed da OPENING e WalletBalanceChanged de 0 ao saldo, versão 1', () => {
    const { wallet, opening, openingEntry } = open(10_000n);

    const events = eventsForWalletOpening({
      wallet,
      opening,
      openingEntry,
      correlationId: CORRELATION,
      newId: ids(),
    });

    expect(events.map((e) => e.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect((events[0] as WagerTransactionProcessed).data).toMatchObject({
      kind: 'OPENING',
      providerId: null,
      externalTransactionId: null,
      roundId: null,
    });
    expect((events[1] as WalletBalanceChanged).toJSON()).toMatchObject({
      aggregateId: 'wallet-1',
      occurredAt: T0.toISOString(),
      data: {
        transactionId: 'opening-tx',
        direction: 'CREDIT',
        money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
  });

  test('saldo inicial zero: nenhum evento', () => {
    const { wallet, opening, openingEntry } = open(0n);

    expect(
      eventsForWalletOpening({
        wallet,
        opening,
        openingEntry,
        correlationId: CORRELATION,
        newId: ids(),
      }),
    ).toEqual([]);
  });

  test('OPENING sem lançamento (ou o contrário): InvalidIntegrationEventError', () => {
    const { wallet, opening } = open(10_000n);

    expect(() =>
      eventsForWalletOpening({
        wallet,
        opening,
        openingEntry: null,
        correlationId: CORRELATION,
        newId: ids(),
      }),
    ).toThrow(InvalidIntegrationEventError);
  });

  test('transação que não é OPENING: InvalidIntegrationEventError', () => {
    const { wallet, openingEntry } = open(10_000n);

    expect(() =>
      eventsForWalletOpening({
        wallet,
        opening: processed(Bet, 'opening-tx'),
        openingEntry,
        correlationId: CORRELATION,
        newId: ids(),
      }),
    ).toThrow(InvalidIntegrationEventError);
  });

  const openingOf = (overrides: { walletId?: string; playerId?: string; cents?: bigint } = {}) =>
    WagerTransaction.opening({
      id: 'opening-tx',
      walletId: overrides.walletId ?? 'wallet-1',
      playerId: overrides.playerId ?? 'player-1',
      money: brl(overrides.cents ?? 10_000n),
      at: T0,
    });

  test.each([
    [
      'lançamento sem OPENING',
      /OPENING e lançamento juntos, ou de nenhum/,
      () => ({ ...open(10_000n), opening: null }),
    ],
    [
      'saldo positivo sem OPENING nem lançamento',
      /saldo inicial positivo e nenhuma OPENING/,
      () => ({ wallet: open(10_000n).wallet, opening: null, openingEntry: null }),
    ],
    [
      'wallet já movimentada (versão 2)',
      /versão 2; uma abertura está na versão 1/,
      () => {
        const opened = open(10_000n);
        opened.wallet.credit({
          transactionId: 'win-1',
          ledgerEntryId: 'entry-1',
          money: brl(100n),
          at: at(1),
        });
        return opened;
      },
    ],
    [
      'wallet de saldo zero já movimentada (versão 3)',
      /versão 3; uma abertura está na versão 1/,
      () => {
        const opened = open(0n);
        const movement = { transactionId: 'win-1', money: brl(100n), at: at(1) };
        opened.wallet.credit({ ...movement, ledgerEntryId: 'entry-1' });
        opened.wallet.debit({ ...movement, transactionId: 'bet-1', ledgerEntryId: 'entry-2' });
        return opened;
      },
    ],
    [
      'crédito que não parte de saldo zero',
      /não parte de saldo zero/,
      () => ({
        ...open(10_000n),
        openingEntry: entry('opening-tx', LedgerDirection.Credit, 10_000n, 500n, 'entry-0'),
      }),
    ],
    [
      'OPENING de outra wallet',
      /A OPENING opening-tx não é da wallet wallet-1/,
      () => ({ ...open(10_000n), opening: openingOf({ walletId: 'wallet-2' }) }),
    ],
    [
      'OPENING de outro player',
      /é do player player-2; a wallet wallet-1, do player-1/,
      () => ({ ...open(10_000n), opening: openingOf({ playerId: 'player-2' }) }),
    ],
    [
      'lançamento de outra transação',
      /não pertence à OPENING opening-tx/,
      () => {
        const { wallet, openingEntry } = Wallet.open({
          id: 'wallet-1',
          playerId: 'player-1',
          initialBalance: brl(10_000n),
          openedAt: T0,
          opening: { transactionId: 'other-tx', ledgerEntryId: 'entry-0' },
        });
        return { wallet, opening: openingOf(), openingEntry };
      },
    ],
    [
      'valor do crédito diferente do da OPENING',
      /tem valor 100\.00 BRL; a transação opening-tx, 50\.00 BRL/,
      () => ({ ...open(10_000n), opening: openingOf({ cents: 5_000n }) }),
    ],
    [
      'lançamento DEBIT',
      /é DEBIT; OPENING exige CREDIT/,
      () => ({
        ...open(10_000n),
        // Só um dado persistido corrompido chega aqui: `WalletLedgerEntry.create` recusaria um
        // débito que leva o saldo de 0 a 100,00.
        openingEntry: WalletLedgerEntry.rehydrate({
          id: 'entry-0',
          walletId: 'wallet-1',
          transactionId: 'opening-tx',
          direction: LedgerDirection.Debit,
          money: brl(10_000n),
          balanceBefore: brl(0n),
          balanceAfter: brl(10_000n),
          createdAt: T0,
        }),
      }),
    ],
  ])('inconsistente (%s): InvalidIntegrationEventError', (_case, message, make) => {
    const input = { ...make(), correlationId: CORRELATION, newId: ids() };

    expect(() => eventsForWalletOpening(input)).toThrow(InvalidIntegrationEventError);
    expect(() => eventsForWalletOpening(input)).toThrow(message);
  });
});

describe('tipos (verificados pelo typecheck)', () => {
  const opening = {
    transactionId: 'opening-tx',
    kind: 'OPENING',
    walletId: 'wallet-1',
    playerId: 'player-1',
    providerId: null,
    externalTransactionId: null,
    roundId: null,
    money: { amount: '100.00', currency: 'BRL' },
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
  } as const;
  const processedData = (data: WagerTransactionProcessedData) => data;
  const rejectedData = (data: WagerTransactionRejectedData) => data;

  test('campos externos e referências nulos só na OPENING', () => {
    expect(processedData(opening)).toBe(opening);
    // @ts-expect-error A OPENING não referencia outra transação.
    processedData({ ...opening, referenceTransactionId: 'bet-1' });
    // @ts-expect-error Fora da OPENING, os campos externos não são nulos.
    processedData({ ...opening, kind: 'BET' });
    // @ts-expect-error Uma OPENING nunca é rejeitada.
    rejectedData({ ...opening, failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('envelope: eventType determina o tipo de data', () => {
    const { wallet, transaction, ledgerEntry } = placedBet();
    const envelopes: TransactionEventEnvelope[] = eventsForTransition({
      transaction,
      previousStatus: Pending,
      wallet,
      ledgerEntry,
      correlationId: CORRELATION,
      at: at(5),
      newId: ids(),
    }).map((event) => event.toJSON());

    const versions = envelopes.map((envelope) => {
      if (envelope.eventType === 'WalletBalanceChanged') return envelope.data.walletVersion;
      // @ts-expect-error walletVersion só existe no data de WalletBalanceChanged.
      return envelope.data.walletVersion;
    });

    expect(versions).toEqual([undefined, 2]);
  });
});
