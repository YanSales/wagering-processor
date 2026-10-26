import { randomUUID } from 'node:crypto';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { DEFAULT_REFERENCE_RETRY, ReferenceRetryPolicy } from './reference-retry-policy';
import { decideRefund } from './refund-decision';
import {
  type PendingReferenceRepository,
  type PendingReferenceTask,
  type SubmissionDecision,
  TransientPersistenceError,
} from './wager-transaction-repository';

/** Contagem de uma rodada do worker, para log e métricas. */
export interface ReprocessSummary {
  /** Transações vencidas encontradas. */
  due: number;
  processed: number;
  rejected: number;
  rescheduled: number;
  /** Resolvidas por outro worker entre a busca e o lock. */
  skipped: number;
  /** Falhas transitórias: nada gravado, tentativa não consumida; voltam na próxima rodada. */
  transientFailures: number;
  /** Falhas inesperadas: nada gravado; relatadas a `onError`. */
  failures: number;
}

export interface ReprocessOptions {
  batchSize: number;
  now?: () => Date;
  newId?: () => string;
  policy?: ReferenceRetryPolicy;
  /** Recebe cada falha inesperada (a rodada continua com as demais transações). */
  onError?: (task: PendingReferenceTask, error: unknown) => void;
}

/**
 * Uma rodada do worker agendado do contrato §7.1: tenta resolver as transações `PENDING_REFERENCE`
 * vencidas, uma transação SQL por item.
 *
 * Cada tentativa conta uma vez e reaplica a regra da submissão (`decideRefund`): referência válida →
 * `PROCESSED` com crédito; existente, mas inválida → `REJECTED`; ainda ausente → nova tentativa com
 * backoff exponencial ou, esgotado o limite, `REJECTED` com `REFERENCE_NOT_FOUND`.
 *
 * Seguro com várias instâncias: a persistência trava a wallet e relê o estado antes de decidir, então
 * uma transação é concluída uma única vez. Falha transitória não consome tentativa nem rejeita.
 */
export class ReprocessPendingReferences {
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #policy: ReferenceRetryPolicy;

  constructor(
    private readonly pending: PendingReferenceRepository,
    private readonly options: ReprocessOptions,
  ) {
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
      throw new RangeError(
        `batchSize deve ser um inteiro positivo; recebido ${options.batchSize}.`,
      );
    }
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#policy = options.policy ?? ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);
  }

  /** Processa um lote. Falha transitória na busca sobe como `TransientPersistenceError`. */
  async runOnce(): Promise<ReprocessSummary> {
    const tasks = await this.pending.findDuePendingReferences(this.#now(), this.options.batchSize);
    const summary: ReprocessSummary = {
      due: tasks.length,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
      transientFailures: 0,
      failures: 0,
    };

    for (const task of tasks) {
      try {
        let decided: SubmissionDecision | undefined;
        const at = this.#now();
        const ledgerEntryId = this.#newId();
        const resolved = await this.pending.resolvePendingReference(task, at, (state) => {
          if (state.transaction.kind !== WagerTransactionKind.Refund) {
            throw new Error(
              `${state.transaction.kind} em PENDING_REFERENCE não tem reprocessamento implementado.`,
            );
          }
          decided = decideRefund({
            transaction: state.transaction,
            wallet: state.wallet,
            reference: state.reference,
            attempts: state.completedAttempts + 1,
            ledgerEntryId,
            at,
            policy: this.#policy,
          });
          return decided;
        });
        if (!resolved || decided === undefined) {
          summary.skipped += 1;
        } else {
          count(summary, decided);
        }
      } catch (error) {
        if (error instanceof TransientPersistenceError) {
          summary.transientFailures += 1;
        } else {
          summary.failures += 1;
          this.options.onError?.(task, error);
        }
      }
    }
    return summary;
  }
}

function count(summary: ReprocessSummary, decision: SubmissionDecision): void {
  switch (decision.transaction.status) {
    case WagerTransactionStatus.Processed:
      summary.processed += 1;
      return;
    case WagerTransactionStatus.Rejected:
      summary.rejected += 1;
      return;
    default:
      summary.rescheduled += 1;
  }
}
