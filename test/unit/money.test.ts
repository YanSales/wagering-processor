import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/domain/money';

const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');

// Acima de Number.MAX_SAFE_INTEGER (9007199254740991): number perderia precisão aqui.
const HUGE = 9_007_199_254_740_993n;

describe('Money: criação', () => {
  test('cria a partir de centavos em bigint e expõe quantia e moeda', () => {
    const money = brl(2500n);

    expect(money.cents).toBe(2500n);
    expect(typeof money.cents).toBe('bigint');
    expect(money.currency).toBe('BRL');
  });

  test('zero é igual a 0 centavos na mesma moeda', () => {
    const zero = Money.zero('BRL');

    expect(zero.cents).toBe(0n);
    expect(zero.isZero()).toBe(true);
    expect(zero.isNegative()).toBe(false);
    expect(zero.equals(brl(0n))).toBe(true);
  });

  test('aceita valores negativos (a regra de saldo não negativo é da carteira)', () => {
    const money = brl(-150n);

    expect(money.cents).toBe(-150n);
    expect(money.isNegative()).toBe(true);
    expect(money.isZero()).toBe(false);
  });

  test('aceita qualquer código no formato ISO-4217, não só BRL', () => {
    expect(Money.fromCents(1n, 'USD').currency).toBe('USD');
  });

  test.each([
    ['number', 2500],
    ['string', '2500'],
    ['NaN', Number.NaN],
    ['undefined', undefined],
    ['null', null],
  ])('rejeita centavos que não são bigint: %s', (_case, cents) => {
    expect(() => Money.fromCents(cents as unknown as bigint, 'BRL')).toThrow(TypeError);
  });

  test.each(['', 'brl', 'BR', 'BRLL', 'R$', ' BRL'])('rejeita moeda inválida: %p', (currency) => {
    expect(() => Money.fromCents(1n, currency)).toThrow(RangeError);
  });

  test('rejeita moeda que não é string', () => {
    expect(() => Money.fromCents(1n, 986 as unknown as string)).toThrow(TypeError);
  });
});

describe('Money: aritmética exata', () => {
  test('soma', () => {
    expect(brl(1050n).add(brl(250n)).equals(brl(1300n))).toBe(true);
  });

  test('subtrai, inclusive com resultado negativo', () => {
    expect(brl(1000n).subtract(brl(250n)).equals(brl(750n))).toBe(true);
    expect(brl(100n).subtract(brl(250n)).equals(brl(-150n))).toBe(true);
  });

  test('mantém precisão além da faixa segura de inteiros do JavaScript', () => {
    expect(brl(HUGE).add(brl(1n)).cents).toBe(9_007_199_254_740_994n);
    expect(brl(HUGE).subtract(brl(HUGE - 1n)).cents).toBe(1n);
    const enormous = 10n ** 30n;
    expect(brl(enormous).add(brl(enormous)).cents).toBe(2n * 10n ** 30n);
  });

  test('não altera as instâncias originais', () => {
    const a = brl(1000n);
    const b = brl(250n);

    const sum = a.add(b);
    const difference = a.subtract(b);

    expect(a.cents).toBe(1000n);
    expect(b.cents).toBe(250n);
    expect(sum).not.toBe(a);
    expect(difference).not.toBe(a);
  });

  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['compareTo', (a: Money, b: Money) => a.compareTo(b)],
  ])('%s entre moedas diferentes lança CurrencyMismatchError', (_name, operation) => {
    expect(() => operation(brl(100n), Money.fromCents(100n, 'USD'))).toThrow(CurrencyMismatchError);
  });

  test('rejeita operando que não é Money', () => {
    const fake = { cents: 100n, currency: 'BRL' } as unknown as Money;

    expect(() => brl(100n).add(fake)).toThrow(TypeError);
    expect(() => brl(100n).equals(fake)).toThrow(TypeError);
  });
});

describe('Money: igualdade e comparação', () => {
  test('instâncias distintas com o mesmo valor são iguais', () => {
    expect(brl(2500n).equals(brl(2500n))).toBe(true);
  });

  test('quantias diferentes não são iguais', () => {
    expect(brl(2500n).equals(brl(2501n))).toBe(false);
  });

  test('mesma quantia em moedas diferentes não é igual', () => {
    expect(brl(2500n).equals(Money.fromCents(2500n, 'USD'))).toBe(false);
  });

  test('compareTo ordena por quantia, inclusive negativos e valores grandes', () => {
    expect(brl(100n).compareTo(brl(200n))).toBe(-1);
    expect(brl(200n).compareTo(brl(100n))).toBe(1);
    expect(brl(200n).compareTo(brl(200n))).toBe(0);
    expect(brl(-1n).compareTo(brl(0n))).toBe(-1);
    expect(brl(HUGE).compareTo(brl(HUGE - 1n))).toBe(1);
  });
});

describe('Money: imutabilidade e conversões implícitas', () => {
  test('a instância é congelada e não expõe estado mutável', () => {
    const money = brl(100n);

    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { cents: bigint }).cents = 999n;
    }).toThrow(TypeError);
    expect(money.cents).toBe(100n);
  });

  test('bloqueia coerção implícita para número ou string', () => {
    const money = brl(100n) as unknown as number;

    expect(() => money + 1).toThrow(TypeError);
    expect(() => money < 200).toThrow(TypeError);
    expect(() => `${money}`).toThrow(TypeError);
    expect(() => Number(money)).toThrow(TypeError);
  });

  test('não é serializado silenciosamente em JSON', () => {
    expect(() => JSON.stringify({ balance: brl(100n) })).toThrow(TypeError);
  });
});
