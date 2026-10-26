import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../src/application/open-wallet';
import { ReconcileWallet } from '../../src/application/queries';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmQueryRepository } from '../../src/database/repositories/query.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { createSqsClient, readSqsSettings } from '../../src/messaging/sqs.config';
import {
  dlqAttributes,
  mainQueueAttributes,
  provisionWagerEventsQueues,
} from '../../src/messaging/wager-events.queues';
import type { InstanceConfig, InstanceResult } from '../support/instance-worker';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';
import { assertLocalSqsEndpoint } from '../support/test-sqs';

// §13 com processos reais: cada instância é um processo Bun (`instance-worker.ts`) com seu pool e
// seu cliente SQS, sobre o PostgreSQL de teste e o emulador SQS compartilhados.
assertTestDatabaseEnv();
assertLocalSqsEndpoint();

const INSTANCE = fileURLToPath(new URL('../support/instance-worker.ts', import.meta.url));
const TIMEOUT_MS = 120_000;
/** Visibilidade curta nas filas efêmeras: a reentrega após a queda acontece em segundos. */
const VISIBILITY_SECONDS = 3;

const PREFIX = `it-${randomUUID().slice(0, 8)}`;
const client = createSqsClient(
  readSqsSettings({
    ...process.env,
    SQS_WAGER_EVENTS_QUEUE: `${PREFIX}-unused.fifo`,
    SQS_WAGER_EVENTS_DLQ: `${PREFIX}-unused-dlq.fifo`,
  }),
);
const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
let orm: MikroORM;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

/** Fila de transações e DLQ com a definição versionada, exceto a visibilidade curta. */
async function transactionQueues(suffix: string) {
  const names = {
    queue: `${PREFIX}-${suffix}-tx.fifo`,
    dlq: `${PREFIX}-${suffix}-tx-dlq.fifo`,
  };
  const { QueueUrl: dlqUrl } = await client.send(
    new CreateQueueCommand({ QueueName: names.dlq, Attributes: dlqAttributes() }),
  );
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({
      QueueName: names.queue,
      Attributes: {
        ...mainQueueAttributes(Attributes?.QueueArn as string),
        VisibilityTimeout: String(VISIBILITY_SECONDS),
      },
    }),
  );
  return { ...names, url: QueueUrl as string };
}

type Wallet = { walletId: string; playerId: string };

async function openWallet(cents: bigint): Promise<Wallet> {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: brl(cents),
  });
  return { walletId: wallet.id, playerId };
}

function message(
  wallet: Wallet,
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
  externalTransactionId = `${kind.toLowerCase()}-${randomUUID()}`,
) {
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
      kind,
      money: { amount, currency: 'BRL' },
      ...extra,
    },
  };
}

async function send(queueUrl: string, body: object, group: string): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: group,
      // Cada envio é outra mensagem para o SQS: duplicatas chegam de fato ao consumidor.
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async (prefix: string): Promise<string> => {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith(prefix)) return line;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`a instância encerrou antes de "${prefix}".`);
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

