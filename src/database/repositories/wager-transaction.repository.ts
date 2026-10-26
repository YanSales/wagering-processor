import {
  DeadlockException,
  type EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  type ExistingSubmissions,
  type PendingReferenceRepository,
  type PendingReferenceState,
  type PendingReferenceTask,
  type ReferenceQuery,
  type ResolvedReference,
  type StoredSubmission,
  type SubmissionDecision,
  type SubmissionKeys,
  type SubmissionOutcome,
  TransientPersistenceError,
  type WagerTransactionRepository,
  WalletNotFoundError,
} from '../../application/wager-transaction-repository';
import { Money } from '../../domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WagerTransactionRecord } from '../schema/wager-transaction.schema';
import { WalletRecord } from '../schema/wallet.schema';
import { assertStorable, insertLedgerEntry, toTransactionRecord } from './persistence';

/** Constraints que identificam a mesma submissão (corrida entre wallets diferentes). */
const SUBMISSION_UNIQUES = new Set([
  'wager_transactions_idempotency_key_unique',
  'wager_transactions_provider_external_unique',
]);

/**
 * SQLSTATEs transitórios: serialização e deadlock (`40001`, `40P01`), servidor encerrando ou ainda
 * indisponível (`57P01`–`57P03`), conexões esgotadas (`53300`) e lock indisponível (`55P03`). A classe
 * `08` (conexão) é tratada inteira.
 */
const TRANSIENT_SQLSTATES = new Set([
  '40001',
  '40P01',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '55P03',
]);
/** Erros de socket do Node ao falar com o banco. */
const TRANSIENT_SOCKET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/** `true` se a falha é transitória e a operação pode ser repetida. Na dúvida, não é. */
export function isTransientPersistenceFailure(error: unknown): boolean {
  if (error instanceof DeadlockException) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return code.startsWith('08') || TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SOCKET_CODES.has(code);
}

/** Converte falhas transitórias para o erro da porta; as demais seguem inalteradas. */
async function classifyFailures<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isTransientPersistenceFailure(error)) throw new TransientPersistenceError({ cause: error });
    throw error;
  }
}

/**
 * `WagerTransactionRepository` sobre MikroORM/PostgreSQL.
 *
 * Concorrência: lock pessimista da linha da wallet (`SELECT … FOR UPDATE`, `LockMode.PESSIMISTIC_WRITE`)
 * no isolamento padrão do PostgreSQL (`READ COMMITTED`). Escritas na mesma wallet, de qualquer
 * instância, são serializadas pelo banco; ao obter o lock, a leitura já vê o saldo confirmado pela
 * transação anterior. Wallets diferentes não se bloqueiam, e cada transação trava uma única wallet,
 * então não há ciclo de locks entre wallets. O `UPDATE` do saldo ainda exige a versão lida, como
 * defesa contra lost update caso o lock deixe de ser obtido por erro de programação.
 *
 * O worker de `PENDING_REFERENCE` (§7.1) usa a mesma ordem de locks: wallet, depois a transação
 * pendente, relida sob o lock. Duas tentativas da mesma transação se serializam na wallet, e a
 * segunda encontra o estado já gravado pela primeira.
 */
