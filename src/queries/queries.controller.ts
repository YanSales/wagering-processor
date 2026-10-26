import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  InvalidCursorError,
  type LedgerEntryView,
  QUERY_REPOSITORY,
  type QueryRepository,
  ReconcileWallet,
  type TransactionView,
} from '../application/queries';
import type { MoneyProps } from '../domain/money';
import { metrics } from '../observability/metrics';
import { RequestErrorCodes, requestError } from '../wagering/wagering-transactions.controller';
import { toWalletResponse, type WalletResponse } from '../wallets/open-wallet.request';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerResponse {
  items: LedgerEntryResponse[];
  /** Opaco: repassar como `cursor` para a próxima página; `null` no fim. */
  nextCursor: string | null;
}

export interface TransactionResponse {
  transactionId: string;
  walletId: string;
  playerId: string;
  kind: string;
  status: string;
  providerId: string | null;
  externalTransactionId: string | null;
  roundId: string | null;
  gameId: string | null;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Consultas e reconciliação de wallets (contrato §9). Erros no formato comum da API: 400
 * `INVALID_REQUEST` (id que não é UUID, `limit` ou `cursor` inválidos), 404 `WALLET_NOT_FOUND`.
 */
@Controller('wallets')
export class WalletQueriesController {
  readonly #logger = new Logger('WalletReconciliation');

  constructor(
    @Inject(QUERY_REPOSITORY) private readonly queries: QueryRepository,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Get(':walletId')
  async wallet(@Param('walletId') walletId: string): Promise<WalletResponse> {
    const wallet = await this.queries.findWallet(uuid('walletId', walletId));
    if (wallet === null) throw walletNotFound(walletId);
    return toWalletResponse(wallet);
  }

  /** `GET /wallets/:walletId/ledger?cursor&limit`: do lançamento mais antigo ao mais recente. */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<LedgerResponse> {
    const id = uuid('walletId', walletId);
    const size = parseLimit(limit);
    const afterId = cursor === undefined ? undefined : decodeCursor(cursor);
    let page: Awaited<ReturnType<QueryRepository['listLedger']>>;
    try {
      page = await this.queries.listLedger(id, size, afterId);
    } catch (error) {
      if (error instanceof InvalidCursorError) throw invalid(error.message);
      throw error;
    }
    if (page === null) throw walletNotFound(walletId);
    return {
      items: page.items.map(toEntryResponse),
      nextCursor: page.lastId === null ? null : encodeCursor(page.lastId),
    };
  }

  /**
   * `POST /wallets/:walletId/reconciliation`: compara o saldo armazenado com o reconstruído pelo
   * ledger. Não corrige nada; divergência sai em `consistent: false`, num log de alerta e em
   * `wagering_reconciliation_divergences_total` (sem rótulos: o `walletId` fica só no log).
   */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(@Param('walletId') walletId: string): Promise<ReconciliationResponse> {
    const result = await this.reconcile.execute(uuid('walletId', walletId));
    if (result === null) throw walletNotFound(walletId);
    if (!result.consistent) {
      metrics.reconciliationDivergences.inc();
      this.#logger.warn(
        JSON.stringify({
          event: 'wallet_reconciliation_divergence',
          walletId: result.walletId,
          checkedEntries: result.checkedEntries,
        }),
      );
    }
    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toProps(),
      calculatedBalance: result.calculatedBalance.toProps(),
      difference: result.difference.toProps(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}

/** `GET /wagering/transactions/:transactionId` (contrato §9). */
@Controller('wagering/transactions')
export class TransactionQueriesController {
  constructor(@Inject(QUERY_REPOSITORY) private readonly queries: QueryRepository) {}

  @Get(':transactionId')
  async byId(@Param('transactionId') transactionId: string): Promise<TransactionResponse> {
    const found = await this.queries.findTransaction(uuid('transactionId', transactionId));
    if (found === null) throw transactionNotFound();
    return toTransactionResponse(found);
  }
}

/** `GET /providers/:providerId/wagering/transactions/:externalTransactionId` (contrato §9). */
@Controller('providers')
export class ProviderTransactionsController {
  constructor(@Inject(QUERY_REPOSITORY) private readonly queries: QueryRepository) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionResponse> {
    const found = await this.queries.findTransactionByExternalId(
      text('providerId', providerId),
      text('externalTransactionId', externalTransactionId),
    );
    if (found === null) throw transactionNotFound();
    return toTransactionResponse(found);
  }
}

function uuid(name: string, value: string): string {
  if (!UUID.test(value)) throw invalid(`${name} deve ser um UUID.`);
  return value;
}

function text(name: string, value: string): string {
  if (value.trim() === '' || value.includes('\u0000')) {
    throw invalid(`${name} deve ser uma string não vazia.`);
  }
  return value;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LEDGER_LIMIT;
  const value = Number(raw);
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || value < 1 || value > MAX_LEDGER_LIMIT) {
    throw invalid(`limit deve ser um inteiro entre 1 e ${MAX_LEDGER_LIMIT}.`);
  }
  return value;
}

/** O cursor é o id do último lançamento devolvido, em base64url: opaco para o cliente. */
function encodeCursor(lastId: string): string {
  return Buffer.from(lastId, 'utf8').toString('base64url');
}

function decodeCursor(raw: unknown): string {
  const decoded = typeof raw === 'string' ? Buffer.from(raw, 'base64url').toString('utf8') : '';
  if (!UUID.test(decoded)) throw invalid('cursor inválido.');
  return decoded;
}

function invalid(message: string) {
  return requestError(HttpStatus.BAD_REQUEST, RequestErrorCodes.InvalidRequest, message);
}

function walletNotFound(walletId: string) {
  return requestError(
    HttpStatus.NOT_FOUND,
    RequestErrorCodes.WalletNotFound,
    `A wallet ${walletId} não existe.`,
  );
}

function transactionNotFound() {
  return requestError(
    HttpStatus.NOT_FOUND,
    RequestErrorCodes.TransactionNotFound,
    'A transação não existe.',
  );
}

function toEntryResponse(entry: LedgerEntryView): LedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toProps(),
    balanceBefore: entry.balanceBefore.toProps(),
    balanceAfter: entry.balanceAfter.toProps(),
    createdAt: entry.createdAt.toISOString(),
  };
}

function toTransactionResponse(view: TransactionView): TransactionResponse {
  return {
    transactionId: view.transactionId,
    walletId: view.walletId,
    playerId: view.playerId,
    kind: view.kind,
    status: view.status,
    providerId: view.providerId,
    externalTransactionId: view.externalTransactionId,
    roundId: view.roundId,
    gameId: view.gameId,
    money: view.money.toProps(),
    referenceExternalTransactionId: view.referenceExternalTransactionId,
    referenceTransactionId: view.referenceTransactionId,
    failureCode: view.failureCode,
    balance: view.resultBalance === null ? null : view.resultBalance.toProps(),
    createdAt: view.createdAt.toISOString(),
    processedAt: view.processedAt === null ? null : view.processedAt.toISOString(),
  };
}
