import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Logger, Module } from '@nestjs/common';
import { ReferenceRetryPolicy } from '../application/reference-retry-policy';
import { ReprocessPendingReferences } from '../application/reprocess-pending-references';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import type {
  PendingReferenceRepository,
  WagerTransactionRepository,
} from '../application/wager-transaction-repository';
import { MikroOrmWagerTransactionRepository } from '../database/repositories/wager-transaction.repository';
import {
  type PendingReferenceSettings,
  readPendingReferenceSettings,
} from './pending-reference.config';
import { PendingReferenceWorker } from './pending-reference.worker';
import { WageringTransactionsController } from './wagering-transactions.controller';

/** Token da porta `WagerTransactionRepository` (interface, sem representação em runtime). */
export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');
/** Token da porta `PendingReferenceRepository`, usada pelo worker do §7.1. */
export const PENDING_REFERENCE_REPOSITORY = Symbol('PENDING_REFERENCE_REPOSITORY');
/** Token da configuração do worker de `PENDING_REFERENCE`. */
export const PENDING_REFERENCE_SETTINGS = Symbol('PENDING_REFERENCE_SETTINGS');

/**
 * Submissão de transações pela API e o worker de `PENDING_REFERENCE` (§7.1). Os dois usam o
 * repositório MikroORM; o `MikroORM` vem do `DatabaseModule` (o `MikroOrmModule` é global). A
 * política de tentativas é a mesma na submissão (primeiro agendamento) e no worker.
 */
@Module({
  controllers: [WageringTransactionsController],
  providers: [
    { provide: PENDING_REFERENCE_SETTINGS, useFactory: readPendingReferenceSettings },
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): WagerTransactionRepository =>
        new MikroOrmWagerTransactionRepository(orm),
    },
    {
      provide: PENDING_REFERENCE_REPOSITORY,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): PendingReferenceRepository =>
        new MikroOrmWagerTransactionRepository(orm),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [WAGER_TRANSACTION_REPOSITORY, PENDING_REFERENCE_SETTINGS],
      useFactory: (
        transactions: WagerTransactionRepository,
        settings: PendingReferenceSettings,
      ): SubmitWagerTransaction =>
        new SubmitWagerTransaction(
          transactions,
          () => new Date(),
          randomUUID,
          ReferenceRetryPolicy.from(settings.retry),
        ),
    },
    {
      provide: ReprocessPendingReferences,
      inject: [PENDING_REFERENCE_REPOSITORY, PENDING_REFERENCE_SETTINGS],
      useFactory: (
        pending: PendingReferenceRepository,
        settings: PendingReferenceSettings,
      ): ReprocessPendingReferences => {
        const logger = new Logger('PendingReferenceWorker');
        return new ReprocessPendingReferences(pending, {
          batchSize: settings.batchSize,
          policy: ReferenceRetryPolicy.from(settings.retry),
          // Só identificadores e o tipo do erro (§12): nada de valores nem payloads.
          onError: (task, error) =>
            logger.error(
              JSON.stringify({
                event: 'pending_reference_attempt_failed',
                transactionId: task.transactionId,
                walletId: task.walletId,
                error: error instanceof Error ? error.name : 'unknown',
              }),
            ),
        });
      },
    },
    {
      provide: PendingReferenceWorker,
      inject: [ReprocessPendingReferences, PENDING_REFERENCE_SETTINGS],
      useFactory: (
        reprocess: ReprocessPendingReferences,
        settings: PendingReferenceSettings,
      ): PendingReferenceWorker => new PendingReferenceWorker(reprocess, settings),
    },
  ],
})
export class WageringModule {}