/** Sobe uma instância e espera ela conectar (`READY`). */
async function startInstance(options: Omit<InstanceConfig, 'stopFile'>) {
  const config: InstanceConfig = {
    ...options,
    stopFile: join(tmpdir(), `${PREFIX}-${options.name}-${randomUUID()}.stop`),
  };
  const child = Bun.spawn([process.execPath, '--no-env-file', INSTANCE, JSON.stringify(config)], {
    env: process.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const next = lineReader(child.stdout);
  await next('READY');
  return {
    child,
    next,
    go: async () => {
      child.stdin.write('GO\n');
      await child.stdin.end();
    },
    /** Cria o arquivo-sinal: a instância termina a rodada em curso, imprime `RESULT` e encerra. */
    async stop(): Promise<InstanceResult> {
      await Bun.write(config.stopFile, 'stop');
      try {
        const line = await next('RESULT ');
        await child.exited;
        return JSON.parse(line.slice('RESULT '.length)) as InstanceResult;
      } finally {
        await rm(config.stopFile, { force: true });
      }
    },
  };
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`tempo esgotado esperando: ${what}`);
}

async function inboxCount(messageIds: string[]): Promise<number> {
  const [row] = await sql<{ n: number }>(
    `select count(*)::int as n from inbox_messages where message_id in (${messageIds.map(() => '?').join(',')})`,
    messageIds,
  );
  return row?.n ?? 0;
}

async function walletState(walletId: string) {
  const [row] = await sql<{ balance: string; debits: number; credits: number }>(
    `select w.balance_cents::text as balance,
            (select count(*) from wallet_ledger_entries e
              where e.wallet_id = w.id and e.direction = 'DEBIT')::int as debits,
            (select count(*) from wallet_ledger_entries e
              where e.wallet_id = w.id and e.direction = 'CREDIT')::int as credits
       from wallets w where w.id = ?`,
    [walletId],
  );
  const reconciliation = await new ReconcileWallet(new MikroOrmQueryRepository(orm)).execute(
    walletId,
  );
  return { ...row, consistent: reconciliation?.consistent };
}

async function queueIsEmpty(queueUrl: string): Promise<boolean> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Attributes?.ApproximateNumberOfMessages === '0' &&
    Attributes?.ApproximateNumberOfMessagesNotVisible === '0'
  );
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  const { QueueUrls } = await client.send(new ListQueuesCommand({ QueueNamePrefix: PREFIX }));
  for (const QueueUrl of QueueUrls ?? []) await client.send(new DeleteQueueCommand({ QueueUrl }));
  client.destroy();
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('§13 com processos reais, PostgreSQL e SQS compartilhados', () => {
  test(
    'três instâncias consumindo a mesma fila: cenário do §8 por wallet, duplicatas sem efeito',
    async () => {
      const queues = await transactionQueues('three');
      const wallets = await Promise.all(Array.from({ length: 4 }, () => openWallet(10_000n)));
      const unique: ReturnType<typeof message>[] = [];
      for (const wallet of wallets) {
        for (let i = 0; i < 3; i += 1) unique.push(message(wallet, 'BET', '80.00'));
      }
      // Mesma operação (mesma chave) com outro messageId: replay pela idempotência.
      const first = unique[0] as ReturnType<typeof message>;
      const resent = { ...first, messageId: `msg-${randomUUID()}` };

      const instances = await Promise.all(
        ['a', 'b', 'c'].map((name) =>
          startInstance({
            name,
            transactionsQueue: queues.queue,
            transactionsDlq: queues.dlq,
            walletIds: wallets.map((w) => w.walletId),
            maxMessages: 1,
          }),
        ),
      );
      // Cada BET num grupo FIFO próprio: o SQS não as serializa, e as instâncias disputam a mesma
      // wallet de verdade. Cada mensagem é enviada duas vezes (mesmo messageId).
      for (const [i, body] of unique.entries()) {
        await send(queues.url, body, `g-${i}`);
        await send(queues.url, body, `g-${i}`);
      }
      await send(queues.url, resent, 'g-resent');
      await Promise.all(instances.map((instance) => instance.go()));

      const ids = [...unique.map((m) => m.messageId), resent.messageId];
      await waitFor(
        async () => (await inboxCount(ids)) === ids.length && (await queueIsEmpty(queues.url)),
        'todas as mensagens processadas e a fila vazia',
      );
      const results = await Promise.all(instances.map((instance) => instance.stop()));

      expect(new Set(results.map((r) => r.pid)).size).toBe(3);
      expect(results.reduce((sum, r) => sum + r.acked, 0)).toBe(unique.length * 2 + 1);
      expect(results.reduce((sum, r) => sum + r.deadLettered + r.retried, 0)).toBe(0);
      // Distribuição real entre as instâncias (registrada para o relatório do teste).
      console.log(
        `instâncias: ${results.map((r) => `${r.name}(pid ${r.pid})=${r.acked}`).join(', ')}`,
      );
      expect(results.filter((r) => r.acked > 0).length).toBeGreaterThanOrEqual(2);

      for (const wallet of wallets) {
        expect(await walletState(wallet.walletId)).toEqual({
          balance: '2000',
          debits: 1,
          credits: 1,
          consistent: true,
        });
        const statuses = await sql<{ status: string }>(
          "select status from wager_transactions where wallet_id = ? and kind = 'BET' order by status",
          [wallet.walletId],
        );
        expect(statuses.map((s) => s.status)).toEqual(['PROCESSED', 'REJECTED', 'REJECTED']);
        // Abertura (2), BET aplicada (2) e duas rejeições (1 cada): nenhum evento duplicado.
        const [events] = await sql<{ n: number }>(
          'select count(*)::int as n from outbox_messages where message_group_id = ?',
          [wallet.walletId],
        );
        expect(events?.n).toBe(6);
      }
      expect(await inboxCount(ids)).toBe(ids.length);
    },
    TIMEOUT_MS,
  );

  test(
    'instância morta depois do commit e antes do ack; reinício conclui tudo, inclusive a outbox',
    async () => {
      const queues = await transactionQueues('crash');
      const events = await provisionWagerEventsQueues(client, {
        wagerEventsQueueName: `${PREFIX}-events.fifo`,
        wagerEventsDlqName: `${PREFIX}-events-dlq.fifo`,
      });
      const wallet = await openWallet(10_000n);
      const other = await openWallet(10_000n);
      // REFUND antes da BET referenciada (mesmo grupo: chega primeiro) e uma BET em outra wallet.
      const betExternalId = `bet-${randomUUID()}`;
      const refund = message(wallet, 'REFUND', '30.00', {
        referenceExternalTransactionId: betExternalId,
      });
      const bet = message(wallet, 'BET', '30.00', {}, betExternalId);
      const otherBet = message(other, 'BET', '10.00');
      await send(queues.url, refund, wallet.walletId);
      await send(queues.url, bet, wallet.walletId);
      await send(queues.url, otherBet, other.walletId);
      const walletIds = [wallet.walletId, other.walletId];
      const ids = [refund.messageId, bet.messageId, otherBet.messageId];

      // 1ª instância: confirma a primeira mensagem e é morta antes do DeleteMessage.
      const crashing = await startInstance({
        name: 'crashing',
        transactionsQueue: queues.queue,
        transactionsDlq: queues.dlq,
        walletIds,
        maxMessages: 1,
        crashAfterCommits: 1,
      });
      await crashing.go();
      const committed = (await crashing.next('COMMITTED ')).slice('COMMITTED '.length);
      crashing.child.kill('SIGKILL');
      await crashing.child.exited;

      // O efeito está confirmado e registrado na Inbox; a mensagem continua na fila.
      expect(await inboxCount([committed])).toBe(1);
      expect(await queueIsEmpty(queues.url)).toBe(false);
      const [unpublished] = await sql<{ n: number }>(
        `select count(*)::int as n from outbox_messages
          where message_group_id in (?, ?) and published_at is null`,
        walletIds,
      );
      expect(unpublished?.n).toBeGreaterThan(0);

      // Reinício: outra instância, com consumidor, worker do §7.1 e publisher da outbox.
      const restarted = await startInstance({
        name: 'restarted',
        transactionsQueue: queues.queue,
        transactionsDlq: queues.dlq,
        eventsQueue: events.main.name,
        walletIds,
        maxMessages: 10,
      });
      await restarted.go();
      await waitFor(async () => {
        const [state] = await sql<{ refunded: number; pending: number; unpublished: number }>(
          `select
             (select count(*) from wager_transactions
               where idempotency_key = ? and status = 'PROCESSED')::int as refunded,
             (select count(*) from wager_transactions
               where wallet_id in (?, ?) and status in ('PENDING', 'PENDING_REFERENCE'))::int as pending,
             (select count(*) from outbox_messages
               where message_group_id in (?, ?) and published_at is null)::int as unpublished`,
          [refund.data.idempotencyKey, ...walletIds, ...walletIds],
        );
        return (
          state?.refunded === 1 &&
          state.pending === 0 &&
          state.unpublished === 0 &&
          (await inboxCount(ids)) === ids.length &&
          (await queueIsEmpty(queues.url))
        );
      }, 'REFUND resolvido, mensagens confirmadas e outbox publicada');
      const result = await restarted.stop();

      // A mensagem confirmada pela instância morta foi reentregue e parou na Inbox: 3 acks, 1 efeito.
      expect(result.acked).toBe(3);
      expect(result.resolvedPending).toBe(1);
      expect(await walletState(wallet.walletId)).toEqual({
        balance: '10000',
        debits: 1,
        credits: 2,
        consistent: true,
      });
      expect(await walletState(other.walletId)).toEqual({
        balance: '9000',
        debits: 1,
        credits: 1,
        consistent: true,
      });
      const [transactions] = await sql<{ n: number }>(
        `select count(*)::int as n from wager_transactions
          where wallet_id in (?, ?) and kind <> 'OPENING'`,
        walletIds,
      );
      expect(transactions?.n).toBe(3);

      // Cada evento das duas wallets chegou à fila de eventos exatamente uma vez, no grupo da wallet.
      const expected = await sql<{ id: string; message_group_id: string }>(
        'select id, message_group_id from outbox_messages where message_group_id in (?, ?)',
        walletIds,
      );
      const received: Message[] = [];
      for (;;) {
        const { Messages = [] } = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: events.main.url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            MessageSystemAttributeNames: ['All'],
          }),
        );
        if (Messages.length === 0) break;
        for (const m of Messages) {
          received.push(m);
          await client.send(
            new DeleteMessageCommand({ QueueUrl: events.main.url, ReceiptHandle: m.ReceiptHandle }),
          );
        }
      }
      const ours = received.filter((m) =>
        walletIds.includes(m.Attributes?.MessageGroupId as string),
      );
      const eventIds = ours.map(
        (m) => (JSON.parse(m.Body as string) as { eventId: string }).eventId,
      );
      expect(eventIds.length).toBe(new Set(eventIds).size);
      expect(new Set(eventIds)).toEqual(new Set(expected.map((e) => e.id)));
    },
    TIMEOUT_MS,
  );
});
