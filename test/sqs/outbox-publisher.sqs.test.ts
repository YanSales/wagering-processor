import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  ListQueuesCommand,
  type Message,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../src/application/open-wallet';
import { PublishOutbox } from '../../src/application/outbox/publish-outbox';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmOutboxRepository } from '../../src/database/repositories/outbox.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { createSqsClient, readSqsSettings } from '../../src/messaging/sqs.config';
import { SqsEventPublisher } from '../../src/messaging/sqs-event-publisher';
import { provisionWagerEventsQueues } from '../../src/messaging/wager-events.queues';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';
import { assertLocalSqsEndpoint } from '../support/test-sqs';

// PostgreSQL de teste e emulador SQS no loopback (`bun run db:test:up`, `bun run sqs:up`).
assertTestDatabaseEnv();
assertLocalSqsEndpoint();

// Filas efêmeras com nome único: o teste nunca toca `wager-events.fifo` nem sua DLQ.
const PREFIX = `it-${randomUUID().slice(0, 8)}`;
const settings = readSqsSettings({
  ...process.env,
  SQS_WAGER_EVENTS_QUEUE: `${PREFIX}-wager-events.fifo`,
  SQS_WAGER_EVENTS_DLQ: `${PREFIX}-wager-events-dlq.fifo`,
});
const client = createSqsClient(settings);
const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');

let orm: MikroORM;
let queueUrl: string;

function publisher(broker: SqsEventPublisher | { publish: () => Promise<void> }) {
  return new PublishOutbox(new MikroOrmOutboxRepository(orm), broker, {
    maxGroups: 1_000,
    maxPerGroup: 50,
    leaseMs: 30_000,
  });
}

async function drain(p: PublishOutbox): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) {
    if ((await p.runOnce()).claimed === 0) return;
  }
  throw new Error('a outbox não esvaziou');
}

/** Recebe e apaga até não vir mais nada (FIFO: um grupo só libera o próximo lote após o ack). */
async function receiveAll(): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const { Messages } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    if (Messages === undefined || Messages.length === 0) return all;
    for (const message of Messages) {
      all.push(message);
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  queueUrl = (await provisionWagerEventsQueues(client, settings)).main.url;
  // Eventos deixados por outras suítes no banco compartilhado não vão para a fila deste teste.
  await drain(publisher({ publish: async () => undefined }));
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  const { QueueUrls } = await client.send(new ListQueuesCommand({ QueueNamePrefix: PREFIX }));
  for (const QueueUrl of QueueUrls ?? []) await client.send(new DeleteQueueCommand({ QueueUrl }));
  client.destroy();
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('publisher da outbox no SQS FIFO (emulador)', () => {
  test('publica os eventos confirmados em ordem por wallet, com grupo e deduplicação', async () => {
    const playerId = `player-${randomUUID()}`;
    const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
      playerId,
      initialBalance: brl(10_000n),
    });
    const submit = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm));
    for (const cents of [1_000n, 2_000n]) {
      const externalTransactionId = `bet-${randomUUID()}`;
      await submit.execute({
        idempotencyKey: `provider-a:${externalTransactionId}`,
        providerId: 'provider-a',
        externalTransactionId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl(cents),
      });
    }
    const rows = (await orm.em
      .getConnection()
      .execute(
        'select id, event_type, payload from outbox_messages where message_group_id = ? order by seq',
        [wallet.id],
      )) as { id: string; event_type: string; payload: Record<string, unknown> }[];
    expect(rows).toHaveLength(6);

    const sqs = new SqsEventPublisher(client, settings.wagerEventsQueueName, 5_000);
    await drain(publisher(sqs));

    const received = await receiveAll();
    expect(received.map((m) => m.Attributes?.MessageGroupId)).toEqual(rows.map(() => wallet.id));
    expect(received.map((m) => m.Attributes?.MessageDeduplicationId)).toEqual(
      rows.map((r) => r.id),
    );
    expect(received.map((m) => m.MessageAttributes?.eventType?.StringValue)).toEqual(
      rows.map((r) => r.event_type),
    );
    expect(received.map((m) => JSON.parse(m.Body as string))).toEqual(rows.map((r) => r.payload));

    // Reenvio do mesmo evento (publisher caído antes de marcar): o SQS descarta pela deduplicação.
    const first = rows[0] as (typeof rows)[number];
    await sqs.publish({
      id: first.id,
      messageGroupId: wallet.id,
      eventType: first.event_type,
      payload: first.payload,
      attempts: 0,
    });
    expect(await receiveAll()).toEqual([]);
  });
});
