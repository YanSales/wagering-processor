import type { MikroORM } from '@mikro-orm/postgresql';
import {
  InvalidCursorError,
  type LedgerEntryView,
  type LedgerPage,
  type QueryRepository,
  type TransactionView,
} from '../../application/queries';
import { Money } from '../../domain/money';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EntryRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  currency: string;
  money: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
}

interface TransactionRow {
  id: string;
  wallet_id: string;
  player_id: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  provider_id: string | null;
  external_transaction_id: string | null;
  round_id: string | null;
  game_id: string | null;
  money: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  failure_code: FailureCode | null;
  result_balance: string | null;
  created_at: Date | string;
  processed_at: Date | string | null;
}

// Valores `bigint` sempre como texto: convertidos direto para centavos, sem passar por number.
const WALLET_COLUMNS = `id, player_id, currency, balance_cents::text as balance, version,
  created_at, updated_at`;
const ENTRY_COLUMNS = `e.id, e.wallet_id, e.transaction_id, e.direction, e.currency,
  e.money_cents::text as money, e.balance_before_cents::text as balance_before,
  e.balance_after_cents::text as balance_after, e.created_at`;
const TRANSACTION_COLUMNS = `id, wallet_id, player_id, kind, status, provider_id,
  external_transaction_id, round_id, game_id, money_cents::text as money, currency,
  reference_external_transaction_id, reference_transaction_id, failure_code,
  result_balance_cents::text as result_balance, created_at, processed_at`;

/**
 * Consultas da API (contrato §9) sobre o PostgreSQL. Devolvem objetos de domínio ou visões de
 * leitura, nunca entidades do ORM.
 *
 * O ledger é paginado por conjunto de chaves `(created_at, id)`: estável sob inserções concorrentes
 * (lançamentos são imutáveis) e sem `OFFSET`. `created_at` vem do relógio da instância que aplicou a
 * movimentação.
 */
export class MikroOrmQueryRepository implements QueryRepository {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(walletId: string): Promise<Wallet | null> {
    const [row] = (await this.#execute(`select ${WALLET_COLUMNS} from wallets where id = ?`, [
      walletId,
    ])) as WalletRow[];
    return row === undefined ? null : toWallet(row);
  }

  async listLedger(walletId: string, limit: number, afterId?: string): Promise<LedgerPage | null> {
    if ((await this.findWallet(walletId)) === null) return null;
    let after: { created_at: Date | string; id: string } | undefined;
    if (afterId !== undefined) {
      [after] = (await this.#execute(
        'select created_at, id from wallet_ledger_entries where id = ? and wallet_id = ?',
        [afterId, walletId],
      )) as { created_at: Date | string; id: string }[];
      if (after === undefined) throw new InvalidCursorError();
    }
    // Um a mais para saber se há próxima página.
    const rows = (await this.#execute(
      `select ${ENTRY_COLUMNS} from wallet_ledger_entries e
        where e.wallet_id = ?
          ${after === undefined ? '' : 'and (e.created_at, e.id) > (?, ?)'}
        order by e.created_at, e.id
        limit ?`,
      after === undefined
        ? [walletId, limit + 1]
        : [walletId, new Date(after.created_at), after.id, limit + 1],
    )) as EntryRow[];
    const items = rows.slice(0, limit).map(toEntryView);
    return { items, lastId: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  async findTransaction(transactionId: string): Promise<TransactionView | null> {
    const [row] = (await this.#execute(
      `select ${TRANSACTION_COLUMNS} from wager_transactions where id = ?`,
      [transactionId],
    )) as TransactionRow[];
    return row === undefined ? null : toTransactionView(row);
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView | null> {
    const [row] = (await this.#execute(
      `select ${TRANSACTION_COLUMNS} from wager_transactions
        where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    )) as TransactionRow[];
    return row === undefined ? null : toTransactionView(row);
  }

  async loadForReconciliation(
    walletId: string,
  ): Promise<{ wallet: Wallet; entries: WalletLedgerEntry[] } | null> {
    return this.orm.em.fork().transactional(async (em) => {
      const connection = em.getConnection();
      const context = em.getTransactionContext();
      // `FOR SHARE`: toda movimentação atualiza a wallet sob `FOR UPDATE`, então nenhuma pode ocorrer
      // entre a leitura do saldo e a dos lançamentos; a reconciliação não bloqueia outras leituras.
      const [row] = (await connection.execute(
        `select ${WALLET_COLUMNS} from wallets where id = ? for share`,
        [walletId],
        'all',
        context,
      )) as WalletRow[];
      if (row === undefined) return null;
      const entries = (await connection.execute(
        `select ${ENTRY_COLUMNS} from wallet_ledger_entries e where e.wallet_id = ?
          order by e.created_at, e.id`,
        [walletId],
        'all',
        context,
      )) as EntryRow[];
      return {
        wallet: toWallet(row),
        entries: entries.map((e) => WalletLedgerEntry.rehydrate({ ...toEntryView(e), walletId })),
      };
    });
  }

  #execute(sql: string, params: unknown[]): Promise<unknown[]> {
    return this.orm.em.getConnection().execute(sql, params, 'all') as Promise<unknown[]>;
  }
}

function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    balance: Money.fromCents(BigInt(row.balance), row.currency),
    version: row.version,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}

function toEntryView(row: EntryRow): LedgerEntryView {
  const money = (cents: string) => Money.fromCents(BigInt(cents), row.currency);
  return {
    id: row.id,
    transactionId: row.transaction_id,
    direction: row.direction,
    money: money(row.money),
    balanceBefore: money(row.balance_before),
    balanceAfter: money(row.balance_after),
    createdAt: new Date(row.created_at),
  };
}

function toTransactionView(row: TransactionRow): TransactionView {
  const money = (cents: string) => Money.fromCents(BigInt(cents), row.currency);
  return {
    transactionId: row.id,
    walletId: row.wallet_id,
    playerId: row.player_id,
    kind: row.kind,
    status: row.status,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    roundId: row.round_id,
    gameId: row.game_id,
    money: money(row.money),
    referenceExternalTransactionId: row.reference_external_transaction_id,
    referenceTransactionId: row.reference_transaction_id,
    failureCode: row.failure_code,
    resultBalance: row.result_balance === null ? null : money(row.result_balance),
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at === null ? null : new Date(row.processed_at),
  };
}
