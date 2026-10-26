import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { OutboxPublisherModule } from './messaging/outbox-publisher.module';
import { WagerTransactionsConsumerModule } from './messaging/wager-transactions-consumer.module';
import { ObservabilityModule } from './observability/observability.module';
import { WageringModule } from './wagering/wagering.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    WalletsModule,
    WageringModule,
    OutboxPublisherModule,
    WagerTransactionsConsumerModule,
    ObservabilityModule,
  ],
})
export class AppModule {}
