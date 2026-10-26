import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { PublishOutbox, PublishOutboxSummary } from '../application/outbox/publish-outbox';

/** Só o necessário de um logger, para testes. */
export type PublisherLogger = Pick<Logger, 'log' | 'warn' | 'error'>;

/**
 * Agenda as rodadas de `PublishOutbox` nesta instância (worker do §11), no mesmo modelo do worker de
 * `PENDING_REFERENCE`: uma rodada por vez, a próxima `pollIntervalMs` depois do fim da anterior, sem
 * estado em memória (reservas, tentativas e marcações ficam no PostgreSQL). Várias instâncias podem
 * publicar juntas; a exclusão por wallet está no banco.
 *
 * Sem `publisher` (desligado na configuração), não agenda nada. No shutdown, não agenda novas rodadas,
 * espera a rodada em andamento (limitada pela reserva) e libera o cliente do broker.
 */
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(
    private readonly publisher: PublishOutbox | null,
    private readonly pollIntervalMs: number,
    private readonly logger: PublisherLogger = new Logger('OutboxPublisher'),
    private readonly dispose: () => void = () => undefined,
  ) {}

  onApplicationBootstrap(): void {
    if (this.publisher !== null) this.#schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
    this.dispose();
  }

  /** Executa uma rodada agora. Nunca rejeita: falhas são registradas e a próxima rodada tenta de novo. */
  runOnce(): Promise<void> {
    if (this.publisher === null) return Promise.resolve();
    const run = this.publisher
      .runOnce()
      .then(
        (summary) => this.#report(summary),
        (error: unknown) =>
          this.logger.error(
            JSON.stringify({
              event: 'outbox_publish_round_failed',
              error: error instanceof Error ? error.name : 'unknown',
            }),
          ),
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
        this.#schedule();
      }
    }, this.pollIntervalMs);
  }

  #report(summary: PublishOutboxSummary): void {
    // Só contagens (§12): nada de payloads nem valores.
    if (summary.claimed === 0) return;
    const message = JSON.stringify({ event: 'outbox_publish_round', ...summary });
    if (summary.failed > 0 || summary.leaseLost > 0) this.logger.warn(message);
    else this.logger.log(message);
  }
}
