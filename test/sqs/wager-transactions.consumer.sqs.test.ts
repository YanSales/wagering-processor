import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  ListQueuesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  HandleWagerTransactionMessage,
  type MessageDisposition,
} from '../../src/application/inbox/handle-wager-transaction-message';
import { OpenWallet } from '../../src/application/open-wallet';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmInboxRepository } from '../../src/database/repositories/inbox.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { createSqsClient, readSqsSettings } from '../../src/messaging/sqs.config';
import {
  provisionWagerEventsQueues,
  WAGER_EVENTS_MAX_RECEIVE_COUNT,
} from '../../src/messaging/wager-events.queues';
import { WagerTransactionsConsumer } from '../../src/messaging/wager-transactions.consumer';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';
import { assertLocalSqsEndpoint } from '../support/test-sqs';

// PostgreSQL de teste e emulador SQS no loopback (`bun run db:test:up`, `bun run sqs:up`).
assertTestDatabaseEnv();
assertLocalSqsEndpoint();

// Filas efêmeras com a definição versionada (FIFO, redrive para a DLQ): nunca as filas reais.
const PREFIX = `it-${randomUUID().slice(0, 8)}`;
const names = {
  wagerEventsQueueName: `${PREFIX}-wager-transactions.fifo`,
  wagerEventsDlqName: `${PREFIX}-wager-transactions-dlq.fifo`,
};
const client = createSqsClient(
  readSqsSettings({
    ...process.env,
    SQS_WAGER_EVENTS_QUEUE: names.wagerEventsQueueName,
    SQS_WAGER_EVENTS_DLQ: names.wagerEventsDlqName,
  }),
);
const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');

let orm: MikroORM;
let queueUrl: string;
let dlqUrl: string;

function consumer(handler: Pick<HandleWagerTransactionMessage, 'handle'>) {
  return new WagerTransactionsConsumer(
    client,
    handler,
    {
      queueName: names.wagerEventsQueueName,
      dlqName: names.wagerEventsDlqName,
      waitTimeSeconds: 1,
      maxMessages: 10,
      // Sem espera entre tentativas: a mensagem volta na próxima recepção.
      retryBaseSeconds: 0,
      retryMaxSeconds: 0,
    },
    silent,
  );
}

const realHandler = () =>
  new HandleWagerTransactionMessage(
    new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm)),
    new MikroOrmInboxRepository(orm),
  );

async function openWallet(cents: bigint) {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: brl(cents),
  });
  return { walletId: wallet.id, playerId };
}

