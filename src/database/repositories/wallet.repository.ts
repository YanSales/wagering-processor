import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  type OpenedWallet,
  WalletAlreadyExistsError,
  type WalletRepository,
} from '../../application/wallet-repository';
import type { Wallet } from '../../domain/wallet';
import { WagerTransactionRecord } from '../schema/wager-transaction.schema';
import { WalletRecord } from '../schema/wallet.schema';
import { assertStorable, insertLedgerEntry, toTransactionRecord } from './persistence';

export { PG_BIGINT_MAX, PG_BIGINT_MIN } from './persistence';

const WALLET_PLAYER_CURRENCY_UNIQUE = 'wallets_player_id_currency_unique';

/**
 * `WalletRepository` sobre MikroORM/PostgreSQL. Converte objetos de domínio em linhas de
 * persistência; o domínio nunca recebe entidades gerenciadas pelo ORM.
 */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly orm: MikroORM) {}

  async insertOpened({ wallet, opening, openingEntry }: OpenedWallet): Promise<void> {
    // Antes da transação: um valor fora da faixa não chega ao banco (que o recusaria com erro genérico).
    assertStorable(wallet.balance);
    if (opening !== null) assertStorable(opening.money);
    if (openingEntry !== null) {
      assertStorable(openingEntry.money);
      assertStorable(openingEntry.balanceBefore);
      assertStorable(openingEntry.balanceAfter);
    }
    try {
      // Um fork por operação: a unidade de trabalho não é compartilhada entre chamadas.
      await this.orm.em.fork().transactional(async (em) => {
        const walletRecord = em.create(WalletRecord, toWalletRecord(wallet));
        if (opening !== null) {
          em.create(WagerTransactionRecord, toTransactionRecord(opening, walletRecord, null));
        }
        // Wallet e OPENING precisam existir antes do lançamento (FKs).
        await em.flush();
        if (openingEntry !== null) {
          await insertLedgerEntry(em, openingEntry);
        }
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
