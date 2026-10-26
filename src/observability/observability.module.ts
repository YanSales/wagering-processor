import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { HealthController } from '../health/health.controller';
import { MetricsController } from './metrics.controller';
import { createObservedDependencies, ObservedDependencies } from './observed-dependencies';

/** Health checks (§9 e §12) e métricas (§12). */
@Module({
  controllers: [HealthController, MetricsController],
  providers: [
    {
      provide: ObservedDependencies,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => createObservedDependencies(orm),
    },
  ],
})
export class ObservabilityModule {}
