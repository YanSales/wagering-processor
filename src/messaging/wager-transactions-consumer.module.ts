import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { HandleWagerTransactionMessage } from '../application/inbox/handle-wager-transaction-message';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import { MikroOrmInboxRepository } from '../database/repositories/inbox.repository';
import { WageringModule } from '../wagering/wagering.module';
import { createSqsClient, readSqsSettings } from './sqs.config';
import { WagerTransactionsConsumer } from './wager-transactions.consumer';
import { readWagerTransactionsConsumerSettings } from './wager-transactions-consumer.config';

/**
 * Consumidor de `wager-transactions.fifo` (contrato §10). Desligado por padrão
 * (`WAGER_TRANSACTIONS_CONSUMER_ENABLED`): só quando ligado a configuração do SQS é lida e o
 * cliente é criado; desligado, o provider é `null` e nada é agendado.
 */
@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: WagerTransactionsConsumer,
      inject: [MikroORM, SubmitWagerTransaction],
      useFactory: (
        orm: MikroORM,
        submit: SubmitWagerTransaction,
      ): WagerTransactionsConsumer | null => {
        const settings = readWagerTransactionsConsumerSettings();
        if (!settings.enabled) return null;
        const client = createSqsClient(readSqsSettings());
        const handler = new HandleWagerTransactionMessage(submit, new MikroOrmInboxRepository(orm));
        return new WagerTransactionsConsumer(client, handler, settings, undefined, () =>
          client.destroy(),
        );
      },
    },
  ],
})
export class WagerTransactionsConsumerModule {}
