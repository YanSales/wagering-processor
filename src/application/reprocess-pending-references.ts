import { randomUUID } from 'node:crypto';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { DEFAULT_REFERENCE_RETRY, ReferenceRetryPolicy } from './reference-retry-policy';
import { decideRefund, decideRollback } from './refund-decision';
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
  /** Falhas inesperadas (operacionais): tentativa desfeita; relatadas a `onError`. */
  failures: number;
  /** Falhas operacionais postas em quarentena (próxima tentativa adiada com backoff). */
  deferred: number;
  /** Adiamentos que não puderam ser gravados: a transação continua vencida; relatados a `onError`. */
  deferFailures: number;
}

/** Etapa de uma falha relatada: a tentativa de resolução ou o adiamento que a seguiu. */
export type ReprocessFailureStage = 'attempt' | 'defer';

export interface ReprocessOptions {
  batchSize: number;
  now?: () => Date;
  newId?: () => string;
  policy?: ReferenceRetryPolicy;
  /** Recebe cada falha inesperada e cada falha de adiamento; a rodada continua com as demais. */
  onError?: (task: PendingReferenceTask, error: unknown, stage: ReprocessFailureStage) => void;
}

/**
 * Uma rodada do worker agendado do contrato §7.1: tenta resolver as transações `PENDING_REFERENCE`
 * vencidas, uma transação SQL por item.
 *
 * Cada tentativa conta uma vez e reaplica a regra da submissão (`decideRefund` ou `decideRollback`): referência válida →
 * `PROCESSED` com crédito; existente, mas inválida → `REJECTED`; ainda ausente → nova tentativa com
 * backoff exponencial ou, esgotado o limite, `REJECTED` com `REFERENCE_NOT_FOUND`.
 *
 * Seguro com várias instâncias: a persistência trava a wallet e relê o estado antes de decidir, então
 * uma transação é concluída uma única vez. Falha transitória não consome tentativa nem rejeita.
 *
 * Falha operacional (nem transitória nem de negócio: defeito, valor fora do armazenamento): a
 * tentativa é desfeita e, depois do rollback, a transação entra em quarentena — próxima tentativa
 * adiada com o mesmo backoff exponencial e teto da política, sem consumir tentativa de resolução e
 * sem limite de ocorrências. Ela nunca vira `REFERENCE_NOT_FOUND` por falhar, nem `FAILED` (política
 * terminal ainda não decidida), e deixa de ocupar as rodadas seguintes enquanto adiada.
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
      deferred: 0,
      deferFailures: 0,
    };

    for (const task of tasks) {
      const at = this.#now();
      try {
        let decided: SubmissionDecision | undefined;
        const ledgerEntryId = this.#newId();
        const resolved = await this.pending.resolvePendingReference(task, at, (state) => {
          const decide =
            state.transaction.kind === WagerTransactionKind.Refund
              ? decideRefund
              : state.transaction.kind === WagerTransactionKind.Rollback
                ? decideRollback
                : undefined;
          if (decide === undefined) {
            throw new Error(
              `${state.transaction.kind} em PENDING_REFERENCE não tem reprocessamento implementado.`,
            );
          }
          decided = decide({
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
          // Sem quarentena: a causa é do ambiente, não da transação; volta na próxima rodada.
          summary.transientFailures += 1;
        } else {
          summary.failures += 1;
          this.options.onError?.(task, error, 'attempt');
          await this.#defer(task, at, summary);
        }
      }
    }
    return summary;
  }

  #defer(task: PendingReferenceTask, at: Date, summary: ReprocessSummary): Promise<void> {
    return deferAfterFailure(this.pending, this.#policy, task, at, summary, this.options.onError);
  }
}

/**
 * Quarentena depois do rollback da tentativa (a transação que falhou já foi desfeita). Uma falha aqui
 * só é relatada: a transação continua vencida e volta na próxima rodada, e as demais seguem.
 */
async function deferAfterFailure(
  pending: PendingReferenceRepository,
  policy: ReferenceRetryPolicy,
  task: PendingReferenceTask,
  at: Date,
  summary: ReprocessSummary,
  onError: ReprocessOptions['onError'],
): Promise<void> {
  try {
    const deferred = await pending.deferAfterFailure(task, at, (previousFailures) =>
      policy.nextAttemptAfterFailure(previousFailures, at),
    );
    if (deferred) summary.deferred += 1;
  } catch (error) {
    summary.deferFailures += 1;
    onError?.(task, error, 'defer');
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
