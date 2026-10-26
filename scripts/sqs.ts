/**
 * CLI das filas SQS de eventos de apostas.
 *
 *   bun scripts/sqs.ts provision   cria (ou reutiliza) a DLQ e a fila principal e confere atributos
 *   bun scripts/sqs.ts inspect     mostra URL e atributos das filas, sem criá-las
 *
 * Lê a configuração do ambiente (o Bun carrega o `.env`). Não imprime credenciais.
 * Sem `SQS_ENDPOINT`, o SDK usaria o SQS da AWS (e qualquer credencial real da máquina): isso só
 * é permitido com a flag explícita `--aws`, para evitar operar na AWS por engano.
 */
import { createSqsClient, readSqsSettings } from '../src/messaging/sqs.config';
import {
  describeWagerEventsQueues,
  provisionWagerEventsQueues,
  type QueueDescription,
} from '../src/messaging/wager-events.queues';
import { readWagerTransactionsConsumerSettings } from '../src/messaging/wager-transactions-consumer.config';

const SHOWN_ATTRIBUTES = [
  'QueueArn',
  'FifoQueue',
  'ContentBasedDeduplication',
  'VisibilityTimeout',
  'MessageRetentionPeriod',
  'RedrivePolicy',
  'ApproximateNumberOfMessages',
  'ApproximateNumberOfMessagesNotVisible',
];

function print(label: string, queue: QueueDescription): void {
  console.log(`${label}: ${queue.name}`);
  console.log(`  url: ${queue.url}`);
  for (const key of SHOWN_ATTRIBUTES) {
    if (queue.attributes[key] !== undefined) {
      console.log(`  ${key}: ${queue.attributes[key]}`);
    }
  }
}

function warnUnverified(label: string, keys: string[]): void {
  if (keys.length > 0) {
    console.warn(`Aviso: o provedor não reporta ${keys.join(', ')} (${label}); não conferido.`);
  }
}

async function main([command, ...flags]: string[]): Promise<void> {
  if (command !== 'provision' && command !== 'inspect') {
    throw new Error('Uso: bun scripts/sqs.ts <provision|inspect>');
  }

  const settings = readSqsSettings();
  if (settings.endpoint === undefined && !flags.includes('--aws')) {
    throw new Error(
      `SQS_ENDPOINT ausente: o comando operaria no SQS da AWS (${settings.region}). Defina ` +
        'SQS_ENDPOINT para o emulador local ou passe --aws explicitamente.',
    );
  }
  const client = createSqsClient(settings);
  // Filas de entrada do consumidor (§10): mesma definição versionada (FIFO, redrive para a DLQ).
  const transactions = readWagerTransactionsConsumerSettings();
  const transactionQueues = {
    wagerEventsQueueName: transactions.queueName,
    wagerEventsDlqName: transactions.dlqName,
  };
  try {
    console.log(`SQS: ${settings.endpoint ?? `AWS (${settings.region})`}`);
    if (command === 'inspect') {
      const queues = await describeWagerEventsQueues(client, settings);
      print('Fila principal', queues.main);
      print('DLQ', queues.dlq);
      const input = await describeWagerEventsQueues(client, transactionQueues);
      print('Fila de transações', input.main);
      print('DLQ de transações', input.dlq);
      return;
    }

    const queues = await provisionWagerEventsQueues(client, settings);
    print('Fila principal', queues.main);
    print('DLQ', queues.dlq);
    warnUnverified('fila principal', queues.unverifiedAttributes.main);
    warnUnverified('DLQ', queues.unverifiedAttributes.dlq);
    const input = await provisionWagerEventsQueues(client, transactionQueues);
    print('Fila de transações', input.main);
    print('DLQ de transações', input.dlq);
    warnUnverified('fila de transações', input.unverifiedAttributes.main);
    warnUnverified('DLQ de transações', input.unverifiedAttributes.dlq);
    console.log('Provisionamento concluído; atributos reportados conferem com a definição.');
  } finally {
    client.destroy();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`Erro: ${message}`);
  process.exit(1);
}
