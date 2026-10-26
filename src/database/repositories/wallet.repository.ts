import { type EntityManager, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  AmountOutOfStorageRangeError,
  type OpenedWallet,
  WalletAlreadyExistsError,
  type WalletRepository,
} from '../../application/wallet-repository';
import type { Money } from '../../domain/money';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WagerTransactionRecord } from '../schema/wager-transaction.schema';
import { WalletRecord } from '../schema/wallet.schema';

const WALLET_PLAYER_CURRENCY_UNIQUE = 'wallets_player_id_currency_unique';

/** Faixa das colunas `bigint` (inteiro de 64 bits com sinal) do PostgreSQL, em centavos. */
export const PG_BIGINT_MIN = -9_223_372_036_854_775_808n;
export const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

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
          em.create(WagerTransactionRecord, toTransactionRecord(opening, walletRecord));
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

function assertStorable(money: Money): void {
  if (money.cents < PG_BIGINT_MIN || money.cents > PG_BIGINT_MAX) {
    throw new AmountOutOfStorageRangeError(money, PG_BIGINT_MIN, PG_BIGINT_MAX);
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

function toTransactionRecord(
  transaction: WagerTransaction,
  wallet: WalletRecord,
): WagerTransactionRecord {
  return {
    id: transaction.id,
    wallet,
    playerId: transaction.playerId,
    kind: transaction.kind,
    status: transaction.status,
    providerId: transaction.providerId ?? null,
    externalTransactionId: transaction.externalTransactionId ?? null,
    idempotencyKey: transaction.idempotencyKey ?? null,
    payloadHash: transaction.payloadHash ?? null,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    moneyCents: transaction.money.cents,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    // Só a OPENING é gravada por enquanto; referências resolvidas entram com as reversões.
    referenceTransaction: null,
    failureCode: transaction.failureCode ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

/**
 * Insere o lançamento com SQL cru no contexto transacional do `em`
 * (`em.getTransactionContext()`). Os placeholders `?` são substituídos
 * pelo MikroORM no cliente, com os valores formatados e escapados; eles
 * não são enviados ao PostgreSQL como parâmetros separados.
 *
 * O MikroORM 7.2.5 não preenche a FK composta `(wallet_id, currency) ->
 * wallets (id, currency)` (que não é a PK): envia `currency` como
 * `undefined`.
 */
async function insertLedgerEntry(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
  try {
    await em.getConnection().execute(
      `insert into "wallet_ledger_entries" ("id", "wallet_id", "currency", "transaction_id", "direction",
         "money_cents", "balance_before_cents", "balance_after_cents", "created_at")
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        // Moeda do próprio lançamento: a FK composta confere que é a da wallet.
        entry.money.currency,
        entry.transactionId,
        entry.direction,
        entry.money.cents.toString(),
        entry.balanceBefore.cents.toString(),
        entry.balanceAfter.cents.toString(),
        entry.createdAt,
      ],
      'run',
      em.getTransactionContext(),
    );
  } catch (error) {
    // O SQL cru não passa pelo conversor do ORM; converte para o mesmo tipo que o `flush` lança.
    throw em.getDriver().convertException(error as Error);
  }
}
