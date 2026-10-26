/**
 * Envelope dos eventos de integração (contrato §11): classe abstrata, uma subclasse concreta por
 * evento, com `eventType` e `version` no tipo, não em strings soltas no call site.
 *
 * Os campos do envelope e o formato de `toJSON()` são os do README (§11). Os eventos são valores
 * imutáveis: não fazem I/O, não geram ids nem leem o relógio; quem os cria fornece tudo.
 */
export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  /** Opcional no contrato; omitido nesta etapa do projeto. */
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/**
 * Envelope serializado (o que será gravado no payload da outbox). `eventType` é o literal do evento:
 * numa união de envelopes, ele determina o tipo de `data`.
 */
export interface IntegrationEventEnvelope<TType extends string, TData> {
  eventId: string;
  eventType: TType;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601. */
  occurredAt: string;
  version: number;
  data: Readonly<TData>;
}

/** Ids e correlação de um evento; o instante vem da decisão de domínio que o origina. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
}

export abstract class IntegrationEvent<TType extends string, T> {
  abstract readonly eventType: TType;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  readonly #occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const name of ['eventId', 'aggregateId', 'correlationId'] as const) {
      assertText(name, props[name]);
    }
    if (props.causationId !== undefined) assertText('causationId', props.causationId);
    if (!(props.occurredAt instanceof Date) || Number.isNaN(props.occurredAt.getTime())) {
      throw new InvalidIntegrationEventError('occurredAt deve ser uma data válida.');
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.#occurredAt = new Date(props.occurredAt.getTime());
    // Cópia profunda congelada: o chamador não altera o evento depois de criado. `data` é sempre
    // montado pelas subclasses com `MoneyProps` (`Money.toProps()`), nunca com instâncias de `Money`.
    this.data = deepFreeze(structuredClone(props.data));
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt.getTime());
  }

  /** Envelope serializado gravado no payload da outbox (contrato §11). */
  toJSON(): IntegrationEventEnvelope<TType, T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.#occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data),
    };
  }
}

/** Evento montado com dados inválidos ou incompatíveis com a decisão: erro de programação. */
export class InvalidIntegrationEventError extends Error {
  override readonly name = 'InvalidIntegrationEventError';
}

function assertText(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidIntegrationEventError(`${name} deve ser um texto não vazio.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
