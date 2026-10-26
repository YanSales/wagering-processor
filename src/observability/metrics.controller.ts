import { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { type GaugeSample, metrics, renderGauge } from './metrics';
import { ObservedDependencies } from './observed-dependencies';

/**
 * `GET /metrics` (contrato §12), formato texto do Prometheus. Sem autenticação, como os health checks:
 * expõe só contagens e durações, sem identificadores nem valores financeiros.
 *
 * - Contadores e histograma em processo: duplicatas, retries, envios à DLQ, conflitos de lock e
 *   latência, atualizados nos pontos que tomam essas decisões.
 * - Lidos a cada coleta, do estado compartilhado: transações por status, atraso e tamanho da outbox,
 *   locks aguardando no PostgreSQL e mensagens na DLQ de entrada (só com o consumidor habilitado).
 * - `wagering_metrics_source_up` indica se cada fonte respondeu; uma fonte fora omite os seus gauges,
 *   em vez de publicar zeros falsos.
 */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(ObservedDependencies) private readonly dependencies: ObservedDependencies,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    const lines: string[] = [];
    const sources: GaugeSample[] = [];

    try {
      lines.push(...(await this.#database()));
      sources.push({ labels: { source: 'postgres' }, value: 1 });
    } catch {
      sources.push({ labels: { source: 'postgres' }, value: 0 });
    }
    try {
      const dlq = await this.dependencies.dlqDepth();
      if (dlq !== null) {
        lines.push(
          ...renderGauge('wagering_dlq_messages', 'Mensagens na DLQ de entrada (aproximado).', [
            { labels: { queue: dlq.queue }, value: dlq.messages },
          ]),
        );
        sources.push({ labels: { source: 'sqs' }, value: 1 });
      }
    } catch {
      sources.push({ labels: { source: 'sqs' }, value: 0 });
    }

    lines.push(
      ...renderGauge(
        'wagering_metrics_source_up',
        'Fonte de metricas respondeu na coleta.',
        sources,
      ),
      ...metrics.duplicates.render(),
      ...metrics.retries.render(),
      ...metrics.deadLettered.render(),
      ...metrics.lockConflicts.render(),
      ...metrics.processingDuration.render(),
    );
    return `${lines.join('\n')}\n`;
  }

  async #database(): Promise<string[]> {
    const connection = this.orm.em.getConnection();
    const byStatus = (await connection.execute(
      'select status, count(*)::int as n from wager_transactions group by status',
    )) as { status: string; n: number }[];
    const [outbox] = (await connection.execute(
      `select count(*)::int as pending,
              coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag
         from outbox_messages where published_at is null`,
    )) as { pending: number; lag: number }[];
    const [locks] = (await connection.execute(
      `select count(*)::int as waiting from pg_locks l
         join pg_database d on d.oid = l.database
        where d.datname = current_database() and not l.granted`,
    )) as { waiting: number }[];

    const counts = new Map(byStatus.map((r) => [r.status, r.n]));
    return [
      ...renderGauge(
        'wagering_transactions',
        'Transacoes por status (todas as instancias, lido do banco).',
        Object.values(WagerTransactionStatus).map((status) => ({
          labels: { status },
          value: counts.get(status) ?? 0,
        })),
      ),
      ...renderGauge('wagering_outbox_pending_messages', 'Eventos ainda nao publicados.', [
        { value: outbox?.pending ?? 0 },
      ]),
      ...renderGauge(
        'wagering_outbox_lag_seconds',
        'Idade do evento mais antigo ainda nao publicado (0 sem pendentes).',
        [{ value: outbox?.lag ?? 0 }],
      ),
      ...renderGauge('wagering_lock_waits', 'Locks aguardando no banco da aplicacao agora.', [
        { value: locks?.waiting ?? 0 },
      ]),
    ];
  }
}
