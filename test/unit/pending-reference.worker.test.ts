import { describe, expect, test } from 'bun:test';
import type {
  ReprocessPendingReferences,
  ReprocessSummary,
} from '../../src/application/reprocess-pending-references';
import { TransientPersistenceError } from '../../src/application/wager-transaction-repository';
import {
  PendingReferenceWorker,
  type WorkerLogger,
} from '../../src/wagering/pending-reference.worker';

const EMPTY: ReprocessSummary = {
  due: 0,
  processed: 0,
  rejected: 0,
  rescheduled: 0,
  skipped: 0,
  transientFailures: 0,
  failures: 0,
};

/** Rodadas falsas: conta chamadas e devolve o que `next` produzir. */
function reprocessing(next: () => Promise<ReprocessSummary>) {
  const calls = { count: 0 };
  const reprocess = {
    runOnce: () => {
      calls.count += 1;
      return next();
    },
  } as unknown as ReprocessPendingReferences;
  return { reprocess, calls };
}

function recordingLogger() {
  const lines: { level: string; message: string }[] = [];
  const logger: WorkerLogger = {
    log: (message: string) => lines.push({ level: 'log', message }),
    warn: (message: string) => lines.push({ level: 'warn', message }),
    error: (message: string) => lines.push({ level: 'error', message }),
  };
  return { logger, lines };
}

describe('PendingReferenceWorker', () => {
  test('desligado: nenhuma rodada é agendada', async () => {
    const { reprocess, calls } = reprocessing(async () => EMPTY);
    const worker = new PendingReferenceWorker(reprocess, { enabled: false, pollIntervalMs: 1 });

    worker.onApplicationBootstrap();
    await Bun.sleep(20);
    await worker.onApplicationShutdown();

    expect(calls.count).toBe(0);
  });

  test('ligado: rodadas em sequência, sem sobreposição; o shutdown interrompe o agendamento', async () => {
    let active = 0;
    let maxActive = 0;
    const { reprocess, calls } = reprocessing(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(5);
      active -= 1;
      return EMPTY;
    });
    const worker = new PendingReferenceWorker(reprocess, { enabled: true, pollIntervalMs: 1 });

    worker.onApplicationBootstrap();
    await Bun.sleep(80);
    await worker.onApplicationShutdown();
    const afterShutdown = calls.count;
    await Bun.sleep(30);

    expect(afterShutdown).toBeGreaterThan(1);
    expect(maxActive).toBe(1);
    expect(calls.count).toBe(afterShutdown);
  });

  test('o shutdown espera a rodada em andamento terminar', async () => {
    let finished = false;
    const { reprocess } = reprocessing(async () => {
      await Bun.sleep(30);
      finished = true;
      return EMPTY;
    });
    const worker = new PendingReferenceWorker(reprocess, { enabled: false, pollIntervalMs: 1 });

    void worker.runOnce();
    await worker.onApplicationShutdown();

    expect(finished).toBe(true);
  });

  test('falha da rodada não rejeita: transitória vira warn, outra vira error, sem detalhes', async () => {
    const { logger, lines } = recordingLogger();
    const failures = [
      new TransientPersistenceError({ cause: new Error('host=10.0.0.5 password=segredo') }),
      new Error('select * from wallets'),
    ];
    const { reprocess } = reprocessing(async () => {
      throw failures.shift();
    });
    const worker = new PendingReferenceWorker(
      reprocess,
      { enabled: false, pollIntervalMs: 1 },
      logger,
    );

    await worker.runOnce();
    await worker.runOnce();

    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
    expect(lines.map((l) => JSON.parse(l.message))).toEqual([
      {
        event: 'pending_reference_round_failed',
        transient: true,
        error: 'TransientPersistenceError',
      },
      { event: 'pending_reference_round_failed', transient: false, error: 'Error' },
    ]);
    expect(lines.some((l) => l.message.includes('segredo'))).toBe(false);
  });

  test('logger que lança não interrompe o agendamento nem faz runOnce rejeitar', async () => {
    const throwing: WorkerLogger = {
      log: () => {
        throw new Error('log indisponível');
      },
      warn: () => {
        throw new Error('log indisponível');
      },
      error: () => {
        throw new Error('log indisponível');
      },
    };
    let round = 0;
    const { reprocess, calls } = reprocessing(async () => {
      round += 1;
      if (round % 2 === 0) throw new Error('falha da rodada');
      return { ...EMPTY, due: 1, processed: 1 };
    });
    const worker = new PendingReferenceWorker(
      reprocess,
      { enabled: true, pollIntervalMs: 1 },
      throwing,
    );

    await expect(worker.runOnce()).resolves.toBeUndefined();
    worker.onApplicationBootstrap();
    await Bun.sleep(60);
    await worker.onApplicationShutdown();

    // Rodadas com sucesso e com falha, ambas com log falhando, e o agendamento seguiu.
    expect(calls.count).toBeGreaterThan(3);
  });

  test('log da rodada: só contagens, e só quando havia algo vencido', async () => {
    const { logger, lines } = recordingLogger();
    const results = [EMPTY, { ...EMPTY, due: 2, processed: 1, rescheduled: 1 }];
    const { reprocess } = reprocessing(async () => results.shift() ?? EMPTY);
    const worker = new PendingReferenceWorker(
      reprocess,
      { enabled: false, pollIntervalMs: 1 },
      logger,
    );

    await worker.runOnce();
    await worker.runOnce();

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('log');
    expect(JSON.parse(lines[0]?.message ?? '')).toEqual({
      event: 'pending_reference_round',
      ...EMPTY,
      due: 2,
      processed: 1,
      rescheduled: 1,
    });
  });
});
