import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  computeWagerPayloadHash,
  type WagerPayloadFields,
} from '../../src/application/payload-hash';
import { Money } from '../../src/domain/money';

const fields: WagerPayloadFields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: Money.fromCents(2_500n, 'BRL'),
};

describe('canonicalJson', () => {
  test('ordena as chaves em todos os níveis, sem espaços', () => {
    expect(canonicalJson({ b: 'x', a: { d: '1', c: '2' } })).toBe(
      '{"a":{"c":"2","d":"1"},"b":"x"}',
    );
  });

  test('escapa strings como JSON', () => {
    expect(canonicalJson({ a: 'aspas " e \\ barra' })).toBe('{"a":"aspas \\" e \\\\ barra"}');
  });

  test('recusa tipos que não são strings nem objetos', () => {
    expect(() => canonicalJson({ a: 1 })).toThrow(TypeError);
  });
});

describe('computeWagerPayloadHash', () => {
  test('é o SHA-256 hexadecimal do JSON canônico dos campos de negócio', () => {
    const canonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1",' +
      '"providerId":"provider-a","roundId":"round-987","walletId":"wallet-1"}';

    expect(computeWagerPayloadHash(fields)).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    );
    expect(computeWagerPayloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('não depende da ordem das propriedades recebidas', () => {
    const reordered = Object.fromEntries(Object.entries(fields).reverse()) as WagerPayloadFields;

    expect(computeWagerPayloadHash(reordered)).toBe(computeWagerPayloadHash(fields));
  });

  test('ignora campos que não são de negócio (ex.: a chave de idempotência)', () => {
    const withTransport = { ...fields, idempotencyKey: 'outra-chave' } as WagerPayloadFields;

    expect(computeWagerPayloadHash(withTransport)).toBe(computeWagerPayloadHash(fields));
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: 'WIN' }],
    ['valor', { money: Money.fromCents(2_501n, 'BRL') }],
    ['moeda', { money: Money.fromCents(2_500n, 'USD') }],
    ['referência', { referenceExternalTransactionId: 'transaction-1' }],
  ])('muda quando muda %s', (_field, change) => {
    expect(computeWagerPayloadHash({ ...fields, ...change })).not.toBe(
      computeWagerPayloadHash(fields),
    );
  });
});
