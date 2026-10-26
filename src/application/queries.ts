import type { Money } from '../domain/money';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { reconcileWallet, type WalletReconciliation } from '../domain/wallet-reconciliation';

/** Lançamento do ledger como exposto pela API (contrato §9, `GET /wallets/:walletId/ledger`). */
export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Último lançamento devolvido, quando há mais; `null` no fim. */
  lastId: string | null;
}

/** Transação como exposta pela API (contrato §9, consultas por id interno ou do provedor). */
export interface TransactionView {
  transactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  providerId: string | null;
  externalTransactionId: string | null;
  roundId: string | null;
  gameId: string | null;
  money: Money;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  /** Saldo observado ao concluir (§7, regra 7); `null` na `OPENING`. */
  resultBalance: Money | null;
  createdAt: Date;
  processedAt: Date | null;
}

/** Leituras da API. Não travam a wallet, exceto a reconciliação (leitura consistente). */
export interface QueryRepository {
  findWallet(walletId: string): Promise<Wallet | null>;
  /** `null` se a wallet não existir; `afterId` desconhecido para a wallet lança `InvalidCursorError`. */
  listLedger(walletId: string, limit: number, afterId?: string): Promise<LedgerPage | null>;
  findTransaction(transactionId: string): Promise<TransactionView | null>;
  findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView | null>;
  /**
   * Wallet e todos os seus lançamentos numa leitura consistente (nenhuma movimentação no meio), ou
   * `null` se a wallet não existir.
   */
  loadForReconciliation(
    walletId: string,
  ): Promise<{ wallet: Wallet; entries: WalletLedgerEntry[] } | null>;
}

/** Token da porta `QueryRepository` (interface, sem representação em runtime). */
export const QUERY_REPOSITORY = Symbol('QUERY_REPOSITORY');

/** Cursor de paginação que não corresponde a um lançamento da wallet. */
export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';

  constructor() {
    super('cursor inválido para esta wallet.');
  }
}

/**
 * Reconciliação de uma wallet (contrato §9, `POST /wallets/:walletId/reconciliation`, e §13): compara
 * o saldo armazenado com o reconstruído pelo ledger. Não corrige nada; divergência é sinalizada em
 * `consistent: false`. `null` se a wallet não existir.
 */
export class ReconcileWallet {
  constructor(private readonly queries: QueryRepository) {}

  async execute(walletId: string): Promise<WalletReconciliation | null> {
    const loaded = await this.queries.loadForReconciliation(walletId);
    return loaded === null ? null : reconcileWallet(loaded.wallet, loaded.entries);
  }
}
