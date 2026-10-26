import { existsSync } from 'node:fs';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  HandleWagerTransactionMessage,
  type MessageDisposition,
  type WagerTransactionMessage,
} from '../../src/application/inbox/handle-wager-transaction-message';
import { PublishOutbox } from '../../src/application/outbox/publish-outbox';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import type { PendingReferenceRepository } from '../../src/application/wager-transaction-repository';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmInboxRepository } from '../../src/database/repositories/inbox.repository';
import { MikroOrmOutboxRepository } from '../../src/database/repositories/outbox.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { createSqsClient, readSqsSettings } from '../../src/messaging/sqs.config';
import { SqsEventPublisher } from '../../src/messaging/sqs-event-publisher';
import { WagerTransactionsConsumer } from '../../src/messaging/wager-transactions.consumer';
import { assertTestDatabaseEnv } from './test-database';
import { assertLocalSqsEndpoint } from './test-sqs';

/** Configuração de uma instância (argumento JSON). Filas efêmeras criadas pelo teste. */
export interface InstanceConfig {
  name: string;
  transactionsQueue: string;
  transactionsDlq: string;
  /** Fila de eventos; ausente, o publisher da outbox não roda nesta instância. */
  eventsQueue?: string;
  /** Wallets do teste: o worker de `PENDING_REFERENCE` só toca nelas (banco compartilhado). */
  walletIds: string[];
  maxMessages: number;
  /** Para depois do commit da N-ésima mensagem, antes do `DeleteMessage`, e espera ser morta. */
  crashAfterCommits?: number;
  /** A instância termina a rodada em curso e encerra quando este arquivo existir. */
  stopFile: string;
}

/** Contagens impressas em `RESULT` ao parar. */
export interface InstanceResult {
  name: string;
  pid: number;
  received: number;
  acked: number;
  retried: number;
  deadLettered: number;
  published: number;
  resolvedPending: number;
}

/**
 * Uma instância do serviço num processo próprio: seu MikroORM (pool), seu cliente SQS e os mesmos
 * componentes da aplicação — consumidor de `wager-transactions`, worker de `PENDING_REFERENCE` e
 * publisher da outbox —, sobre o PostgreSQL de teste e o emulador SQS compartilhados.
 *
 * Protocolo: conecta e imprime `READY`; espera a linha `GO` no stdin; roda em laço até existir o
 * arquivo `stopFile`, então imprime `RESULT <json>` e encerra. Com `crashAfterCommits`, imprime
 * `COMMITTED <messageId>` logo depois do commit daquela mensagem e fica parada (sem `ack`) até o
 * teste matá-la: a queda entre o commit e o `ack` do §13.
 */
if (import.meta.main) {
  assertTestDatabaseEnv();
  assertLocalSqsEndpoint();
  const config = JSON.parse(process.argv[2] ?? '{}') as InstanceConfig;
  const orm = await MikroORM.init(createOrmConfig());
  await orm.connect();
  const sqs = readSqsSettings({
    ...process.env,
    SQS_WAGER_EVENTS_QUEUE: config.eventsQueue ?? 'unused-events.fifo',
    SQS_WAGER_EVENTS_DLQ: 'unused-events-dlq.fifo',
  });
  const client = createSqsClient(sqs);
  const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

  const real = new HandleWagerTransactionMessage(
    new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm)),
    new MikroOrmInboxRepository(orm),
  );
  let commits = 0;
  const handler = {
    async handle(message: WagerTransactionMessage): Promise<MessageDisposition> {
      const disposition = await real.handle(message);
      if (disposition.action === 'ack' && config.crashAfterCommits !== undefined) {
        commits += 1;
        if (commits === config.crashAfterCommits) {
          // Commit feito; o `DeleteMessage` nunca acontece.
          console.log(`COMMITTED ${message.messageId}`);
          await new Promise(() => undefined);
        }
      }
      return disposition;
    },
  };
  const consumer = new WagerTransactionsConsumer(
    client,
    handler,
    {
      queueName: config.transactionsQueue,
      dlqName: config.transactionsDlq,
      waitTimeSeconds: 1,
      maxMessages: config.maxMessages,
      retryBaseSeconds: 0,
      retryMaxSeconds: 0,
    },
    silent,
  );

  const pendingRepository = new MikroOrmWagerTransactionRepository(orm);
  const scoped: PendingReferenceRepository = {
    async findDuePendingReferences(now, limit) {
      const due = await pendingRepository.findDuePendingReferences(now, 10_000);
      return due.filter((t) => config.walletIds.includes(t.walletId)).slice(0, limit);
    },
    resolvePendingReference: (task, now, decide) =>
      pendingRepository.resolvePendingReference(task, now, decide),
    deferAfterFailure: (task, now, next) => pendingRepository.deferAfterFailure(task, now, next),
  };
  const pending = new ReprocessPendingReferences(scoped, { batchSize: 50 });
  const publisher =
    config.eventsQueue === undefined
      ? undefined
      : new PublishOutbox(
          new MikroOrmOutboxRepository(orm),
          new SqsEventPublisher(client, config.eventsQueue, 5_000),
          { maxGroups: 200, maxPerGroup: 50, leaseMs: 30_000 },
        );

  const result: InstanceResult = {
    name: config.name,
    pid: process.pid,
    received: 0,
    acked: 0,
    retried: 0,
    deadLettered: 0,
    published: 0,
    resolvedPending: 0,
  };
  console.log('READY');
  for await (const line of console) {
    if (line.trim() === 'GO') break;
  }

  try {
    // Parada pelo arquivo-sinal: a leitura contínua do stdin em segundo plano não é confiável no Bun.
    while (!existsSync(config.stopFile)) {
      const summary = await consumer.pollOnce();
      result.received += summary.received;
      result.acked += summary.acked;
      result.retried += summary.retried;
      result.deadLettered += summary.deadLettered;
      const reprocessed = await pending.runOnce();
      result.resolvedPending += reprocessed.processed + reprocessed.rejected;
      if (publisher !== undefined) result.published += (await publisher.runOnce()).published;
    }
    console.log(`RESULT ${JSON.stringify(result)}`);
  } finally {
    client.destroy();
    await orm.close(true);
  }
}
