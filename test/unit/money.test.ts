import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/domain/money';

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

describe('Money.fromProps: representação dos contratos de entrada', () => {
  // `currency` omitido usa BRL; `undefined` explícito é preservado (caso "ausente").
  const props = (amount: unknown, ...currency: [unknown?]) =>
    ({ amount, currency: currency.length === 0 ? 'BRL' : currency[0] }) as unknown as {
      amount: string;
      currency: string;
    };

  test.each([
    ['25.00', 2500n],
    ['0.00', 0n],
    ['0.05', 5n],
    ['0.50', 50n],
    ['1.01', 101n],
    ['1000.00', 100_000n],
    // Além de Number.MAX_SAFE_INTEGER: a conversão não passa por number.
    ['90071992547409.93', 9_007_199_254_740_993n],
    ['1000000000000000000000000000000.00', 10n ** 32n],
  ])('converte "%s" para %p centavos', (amount, cents) => {
    const money = Money.fromProps(props(amount));

    expect(money.cents).toBe(cents);
    expect(money.currency).toBe('BRL');
  });

  test('preserva a moeda informada', () => {
    expect(Money.fromProps(props('1.00', 'USD')).currency).toBe('USD');
  });

  // Entradas que o contrato §6.1 manda rejeitar explicitamente.
  test.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['notação científica', '1e3'],
    ['notação científica com casas', '2.5e1'],
    ['string vazia', ''],
    ['mais de 2 casas', '25.000'],
    ['mais de 2 casas (arredondaria)', '0.005'],
    ['valor negativo', '-25.00'],
    ['zero negativo', '-0.00'],
  ])('rejeita %s: %p', (_case, amount) => {
    expect(() => Money.fromProps(props(amount))).toThrow(InvalidMoneyError);
  });

  // Formas não canônicas: o contrato exige escala fixa de 2 casas; a forma estrita é a mais segura.
  test.each([
    ['sem casas decimais', '25'],
    ['uma casa decimal', '25.5'],
    ['ponto sem casas', '25.'],
    ['sem parte inteira', '.50'],
    ['zero à esquerda', '01.00'],
    ['sinal positivo', '+25.00'],
    ['vírgula decimal', '25,00'],
    ['separador de milhar', '1,000.00'],
    ['outro separador', '25x00'],
    ['espaço à esquerda', ' 25.00'],
    ['espaço à direita', '25.00 '],
    ['dígitos não ASCII', '٢٥.٠٠'],
    ['hexadecimal', '0x19.00'],
    ['texto', 'abc'],
  ])('rejeita %s: %p', (_case, amount) => {
    expect(() => Money.fromProps(props(amount))).toThrow(InvalidMoneyError);
  });

  test.each([
    ['number', 25],
    ['bigint', 2500n],
    ['null', null],
    ['undefined', undefined],
    ['objeto', { value: '25.00' }],
  ])('rejeita amount que não é string: %s', (_case, amount) => {
    expect(() => Money.fromProps(props(amount))).toThrow(InvalidMoneyError);
  });

  test.each([
    ['minúsculas', 'brl'],
    ['vazia', ''],
    ['símbolo', 'R$'],
    ['número', 986],
    ['ausente', undefined],
    ['instância de Money', Money.zero('BRL')],
  ])('rejeita currency inválida (%s) com InvalidMoneyError', (_case, currency) => {
    expect(() => Money.fromProps(props('1.00', currency))).toThrow(InvalidMoneyError);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['string', '25.00'],
  ])('rejeita props que não são objeto: %s', (_case, value) => {
    expect(() => Money.fromProps(value as unknown as { amount: string; currency: string })).toThrow(
      InvalidMoneyError,
    );
  });

  test('a mensagem de erro de entradas muito longas é truncada', () => {
    const run = () => Money.fromProps(props(`${'9'.repeat(1000)}.000`));

    expect(run).toThrow(InvalidMoneyError);
    expect(run).not.toThrow('9'.repeat(100));
  });
});

describe('Money.toProps: representação dos contratos', () => {
  test.each([
    [2500n, '25.00'],
    [0n, '0.00'],
    [5n, '0.05'],
    [50n, '0.50'],
    [101n, '1.01'],
    [100_000n, '1000.00'],
    [9_007_199_254_740_993n, '90071992547409.93'],
    [-150n, '-1.50'],
    [-5n, '-0.05'],
    [-100n, '-1.00'],
  ])('%p centavos -> "%s", sempre com 2 casas', (cents, amount) => {
    expect(brl(cents).toProps()).toEqual({ amount, currency: 'BRL' });
  });

  test('retorna um objeto novo e não altera a instância', () => {
    const money = brl(2500n);

    const first = money.toProps();
    const second = money.toProps();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(money.cents).toBe(2500n);
  });

  test('pode ser serializado em JSON explicitamente (a instância continua bloqueada)', () => {
    const money = brl(97_500n);

    expect(JSON.stringify({ balance: money.toProps() })).toBe(
      '{"balance":{"amount":"975.00","currency":"BRL"}}',
    );
    expect(() => JSON.stringify({ balance: money })).toThrow('toProps()');
  });

  test.each(['0.00', '0.05', '25.00', '975.00', '90071992547409.93'])(
    'ida e volta preserva o valor: "%s"',
    (amount) => {
      const props = { amount, currency: 'BRL' };

      expect(Money.fromProps(props).toProps()).toEqual(props);
    },
  );

  test('operações sobre valores lidos do contrato continuam exatas', () => {
    const balance = Money.fromProps({ amount: '1000.00', currency: 'BRL' });
    const bet = Money.fromProps({ amount: '25.00', currency: 'BRL' });

    expect(balance.subtract(bet).toProps()).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(bet.subtract(balance).toProps()).toEqual({ amount: '-975.00', currency: 'BRL' });
  });
});
