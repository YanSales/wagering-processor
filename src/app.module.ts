import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { WageringModule } from './wagering/wagering.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [AuthModule, DatabaseModule, WalletsModule, WageringModule],
  controllers: [HealthController],
})
export class AppModule {}
