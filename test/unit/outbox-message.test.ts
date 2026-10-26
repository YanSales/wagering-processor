import { describe, expect, test } from 'bun:test';
import {
  eventsForTransition,
  eventsForWalletOpening,
} from '../../src/application/events/transaction-events';
import { OUTBOX_EVENT_TYPES, OutboxMessage } from '../../src/application/outbox/outbox-message';
import { applyBet } from '../../src/domain/bet';
import { WagerTransaction, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { at, brl, T0, wager } from '../support/wager-fixtures';

function ids() {
  let n = 0;
  return () => `evt-${++n}`;
}

function placedBetEvents() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(10_000n),
    openedAt: T0,
    opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' },
  });
  const transaction = wager('BET', 'bet-1');
  const ledgerEntry = applyBet({ transaction, wallet, ledgerEntryId: 'entry-1', at: at(5) });
  return eventsForTransition({
    transaction,
    previousStatus: WagerTransactionStatus.Pending,
    wallet,
    ledgerEntry,
    correlationId: 'corr-1',
    at: at(5),
    newId: ids(),
  });
}

describe('OutboxMessage.enqueue', () => {
  test('colunas derivadas do envelope: eventId, tipo, versão, agregado, grupo FIFO e transação', () => {
    const [processed, balanceChanged] = placedBetEvents().map(OutboxMessage.enqueue);

    expect(processed).toMatchObject({
      id: 'evt-1',
      transactionId: 'bet-1',
      aggregateId: 'bet-1',
      eventType: 'WagerTransactionProcessed',
      eventVersion: 1,
      messageGroupId: 'wallet-1',
      correlationId: 'corr-1',
    });
    // O agregado de WalletBalanceChanged é a wallet; a transação de origem continua identificável.
    expect(balanceChanged).toMatchObject({
      id: 'evt-2',
      transactionId: 'bet-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      messageGroupId: 'wallet-1',
    });
    expect(balanceChanged?.occurredAt.toISOString()).toBe(at(5).toISOString());
  });

  test('payload: o envelope completo de toJSON(), com MoneyProps, congelado', () => {
    const [event] = placedBetEvents();
    if (event === undefined) throw new Error('esperado um evento');

    const message = OutboxMessage.enqueue(event);

    expect(message.payload).toEqual(event.toJSON());
    expect(JSON.parse(JSON.stringify(message.payload))).toEqual(event.toJSON());
    expect(message.payload.data).toMatchObject({ money: { amount: '25.00', currency: 'BRL' } });
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.payload)).toBe(true);
    expect(Object.isFrozen(message.payload.data)).toBe(true);
  });

  test('occurredAt é copiado: alterar a data devolvida não muda a mensagem', () => {
    const [event] = placedBetEvents();
    if (event === undefined) throw new Error('esperado um evento');
    const message = OutboxMessage.enqueue(event);

    message.occurredAt.setTime(0);

    expect(message.occurredAt.toISOString()).toBe(at(5).toISOString());
  });

  test('abertura positiva: OPENING é a transação e a wallet é o grupo', () => {
    const opening = WagerTransaction.opening({
      id: 'opening-tx',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl(10_000n),
      at: T0,
    });
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl(10_000n),
      openedAt: T0,
      opening: { transactionId: opening.id, ledgerEntryId: 'entry-0' },
    });

    const messages = eventsForWalletOpening({
      wallet,
      opening,
      openingEntry,
      correlationId: 'corr-1',
      newId: ids(),
    }).map(OutboxMessage.enqueue);

    expect(messages.map((m) => [m.eventType, m.transactionId, m.messageGroupId])).toEqual([
      ['WagerTransactionProcessed', 'opening-tx', 'wallet-1'],
      ['WalletBalanceChanged', 'opening-tx', 'wallet-1'],
    ]);
  });

  test('os tipos aceitos pelo schema são exatamente os quatro eventos do contrato', () => {
    const types: string[] = [...OUTBOX_EVENT_TYPES];
    expect(types.sort()).toEqual(
      [
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WagerTransactionRejected',
        'WalletBalanceChanged',
      ].sort(),
    );
  });
});
