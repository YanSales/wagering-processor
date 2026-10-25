/**
 * Value Object monetário: quantia inteira em centavos (`bigint`, com sinal) e moeda ISO-4217.
 *
 * - Imutável: toda operação retorna uma nova instância.
 * - Exato: só aritmética de `bigint`; nunca passa por `number`.
 * - Multi-moeda (contrato §6.1): operações entre moedas diferentes lançam `CurrencyMismatchError`.
 * - Aceita valores negativos. Rejeitar negativos em entradas e impedir saldo negativo são regras
 *   da borda (contratos de entrada) e da carteira, não deste tipo.
 * - "Centavos" são a unidade de escala fixa 2 exigida pelo contrato para todas as moedas.
 */
export class Money {
  readonly #cents: bigint;
  readonly #currency: string;

  private constructor(cents: bigint, currency: string) {
    this.#cents = cents;
    this.#currency = currency;
    Object.freeze(this);
  }

  static fromCents(cents: bigint, currency: string): Money {
    if (typeof cents !== 'bigint') {
      throw new TypeError(`Money exige centavos em bigint; recebido ${typeof cents}.`);
    }
    return new Money(cents, assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return Money.fromCents(0n, currency);
  }

  get cents(): bigint {
    return this.#cents;
  }

  get currency(): string {
    return this.#currency;
  }

  add(other: Money): Money {
    return new Money(this.#cents + this.#sameCurrency(other, 'somar').#cents, this.#currency);
  }

  subtract(other: Money): Money {
    return new Money(this.#cents - this.#sameCurrency(other, 'subtrair').#cents, this.#currency);
  }

  /** Igualdade por valor: mesma moeda e mesma quantia. Moedas diferentes nunca são iguais. */
  equals(other: Money): boolean {
    assertMoney(other);
    return this.#currency === other.#currency && this.#cents === other.#cents;
  }

  /** -1, 0 ou 1. Comparar moedas diferentes não tem significado e lança `CurrencyMismatchError`. */
  compareTo(other: Money): -1 | 0 | 1 {
    const { cents } = this.#sameCurrency(other, 'comparar');
    if (this.#cents === cents) {
      return 0;
    }
    return this.#cents < cents ? -1 : 1;
  }

  isZero(): boolean {
    return this.#cents === 0n;
  }

  isNegative(): boolean {
    return this.#cents < 0n;
  }

  /** Bloqueia coerções implícitas (`money + 1`, `a < b`, template strings), que seriam silenciosas. */
  [Symbol.toPrimitive](): never {
    throw new TypeError('Money não pode ser convertido implicitamente; use cents/currency.');
  }

  /** Eventos e respostas carregam uma representação explícita, nunca a instância (contrato §11). */
  toJSON(): never {
    throw new TypeError(
      'Money não é serializável diretamente; converta para a representação do contrato.',
    );
  }

  #sameCurrency(other: Money, operation: string): Money {
    assertMoney(other);
    if (other.#currency !== this.#currency) {
      throw new CurrencyMismatchError(operation, this.#currency, other.#currency);
    }
    return other;
  }
}

/** Erro de domínio: operação entre quantias de moedas diferentes. */
export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';

  constructor(operation: string, left: string, right: string) {
    super(`Não é possível ${operation} Money em ${left} com Money em ${right}.`);
  }
}

// Formato do código ISO-4217 (três letras maiúsculas). Não restringe a uma lista de moedas.
const CURRENCY_CODE = /^[A-Z]{3}$/;

function assertCurrency(currency: string): string {
  if (typeof currency !== 'string') {
    throw new TypeError(`Money exige a moeda como string; recebido ${typeof currency}.`);
  }
  if (!CURRENCY_CODE.test(currency)) {
    throw new RangeError(`Moeda inválida: "${currency}". Use um código ISO-4217, ex.: "BRL".`);
  }
  return currency;
}

function assertMoney(value: Money): void {
  if (!(value instanceof Money)) {
    throw new TypeError('A operação exige outra instância de Money.');
  }
}