function body(wallet: { walletId: string; playerId: string }, amount: string) {
  const externalTransactionId = `bet-${randomUUID()}`;
  return {
    messageId: `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  };
}

async function send(payload: unknown, group: string, dedup = randomUUID()): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof payload === 'string' ? payload : JSON.stringify(payload),
      MessageGroupId: group,
      MessageDeduplicationId: dedup,
    }),
  );
}

async function drainDlq(): Promise<Message[]> {
  const { Messages = [] } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
    }),
  );
  for (const m of Messages) {
    await client.send(
      new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: m.ReceiptHandle }),
    );
  }
  return Messages;
}

async function balance(walletId: string): Promise<string> {
  const [row] = (await orm.em
    .getConnection()
    .execute('select balance_cents::text as b from wallets where id = ?', [walletId])) as {
    b: string;
  }[];
  return row?.b as string;
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  const queues = await provisionWagerEventsQueues(client, names);
  queueUrl = queues.main.url;
  dlqUrl = queues.dlq.url;
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  const { QueueUrls } = await client.send(new ListQueuesCommand({ QueueNamePrefix: PREFIX }));
  for (const QueueUrl of QueueUrls ?? []) await client.send(new DeleteQueueCommand({ QueueUrl }));
  client.destroy();
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('consumidor de wager-transactions.fifo (emulador SQS + PostgreSQL)', () => {
  test('mensagem válida: aplicada e apagada; reenviada pelo produtor, não aplica de novo', async () => {
    const wallet = await openWallet(10_000n);
    const message = body(wallet, '25.00');

    await send(message, wallet.walletId);
    expect(await consumer(realHandler()).pollOnce()).toMatchObject({ received: 1, acked: 1 });
    expect(await balance(wallet.walletId)).toBe('7500');

    // Mesmo messageId, outro envio (outra deduplicação do SQS): para na Inbox.
    await send(message, wallet.walletId);
    expect(await consumer(realHandler()).pollOnce()).toMatchObject({ received: 1, acked: 1 });
    expect(await balance(wallet.walletId)).toBe('7500');
    expect((await consumer(realHandler()).pollOnce()).received).toBe(0);
  });

  test('ACK só depois do commit: falha antes do commit mantém a mensagem na fila', async () => {
    const wallet = await openWallet(10_000n);
    const [taken] = (await orm.em
      .getConnection()
      .execute('select id from outbox_messages where message_group_id = ? limit 1', [
        wallet.walletId,
      ])) as { id: string }[];
    const failing = new HandleWagerTransactionMessage(
      new SubmitWagerTransaction(
        new MikroOrmWagerTransactionRepository(orm, () => taken?.id as string),
      ),
      new MikroOrmInboxRepository(orm),
    );
    await send(body(wallet, '10.00'), wallet.walletId);

    expect(await consumer(failing).pollOnce()).toMatchObject({ received: 1, retried: 1, acked: 0 });
    expect(await balance(wallet.walletId)).toBe('10000');

    // A mensagem não foi apagada: volta e é aplicada uma vez.
    expect(await consumer(realHandler()).pollOnce()).toMatchObject({ received: 1, acked: 1 });
    expect(await balance(wallet.walletId)).toBe('9000');
  });

  test('mensagem inválida e erro permanente vão direto à DLQ, com o motivo', async () => {
    const wallet = await openWallet(10_000n);
    await send('{ não é json', wallet.walletId);
    await send(body({ walletId: randomUUID(), playerId: 'p' }, '1.00'), wallet.walletId);

    const summary = await consumer(realHandler()).pollOnce();

    expect(summary).toMatchObject({ received: 2, deadLettered: 2, acked: 0 });
    const reasons = (await drainDlq()).map((m) => m.MessageAttributes?.reason?.StringValue);
    expect(reasons.sort()).toEqual(['INVALID_MESSAGE', 'WALLET_NOT_FOUND']);
    expect((await consumer(realHandler()).pollOnce()).received).toBe(0);
  });

  test('falha transitória persistente: retries limitados e redrive do SQS para a DLQ', async () => {
    const wallet = await openWallet(10_000n);
    await send(body(wallet, '1.00'), wallet.walletId);
    const alwaysTransient = {
      handle: async (): Promise<MessageDisposition> => ({ action: 'retry', reason: 'TRANSIENT' }),
    };

    let retried = 0;
    for (let i = 0; i < WAGER_EVENTS_MAX_RECEIVE_COUNT + 2; i += 1) {
      retried += (await consumer(alwaysTransient).pollOnce()).retried;
    }

    expect(retried).toBe(WAGER_EVENTS_MAX_RECEIVE_COUNT);
    expect(await drainDlq()).toHaveLength(1);
    expect(await balance(wallet.walletId)).toBe('10000');
  });

  test('ordem por wallet: depois de uma falha no grupo, as seguintes do lote voltam à fila', async () => {
    const wallet = await openWallet(10_000n);
    const first = body(wallet, '1.00');
    const second = body(wallet, '2.00');
    await send(first, wallet.walletId);
    await send(second, wallet.walletId);
    const seen: string[] = [];
    let failOnce = true;
    const real = realHandler();
    const handler = {
      handle: async (m: Parameters<HandleWagerTransactionMessage['handle']>[0]) => {
        seen.push(m.messageId);
        if (failOnce) {
          failOnce = false;
          return { action: 'retry', reason: 'TRANSIENT' } as MessageDisposition;
        }
        return real.handle(m);
      },
    };

    const firstBatch = await consumer(handler).pollOnce();
    // A primeira falhou; a segunda (mesmo grupo) não foi processada antes dela.
    expect(seen).toEqual([first.messageId]);
    expect(firstBatch.retried).toBe(1);

    for (let i = 0; i < 4 && seen.length < 3; i += 1) await consumer(handler).pollOnce();
    expect(seen).toEqual([first.messageId, first.messageId, second.messageId]);
    expect(await balance(wallet.walletId)).toBe('9700');
  });
});
