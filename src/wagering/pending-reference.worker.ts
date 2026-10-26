import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type {
  ReprocessPendingReferences,
  ReprocessSummary,
} from '../application/reprocess-pending-references';
import { TransientPersistenceError } from '../application/wager-transaction-repository';

/** Só o necessário de um logger, para testes. */
export type WorkerLogger = Pick<Logger, 'log' | 'warn' | 'error'>;

/**
 * Agenda as rodadas de `ReprocessPendingReferences` nesta instância (worker agendado do §7.1).
 *
 * - Uma rodada por vez: a próxima é agendada `pollIntervalMs` depois do fim da anterior, sem
 *   sobreposição nem acúmulo de chamadas. Cada rodada processa no máximo `batchSize` transações.
 * - Várias instâncias podem rodar juntas: a exclusão mútua está no banco, não aqui.
 * - Nenhum estado em memória: pendências, tentativas e próximas datas ficam no PostgreSQL, e uma
 *   instância reiniciada continua de onde parou.
 * - No shutdown, não agenda novas rodadas e espera a rodada em andamento terminar (cada item é uma
 *   transação SQL; interrompê-lo apenas o desfaria).
 */
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(
    private readonly reprocess: ReprocessPendingReferences,
    private readonly settings: { enabled: boolean; pollIntervalMs: number },
    private readonly logger: WorkerLogger = new Logger('PendingReferenceWorker'),
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.enabled) this.#schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /**
   * Executa uma rodada agora (também usada pelo agendamento). Nunca rejeita: uma falha do próprio
   * log é descartada, porque não há mais onde relatá-la, e não pode interromper o agendamento.
   */
  runOnce(): Promise<void> {
    const run = this.reprocess
      .runOnce()
      .then(
        (summary) => this.#report(summary),
        (error: unknown) => this.#reportFailure(error),
      )
      .catch(() => undefined);
    this.#running = run;
    return run;
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(async () => {
      this.#timer = undefined;
      try {
        await this.runOnce();
      } finally {
        // Agenda a próxima mesmo se algo escapar da rodada: o worker não pode parar em silêncio.
        this.#schedule();
      }
    }, this.settings.pollIntervalMs);
  }

  #report(summary: ReprocessSummary): void {
    // Sem valores monetários nem payloads: só contagens (§12).
    if (summary.due === 0) return;
    const message = JSON.stringify({ event: 'pending_reference_round', ...summary });
    if (summary.failures > 0 || summary.transientFailures > 0) this.logger.warn(message);
    else this.logger.log(message);
  }

  #reportFailure(error: unknown): void {
    const transient = error instanceof TransientPersistenceError;
    const message = JSON.stringify({
      event: 'pending_reference_round_failed',
      transient,
      error: error instanceof Error ? error.name : 'unknown',
    });
    if (transient) this.logger.warn(message);
    else this.logger.error(message);
  }
}
