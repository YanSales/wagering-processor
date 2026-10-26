/**
 * Métricas em processo (contrato §12) no formato texto do Prometheus, sem dependências externas.
 *
 * Os rótulos têm conjuntos fechados de valores (canal, componente, motivo, status): nunca wallet,
 * jogador, transação ou mensagem, para que a cardinalidade não cresça com o tráfego. Contadores e
 * histogramas valem por instância desde o início do processo (convenção do Prometheus); as métricas
 * de estado compartilhado (transações por status, atraso da outbox) são lidas do banco a cada coleta.
 */

type Labels = Readonly<Record<string, string>>;

const key = (labels: Labels) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
    .join(',');

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function sample(name: string, labels: string, value: number): string {
  return `${name}${labels === '' ? '' : `{${labels}}`} ${value}`;
}

export class Counter<L extends Labels = Labels> {
  readonly #values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: L = {} as L, by = 1): void {
    const k = key(labels);
    this.#values.set(k, (this.#values.get(k) ?? 0) + by);
  }

  get(labels: L = {} as L): number {
    return this.#values.get(key(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [labels, value] of this.#values) lines.push(sample(this.name, labels, value));
    return lines;
  }
}

/** Histograma com buckets cumulativos fixos, em segundos. */
export class Histogram<L extends Labels = Labels> {
  readonly #series = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {}

  observe(labels: L, seconds: number): void {
    const k = key(labels);
    let series = this.#series.get(k);
    if (series === undefined) {
      series = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.#series.set(k, series);
    }
    this.bounds.forEach((bound, i) => {
      if (seconds <= bound) (series.buckets[i] as number) += 1;
    });
    series.sum += seconds;
    series.count += 1;
  }

  count(labels: L): number {
    return this.#series.get(key(labels))?.count ?? 0;
  }

  /** Mede `operation` (inclusive quando ela lança). */
  async time<T>(labels: L, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      this.observe(labels, (performance.now() - started) / 1_000);
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [labels, series] of this.#series) {
      const prefix = labels === '' ? '' : `${labels},`;
      this.bounds.forEach((bound, i) => {
        lines.push(sample(`${this.name}_bucket`, `${prefix}le="${bound}"`, series.buckets[i] ?? 0));
      });
      lines.push(sample(`${this.name}_bucket`, `${prefix}le="+Inf"`, series.count));
      lines.push(sample(`${this.name}_sum`, labels, series.sum));
      lines.push(sample(`${this.name}_count`, labels, series.count));
    }
    return lines;
  }
}

/** Gauge calculado no momento da coleta (ex.: lido do banco). */
export interface GaugeSample {
  labels?: Labels;
  value: number;
}

export function renderGauge(name: string, help: string, samples: readonly GaugeSample[]): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} gauge`,
    ...samples.map((s) => sample(name, key(s.labels ?? {}), s.value)),
  ];
}

export type Channel = 'http' | 'sqs';

/** Métricas da aplicação. Uma instância por processo, compartilhada pelos pontos instrumentados. */
export const metrics = {
  duplicates: new Counter<{ channel: Channel; type: 'idempotency_replay' | 'inbox' }>(
    'wagering_duplicates_total',
    'Submissoes duplicadas detectadas, sem novo efeito financeiro.',
  ),
  retries: new Counter<{ component: 'sqs_consumer' | 'outbox_publisher' | 'pending_reference' }>(
    'wagering_retries_total',
    'Novas tentativas agendadas apos falha ou referencia ausente.',
  ),
  deadLettered: new Counter<{ reason: string }>(
    'wagering_dlq_messages_total',
    'Mensagens enviadas a DLQ pelo consumidor (reason com valores fixos).',
  ),
  lockConflicts: new Counter(
    'wagering_lock_conflicts_total',
    'Falhas por conflito de lock no PostgreSQL (deadlock, serializacao, lock indisponivel).',
  ),
  processingDuration: new Histogram<{ channel: Channel }>(
    'wagering_processing_duration_seconds',
    'Latencia do processamento de uma submissao, da entrada ate a resposta ou decisao.',
  ),
};
