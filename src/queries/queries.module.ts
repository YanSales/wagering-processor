import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { QUERY_REPOSITORY, type QueryRepository, ReconcileWallet } from '../application/queries';
import { MikroOrmQueryRepository } from '../database/repositories/query.repository';
import {
  ProviderTransactionsController,
  TransactionQueriesController,
  WalletQueriesController,
} from './queries.controller';

/** Consultas de wallet, ledger e transações e a reconciliação (contrato §9). */
@Module({
  controllers: [
    WalletQueriesController,
    TransactionQueriesController,
    ProviderTransactionsController,
  ],
  providers: [
    {
      provide: QUERY_REPOSITORY,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): QueryRepository => new MikroOrmQueryRepository(orm),
    },
    {
      provide: ReconcileWallet,
      inject: [QUERY_REPOSITORY],
      useFactory: (queries: QueryRepository) => new ReconcileWallet(queries),
    },
  ],
})
export class QueriesModule {}
