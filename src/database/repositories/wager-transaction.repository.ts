import {
  DeadlockException,
  type EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  type ExistingSubmissions,
  type StoredSubmission,
  type SubmissionDecision,
  type SubmissionKeys,
  type SubmissionOutcome,
  TransientPersistenceError,
  type WagerTransactionRepository,
  WalletNotFoundError,
} from '../../application/wager-transaction-repository';
import { Money } from '../../domain/money';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
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
 */
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly orm: MikroORM) {}

  findExisting(keys: SubmissionKeys): Promise<ExistingSubmissions> {
    return classifyFailures(() => findExistingIn(this.orm.em.fork(), keys));
  }

  applyToLockedWallet(
    walletId: string,
    keys: SubmissionKeys,
    decide: (wallet: Wallet) => SubmissionDecision,
  ): Promise<SubmissionOutcome> {
    return classifyFailures(() => this.#applyToLockedWallet(walletId, keys, decide));
  }

  async #applyToLockedWallet(
    walletId: string,
    keys: SubmissionKeys,
    decide: (wallet: Wallet) => SubmissionDecision,
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

        const decision = decide(toWallet(row));
        const { transaction, wallet, ledgerEntry } = assertDecision(decision, row);
        assertStorable(transaction.money);
        assertStorable(wallet.balance);

        em.create(WagerTransactionRecord, toTransactionRecord(transaction, row, wallet.balance));
        await em.flush();

        if (ledgerEntry !== null) {
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
            throw new Error(
              `A wallet ${row.id} mudou durante a transação (versão ${row.version}).`,
            );
          }
          await insertLedgerEntry(em, ledgerEntry);
        }

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

/** Garante que a decisão diz respeito à wallet travada e está pronta para gravar. */
function assertDecision(decision: SubmissionDecision, row: WalletRecord): SubmissionDecision {
  const { transaction, wallet, ledgerEntry } = decision;
  if (wallet.id !== row.id || transaction.walletId !== row.id) {
    throw new Error(`A decisão não se refere à wallet travada ${row.id}.`);
  }
  if (!transaction.isTerminal() || transaction.status === WagerTransactionStatus.Failed) {
    throw new Error(`A decisão precisa ser PROCESSED ou REJECTED; recebido ${transaction.status}.`);
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
