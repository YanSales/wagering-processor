import { describe, expect, test } from 'bun:test';
import { Counter, Histogram, renderGauge } from '../../src/observability/metrics';
import { MetricsController } from '../../src/observability/metrics.controller';
import { createObservedDependencies } from '../../src/observability/observed-dependencies';
import { checkReadiness, type DependencyCheck } from '../../src/observability/readiness';

const check = (name: string, run: () => Promise<boolean>): DependencyCheck => ({
  name,
  check: run,
});
const fakeOrm = { checkConnection: async () => ({ ok: true }) } as never;

describe('métricas no formato Prometheus', () => {
  test('contador com rótulos ordenados e escapados', () => {
    const counter = new Counter<{ reason: string; channel: string }>('x_total', 'ajuda');
    counter.inc({ reason: 'A"B', channel: 'sqs' });
    counter.inc({ channel: 'sqs', reason: 'A"B' }, 2);

    expect(counter.render()).toEqual([
      '# HELP x_total ajuda',
      '# TYPE x_total counter',
      'x_total{channel="sqs",reason="A\\"B"} 3',
    ]);
  });

  test('histograma cumulativo com +Inf, soma e contagem', () => {
    const histogram = new Histogram<{ channel: string }>('d_seconds', 'ajuda', [0.1, 1]);
    histogram.observe({ channel: 'http' }, 0.05);
    histogram.observe({ channel: 'http' }, 0.5);
    histogram.observe({ channel: 'http' }, 5);

    expect(histogram.render().slice(2)).toEqual([
      'd_seconds_bucket{channel="http",le="0.1"} 1',
      'd_seconds_bucket{channel="http",le="1"} 2',
      'd_seconds_bucket{channel="http",le="+Inf"} 3',
      'd_seconds_sum{channel="http"} 5.55',
      'd_seconds_count{channel="http"} 3',
    ]);
  });

  test('time() mede também quando a operação falha', async () => {
    const histogram = new Histogram<{ channel: string }>('d_seconds', 'ajuda');
    await histogram.time({ channel: 'sqs' }, async () => 1);
    await histogram
      .time({ channel: 'sqs' }, async () => Promise.reject(new Error('x')))
      .catch(() => undefined);

    expect(histogram.count({ channel: 'sqs' })).toBe(2);
  });

  test('gauge sem rótulos', () => {
    expect(renderGauge('g', 'ajuda', [{ value: 4 }]).at(-1)).toBe('g 4');
  });
});

describe('GET /metrics com o banco falhando', () => {
  test('responde, marca a fonte como fora e omite os gauges do banco, sem detalhes do erro', async () => {
    const failingOrm = {
      em: {
        getConnection: () => ({
          execute: async () => {
            throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret');
          },
        }),
      },
    } as never;
    const controller = new MetricsController(failingOrm, createObservedDependencies(fakeOrm, {}));

    const text = await controller.scrape();

    expect(text).toContain('wagering_metrics_source_up{source="postgres"} 0');
    expect(text).not.toContain('wagering_transactions{');
    expect(text).not.toContain('wagering_outbox_lag_seconds');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('10.0.0.5');
    // Os contadores em processo continuam disponíveis.
    expect(text).toContain('# TYPE wagering_processing_duration_seconds histogram');
  });
});

describe('readiness', () => {
  test('todas as dependências respondem: pronto', async () => {
    const report = await checkReadiness([check('postgres', async () => true)], ['sqs']);

    expect(report).toEqual({ ready: true, checks: { postgres: 'up', sqs: 'disabled' } });
  });

  test('falha ou timeout: down, sem o motivo no relatório', async () => {
    const report = await checkReadiness(
      [
        check('postgres', async () => {
          throw new Error('password authentication failed for user "secret"');
        }),
        check('sqs', () => new Promise<boolean>(() => undefined)),
      ],
      [],
      50,
    );

    expect(report).toEqual({ ready: false, checks: { postgres: 'down', sqs: 'down' } });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  test('publisher e consumidor desligados: o SQS não é configurado nem verificado', async () => {
    // Sem nenhuma variável do SQS no ambiente.
    const dependencies = createObservedDependencies(fakeOrm, {});

    expect(await dependencies.readiness()).toEqual({
      ready: true,
      checks: { postgres: 'up', sqs: 'disabled' },
    });
    expect(await dependencies.dlqDepth()).toBeNull();
  });

  test('com um recurso SQS ligado, a configuração do SQS passa a ser exigida', () => {
    expect(() => createObservedDependencies(fakeOrm, { OUTBOX_PUBLISHER_ENABLED: 'true' })).toThrow(
      'Variáveis de ambiente do SQS ausentes',
    );
  });
});
