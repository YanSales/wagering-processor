import { randomUUID } from 'node:crypto';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { eventsForWalletOpening } from '../../application/events/transaction-events';
import { OutboxMessage } from '../../application/outbox/outbox-message';
import {
  type OpenedWallet,
  WalletAlreadyExistsError,
  type WalletRepository,
} from '../../application/wallet-repository';
import type { Wallet } from '../../domain/wallet';
import { WagerTransactionRecord } from '../schema/wager-transaction.schema';
import { WalletRecord } from '../schema/wallet.schema';
import {
  assertStorable,
  insertLedgerEntry,
  insertOutboxMessages,
  toTransactionRecord,
} from './persistence';

export { PG_BIGINT_MAX, PG_BIGINT_MIN } from './persistence';

const WALLET_PLAYER_CURRENCY_UNIQUE = 'wallets_player_id_currency_unique';

/**
 * `WalletRepository` sobre MikroORM/PostgreSQL. Converte objetos de domínio em linhas de
 * persistência; o domínio nunca recebe entidades gerenciadas pelo ORM.
 */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly orm: MikroORM,
    /** Gera o `eventId` (id da linha da outbox) de cada evento. */
    private readonly newEventId: () => string = randomUUID,
  ) {}

  async insertOpened({
    wallet,
    opening,
    openingEntry,
    correlationId,
  }: OpenedWallet): Promise<void> {
    // Antes da transação: um valor fora da faixa não chega ao banco (que o recusaria com erro genérico).
    assertStorable(wallet.balance);
    if (opening !== null) assertStorable(opening.money);
    if (openingEntry !== null) {
      assertStorable(openingEntry.money);
      assertStorable(openingEntry.balanceBefore);
      assertStorable(openingEntry.balanceAfter);
    }
    // Eventos da abertura (nenhum com saldo inicial zero), validados contra as regras de `Wallet.open`
    // e gravados na mesma transação SQL da wallet.
    const events = eventsForWalletOpening({
      wallet,
      opening,
      openingEntry,
      correlationId,
      newId: this.newEventId,
    });
    try {
      // Um fork por operação: a unidade de trabalho não é compartilhada entre chamadas.
      await this.orm.em.fork().transactional(async (em) => {
        const walletRecord = em.create(WalletRecord, toWalletRecord(wallet));
        if (opening !== null) {
          em.create(
            WagerTransactionRecord,
            toTransactionRecord(opening, walletRecord, null, { correlationId }),
          );
        }
        // Wallet e OPENING precisam existir antes do lançamento e dos eventos (FKs).
        await em.flush();
        if (openingEntry !== null) {
          await insertLedgerEntry(em, openingEntry);
        }
        await insertOutboxMessages(em, events.map(OutboxMessage.enqueue));
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        (error as { constraint?: string }).constraint === WALLET_PLAYER_CURRENCY_UNIQUE
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency, { cause: error });
      }
      throw error;
    }
  }
}

function toWalletRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balanceCents: wallet.balance.cents,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
