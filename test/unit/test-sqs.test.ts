import { describe, expect, test } from 'bun:test';
import { assertLocalSqsEndpoint } from '../support/test-sqs';

describe('assertLocalSqsEndpoint', () => {
  test.each(['http://127.0.0.1:9324', 'http://localhost:9324', 'http://[::1]:9324'])(
    'aceita emulador no loopback: %p',
    (endpoint) => {
      expect(assertLocalSqsEndpoint({ SQS_ENDPOINT: endpoint })).toBe(endpoint);
    },
  );

  test.each([
    ['ausente', undefined, 'SQS_ENDPOINT ausente'],
    ['vazio', '', 'SQS_ENDPOINT ausente'],
    ['AWS real', 'https://sqs.us-east-1.amazonaws.com', 'Recusando'],
    ['host remoto', 'http://10.0.0.5:9324', 'Recusando'],
    ['inválido', 'não-é-url', 'SQS_ENDPOINT inválido'],
  ])('recusa endpoint %s', (_case, endpoint, message) => {
    expect(() => assertLocalSqsEndpoint({ SQS_ENDPOINT: endpoint })).toThrow(message);
  });
});
