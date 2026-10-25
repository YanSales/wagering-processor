/**
 * Representação de `Money` nos contratos (API, mensagens, eventos):
 * `{ amount: "25.00", currency: "BRL" }`.
 */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/**
 * Value Object monetário: quantia inteira em centavos (`bigint`, com sinal) e moeda ISO-4217.
 *
 * - Imutável: toda operação retorna uma nova instância.
 * - Exato: só aritmética de `bigint`; nunca passa por `number`.
 * - Multi-moeda (contrato §6.1): operações entre moedas diferentes lançam `CurrencyMismatchError`.
 * - Aceita valores negativos internamente. Contratos de entrada (`fromProps`) os rejeitam; impedir
 *   saldo negativo é regra da carteira, não deste tipo.
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

  /**
   * Lê a representação dos contratos de entrada (§6.1): `amount` em string decimal canônica, não
   * negativa e com exatamente 2 casas (`"0.05"`, `"25.00"`). Qualquer outra forma — incluindo
   * `"25"`, `"25.5"`, `"01.00"`, `"+1.00"`, `"1e3"` ou espaços — lança `InvalidMoneyError`.
   * A conversão é feita sobre os dígitos da string, sem passar por `number`.
   */
  static fromProps(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null) {
      throw new InvalidMoneyError('Money exige um objeto { amount, currency }.');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError(`amount deve ser uma string decimal; recebido ${typeof amount}.`);
    }
    if (!DECIMAL_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(
        `amount inválido: "${preview(amount)}". ` +
          'Use uma string decimal não negativa com exatamente duas casas, ex.: "25.00".',
      );
    }
    if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) {
      const shown = typeof currency === 'string' ? `"${preview(currency)}"` : typeof currency;
      throw new InvalidMoneyError(
        `currency inválida: ${shown}. Use um código ISO-4217, ex.: "BRL".`,
      );
    }
    return new Money(BigInt(amount.replace('.', '')), currency);
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

  /** Representação dos contratos, sempre com 2 casas; negativos saem com `-` (ex.: `"-1.50"`). */
  toProps(): MoneyProps {
    const negative = this.#cents < 0n;
    const magnitude = negative ? -this.#cents : this.#cents;
    const units = (magnitude / 100n).toString();
    const fraction = (magnitude % 100n).toString().padStart(2, '0');
    return { amount: `${negative ? '-' : ''}${units}.${fraction}`, currency: this.#currency };
  }

  /** Bloqueia coerções implícitas (`money + 1`, `a < b`, template strings), que seriam silenciosas. */
  [Symbol.toPrimitive](): never {
    throw new TypeError('Money não pode ser convertido implicitamente; use cents/currency.');
  }

  /** Eventos e respostas carregam `MoneyProps` explicitamente, nunca a instância (contrato §11). */
  toJSON(): never {
    throw new TypeError('Money não é serializável diretamente; use toProps().');
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

/** Erro de domínio: representação monetária de entrada inválida (contrato §6.1). */
export class InvalidMoneyError extends Error {
  override readonly name = 'InvalidMoneyError';
}

// Formato do código ISO-4217 (três letras maiúsculas). Não restringe a uma lista de moedas.
const CURRENCY_CODE = /^[A-Z]{3}$/;

// Forma canônica: sem sinal, sem zeros à esquerda, só dígitos ASCII e exatamente 2 casas.
const DECIMAL_AMOUNT = /^(?:0|[1-9][0-9]*)\.[0-9]{2}$/;

// Evita mensagens de erro gigantes quando a entrada for muito longa.
function preview(value: string): string {
  return value.length > 32 ? `${value.slice(0, 32)}…` : value;
}

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