export class MikroOrmWagerTransactionRepository
  implements WagerTransactionRepository, PendingReferenceRepository
{
  constructor(private readonly orm: MikroORM) {}

  findExisting(keys: SubmissionKeys): Promise<ExistingSubmissions> {
    return classifyFailures(() => findExistingIn(this.orm.em.fork(), keys));
  }

  applyToLockedWallet(
    walletId: string,
    keys: SubmissionKeys,
    decide: (wallet: Wallet, reference: ResolvedReference | null) => SubmissionDecision,
    reference?: ReferenceQuery,
  ): Promise<SubmissionOutcome> {
    return classifyFailures(() => this.#applyToLockedWallet(walletId, keys, decide, reference));
  }

  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceTask[]> {
    return classifyFailures(async () => {
      const rows = (await this.orm.em.getConnection().execute(
        `select id, wallet_id from wager_transactions
          where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
          order by next_reference_attempt_at, id
          limit ?`,
        [now, limit],
      )) as { id: string; wallet_id: string }[];
      return rows.map((r) => ({ transactionId: r.id, walletId: r.wallet_id }));
    });
  }

  resolvePendingReference(
    task: PendingReferenceTask,
    now: Date,
    decide: (state: PendingReferenceState) => SubmissionDecision,
  ): Promise<boolean> {
    return classifyFailures(() =>
      this.orm.em.fork().transactional(async (em) => {
        // Wallet antes da transação: a mesma ordem de locks da submissão, sem ciclo entre as duas.
        const row = await em.findOne(
          WalletRecord,
          { id: task.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (row === null) return false;

        // Sob o lock da wallet, outro worker pode já ter concluído ou reagendado esta transação.
        const [pendingRow] = (await em.getConnection().execute(
          `select ${TRANSACTION_COLUMNS}, t.reference_attempts
             from wager_transactions t
            where t.id = ? and t.wallet_id = ? and t.status = 'PENDING_REFERENCE'
              and t.next_reference_attempt_at <= ?
              for update`,
          [task.transactionId, task.walletId, now],
          'all',
          em.getTransactionContext(),
        )) as (TransactionRow & { reference_attempts: number })[];
        if (pendingRow === undefined) return false;

        const pending = toTransaction(pendingRow);
        const reference = await findReferenceIn(em, {
          providerId: pending.providerId as string,
          externalTransactionId: pending.referenceExternalTransactionId as string,
          reversalKind: pending.kind,
        });
        const decision = decide({
          transaction: pending,
          wallet: toWallet(row),
          reference,
          completedAttempts: pendingRow.reference_attempts,
        });
        const { transaction, wallet, ledgerEntry } = assertDecision(decision, row);
        if (transaction.id !== pending.id) {
          throw new Error(`A decisão não se refere à transação pendente ${pending.id}.`);
        }
        assertStorable(wallet.balance);

        const updated = await em.nativeUpdate(
          WagerTransactionRecord,
          { id: pending.id, status: WagerTransactionStatus.PendingReference },
          {
            status: transaction.status,
            failureCode: transaction.failureCode ?? null,
            referenceTransaction: transaction.referenceTransactionId ?? null,
            resultBalanceCents: wallet.balance.cents,
            processedAt: transaction.processedAt ?? null,
            referenceAttempts: pendingRow.reference_attempts + 1,
            nextReferenceAttemptAt: decision.nextReferenceAttemptAt ?? null,
          },
        );
        if (updated !== 1) {
          throw new Error(
            `A transação ${pending.id} saiu de PENDING_REFERENCE durante a tentativa.`,
          );
        }
        if (ledgerEntry !== null) await applyMovement(em, row, wallet, ledgerEntry);
        return true;
      }),
    );
  }

  async #applyToLockedWallet(
    walletId: string,
    keys: SubmissionKeys,
    decide: (wallet: Wallet, reference: ResolvedReference | null) => SubmissionDecision,
    referenceQuery: ReferenceQuery | undefined,
  ): Promise<SubmissionOutcome> {
    try {
      // Um fork por operação: a unidade de trabalho não é compartilhada entre chamadas.
      return await this.orm.em.fork().transactional(async (em) => {
        const row = await em.findOne(
          WalletRecord,
          { id: walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (row === null) throw new WalletNotFoundError(walletId);

        // Sob o lock: uma submissão igual para a mesma wallet já foi confirmada ou ainda não existe.
        const existing = await findExistingIn(em, keys);
        if (existing.byIdempotencyKey !== null || existing.byExternalTransaction !== null) {
          return { kind: 'EXISTING', existing } as const;
        }

        // A referência é lida sob o lock: a BET da mesma wallet não muda nem surge em paralelo.
        const reference =
          referenceQuery === undefined ? null : await findReferenceIn(em, referenceQuery);
        const decision = decide(toWallet(row), reference);
        const { transaction, wallet, ledgerEntry } = assertDecision(decision, row);
        assertStorable(transaction.money);
        assertStorable(wallet.balance);

        const referenceId = transaction.referenceTransactionId;
        em.create(
          WagerTransactionRecord,
          toTransactionRecord(transaction, row, wallet.balance, {
            referenceTransaction:
              referenceId === undefined
                ? null
                : em.getReference(WagerTransactionRecord, referenceId),
            nextReferenceAttemptAt: decision.nextReferenceAttemptAt ?? null,
          }),
        );
        await em.flush();

        if (ledgerEntry !== null) await applyMovement(em, row, wallet, ledgerEntry);

        return {
          kind: 'APPLIED',
          submission: {
            transactionId: transaction.id,
            idempotencyKey: keys.idempotencyKey,
            payloadHash: transaction.payloadHash as string,
            providerId: keys.providerId,
            externalTransactionId: keys.externalTransactionId,
            status: transaction.status,
            failureCode: transaction.failureCode,
            resultBalance: wallet.balance,
          },
        } as const;
      });
    } catch (error) {
      // Outra submissão com as mesmas chaves foi confirmada por outra wallet: esta foi desfeita.
      if (
        error instanceof UniqueConstraintViolationException &&
        SUBMISSION_UNIQUES.has((error as { constraint?: string }).constraint ?? '')
      ) {
        const existing = await this.findExisting(keys);
        if (existing.byIdempotencyKey !== null || existing.byExternalTransaction !== null) {
          return { kind: 'EXISTING', existing };
        }
      }
      throw error;
    }
  }
}

/** Saldo e versão da wallet (com a versão lida como guarda) e o lançamento, na transação do `em`. */
async function applyMovement(
  em: EntityManager,
  row: WalletRecord,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry,
): Promise<void> {
  const updated = await em.nativeUpdate(
    WalletRecord,
    { id: row.id, version: row.version },
    {
      balanceCents: wallet.balance.cents,
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    },
  );
  if (updated !== 1) {
    throw new Error(`A wallet ${row.id} mudou durante a transação (versão ${row.version}).`);
  }
  await insertLedgerEntry(em, ledgerEntry);
}

const DECIDABLE: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.PendingReference,
]);

/** Garante que a decisão diz respeito à wallet travada e está pronta para gravar. */
function assertDecision(decision: SubmissionDecision, row: WalletRecord): SubmissionDecision {
  const { transaction, wallet, ledgerEntry } = decision;
  if (wallet.id !== row.id || transaction.walletId !== row.id) {
    throw new Error(`A decisão não se refere à wallet travada ${row.id}.`);
  }
  if (!DECIDABLE.has(transaction.status)) {
    throw new Error(
      `A decisão precisa ser PROCESSED, REJECTED ou PENDING_REFERENCE; recebido ${transaction.status}.`,
    );
  }
  const pending = transaction.status === WagerTransactionStatus.PendingReference;
  if (pending !== (decision.nextReferenceAttemptAt !== undefined)) {
    throw new Error('A próxima tentativa existe somente, e sempre, em PENDING_REFERENCE.');
  }
  if (pending && ledgerEntry !== null) {
    throw new Error('Uma transação aguardando a referência não movimenta a wallet.');
  }
  const moved = wallet.version !== row.version;
  if ((ledgerEntry !== null) !== moved || (moved && wallet.version !== row.version + 1)) {
    throw new Error('Lançamento e versão da wallet não correspondem a uma única movimentação.');
  }
  if (ledgerEntry !== null && ledgerEntry.transactionId !== transaction.id) {
    throw new Error('O lançamento não pertence à transação decidida.');
  }
  return decision;
}

function toWallet(row: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    balance: Money.fromCents(row.balanceCents, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

interface SubmissionRow {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  provider_id: string;
  external_transaction_id: string;
  status: WagerTransactionStatus;
  failure_code: string | null;
  result_balance: string;
  wallet_currency: string;
}

/** Submissões com a mesma chave ou o mesmo `(providerId, externalTransactionId)`, no contexto do `em`. */
async function findExistingIn(
  em: EntityManager,
  keys: SubmissionKeys,
): Promise<ExistingSubmissions> {
  const rows = (await em.getConnection().execute(
    `select t.id, t.idempotency_key, t.payload_hash, t.provider_id, t.external_transaction_id,
            t.status, t.failure_code, t.result_balance_cents::text as result_balance,
            w.currency as wallet_currency
       from wager_transactions t join wallets w on w.id = t.wallet_id
      where t.idempotency_key = ? or (t.provider_id = ? and t.external_transaction_id = ?)`,
    [keys.idempotencyKey, keys.providerId, keys.externalTransactionId],
    'all',
    em.getTransactionContext(),
  )) as SubmissionRow[];

  const byKey = rows.find((r) => r.idempotency_key === keys.idempotencyKey);
  const byExternal = rows.find(
    (r) =>
      r.provider_id === keys.providerId && r.external_transaction_id === keys.externalTransactionId,
  );
  return {
    byIdempotencyKey: byKey === undefined ? null : toStored(byKey),
    byExternalTransaction: byExternal === undefined ? null : toStored(byExternal),
  };
}

/** Colunas para reidratar uma `WagerTransaction` (alias `t`); valores `bigint` como texto. */
const TRANSACTION_COLUMNS = `t.id, t.wallet_id, t.player_id, t.kind, t.status, t.provider_id,
  t.external_transaction_id, t.idempotency_key, t.payload_hash, t.round_id, t.game_id,
  t.money_cents::text as money_cents, t.currency, t.reference_external_transaction_id,
  t.reference_transaction_id, t.failure_code, t.created_at, t.processed_at`;

interface TransactionRow {
  id: string;
  wallet_id: string;
  player_id: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  provider_id: string | null;
  external_transaction_id: string | null;
  idempotency_key: string | null;
  payload_hash: string | null;
  round_id: string | null;
  game_id: string | null;
  money_cents: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  failure_code: string | null;
  created_at: Date | string;
  processed_at: Date | string | null;
}

/** Reidrata sem revalidar transições (§6.0). */
function toTransaction(row: TransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    playerId: row.player_id,
    kind: row.kind,
    status: row.status,
    providerId: row.provider_id ?? undefined,
    externalTransactionId: row.external_transaction_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    payloadHash: row.payload_hash ?? undefined,
    roundId: row.round_id ?? undefined,
    gameId: row.game_id ?? undefined,
    money: Money.fromCents(BigInt(row.money_cents), row.currency),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: row.failure_code ?? undefined,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at === null ? undefined : new Date(row.processed_at),
  });
}

/**
 * Transação resolvida por `(providerId, externalTransactionId)` (§7, regra 2; única pelo `UNIQUE`)
 * e se ela já foi revertida por uma transação `PROCESSED` do tipo da consulta (regra 4). Só uma
 * reversão aplicada grava `reference_transaction_id`; o índice único parcial é a garantia final.
 */
async function findReferenceIn(
  em: EntityManager,
  query: ReferenceQuery,
): Promise<ResolvedReference | null> {
  const [row] = (await em.getConnection().execute(
    `select ${TRANSACTION_COLUMNS},
            exists (select 1 from wager_transactions r
                     where r.reference_transaction_id = t.id and r.kind = ?
                       and r.status = 'PROCESSED') as already_reversed
       from wager_transactions t
      where t.provider_id = ? and t.external_transaction_id = ?`,
    [query.reversalKind, query.providerId, query.externalTransactionId],
    'all',
    em.getTransactionContext(),
  )) as (TransactionRow & { already_reversed: boolean })[];
  if (row === undefined) return null;
  return { transaction: toTransaction(row), alreadyReversed: row.already_reversed };
}

function toStored(row: SubmissionRow): StoredSubmission {
  return {
    transactionId: row.id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    status: row.status,
    failureCode: row.failure_code ?? undefined,
    // Texto do PostgreSQL convertido direto para bigint, sem passar por number.
    resultBalance: Money.fromCents(BigInt(row.result_balance), row.wallet_currency),
  };
}
