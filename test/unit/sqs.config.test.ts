import { describe, expect, test } from 'bun:test';
import { readSqsSettings } from '../../src/messaging/sqs.config';

const VALID_ENV = {
  AWS_REGION: 'us-east-1',
  SQS_ENDPOINT: 'http://127.0.0.1:9324',
  SQS_WAGER_EVENTS_QUEUE: 'wager-events.fifo',
  SQS_WAGER_EVENTS_DLQ: 'wager-events-dlq.fifo',
  AWS_SECRET_ACCESS_KEY: 'fake-secret-for-tests',
};

describe('readSqsSettings', () => {
  test('converte variáveis válidas em configuração tipada', () => {
    expect(readSqsSettings(VALID_ENV)).toEqual({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9324',
      wagerEventsQueueName: 'wager-events.fifo',
      wagerEventsDlqName: 'wager-events-dlq.fifo',
    });
  });

  test.each([undefined, ''])('SQS_ENDPOINT ausente (%p) usa o SQS da AWS', (endpoint) => {
    expect(readSqsSettings({ ...VALID_ENV, SQS_ENDPOINT: endpoint }).endpoint).toBeUndefined();
  });

  test('lista as variáveis ausentes sem expor valores', () => {
    const run = () =>
      readSqsSettings({ ...VALID_ENV, AWS_REGION: undefined, SQS_WAGER_EVENTS_DLQ: '' });

    expect(run).toThrow('Variáveis de ambiente do SQS ausentes: AWS_REGION, SQS_WAGER_EVENTS_DLQ');
    expect(run).not.toThrow(VALID_ENV.AWS_SECRET_ACCESS_KEY);
  });

  test.each([
    ['sem sufixo .fifo', 'wager-events'],
    ['caractere inválido', 'wager.events.fifo'],
    ['nome longo demais', `${'a'.repeat(76)}.fifo`],
  ])('rejeita fila com %s', (_case, name) => {
    expect(() => readSqsSettings({ ...VALID_ENV, SQS_WAGER_EVENTS_QUEUE: name })).toThrow(
      'SQS_WAGER_EVENTS_QUEUE inválida',
    );
  });

  test('aceita o maior nome FIFO permitido (80 caracteres)', () => {
    const name = `${'a'.repeat(75)}.fifo`;
    expect(
      readSqsSettings({ ...VALID_ENV, SQS_WAGER_EVENTS_QUEUE: name }).wagerEventsQueueName,
    ).toBe(name);
  });

  test('rejeita DLQ igual à fila principal', () => {
    expect(() =>
      readSqsSettings({ ...VALID_ENV, SQS_WAGER_EVENTS_DLQ: VALID_ENV.SQS_WAGER_EVENTS_QUEUE }),
    ).toThrow('deve ser diferente');
  });

  test.each(['localhost:9324', 'ftp://127.0.0.1:9324', 'não-é-url'])(
    'rejeita SQS_ENDPOINT inválido: %p',
    (endpoint) => {
      expect(() => readSqsSettings({ ...VALID_ENV, SQS_ENDPOINT: endpoint })).toThrow(
        'SQS_ENDPOINT inválido',
      );
    },
  );
});
