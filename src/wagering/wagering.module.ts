import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import type { WagerTransactionRepository } from '../application/wager-transaction-repository';
import { MikroOrmWagerTransactionRepository } from '../database/repositories/wager-transaction.repository';
import { WageringTransactionsController } from './wagering-transactions.controller';

/** Token da porta `WagerTransactionRepository` (interface, sem representação em runtime). */
export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');

/**
 * Submissão de transações pela API. Reutiliza o caso de uso `SubmitWagerTransaction` com o
 * repositório MikroORM; o `MikroORM` vem do `DatabaseModule` (o `MikroOrmModule` é global).
 */
@Module({
  controllers: [WageringTransactionsController],
  providers: [
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): WagerTransactionRepository =>
        new MikroOrmWagerTransactionRepository(orm),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [WAGER_TRANSACTION_REPOSITORY],
      useFactory: (transactions: WagerTransactionRepository): SubmitWagerTransaction =>
        new SubmitWagerTransaction(transactions, () => new Date(), randomUUID),
    },
  ],
})
export class WageringModule {}
