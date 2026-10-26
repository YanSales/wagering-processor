import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../src/application/open-wallet';
import { OutboxRetryPolicy } from '../../src/application/outbox/outbox-retry-policy';
import {
  type ClaimedOutboxMessage,
  type EventPublisher,
  PublishOutbox,
} from '../../src/application/outbox/publish-outbox';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmOutboxRepository } from '../../src/database/repositories/outbox.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// Grava no banco de teste (migrations reais aplicadas); recusa qualquer banco que não seja *_test.
// O broker é um registro em memória: aqui se testa o protocolo de reserva e marcação no PostgreSQL
// real. O envio ao SQS real está em `test/sqs/outbox-publisher.sqs.test.ts`.
assertTestDatabaseEnv();

const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');

// Duas instâncias do MikroORM, com pools independentes: dois publishers como em duas instâncias.
let orm: MikroORM;
let otherOrm: MikroORM;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Broker em memória: registra cada envio aceito (com quem enviou) e pode recusar alguns. */
class RecordingBroker {
  readonly sent: { id: string; group: string; by: string }[] = [];
  readonly failing = new Set<string>();

  as(name: string, delayMs = 0): EventPublisher {
    return {
      publish: async (message: ClaimedOutboxMessage) => {
        if (delayMs > 0) await sleep(delayMs);
        if (this.failing.has(message.id)) {
          throw Object.assign(new Error('fila indisponível'), { name: 'SimulatedSqsOutage' });
        }
        this.sent.push({ id: message.id, group: message.messageGroupId, by: name });
      },
    };
  }

  of(walletId: string): string[] {
    return this.sent.filter((s) => s.group === walletId).map((s) => s.id);
  }
}

function publisher(
  target: MikroORM,
  broker: EventPublisher,
  overrides: Partial<ConstructorParameters<typeof PublishOutbox>[2]> = {},
) {
  return new PublishOutbox(new MikroOrmOutboxRepository(target), broker, {
    maxGroups: 50,
    maxPerGroup: 50,
    leaseMs: 30_000,
    policy: OutboxRetryPolicy.from({ baseDelayMs: 300, maxDelayMs: 1_000 }),
    ...overrides,
  });
}

/** Rodadas até não haver nada vencido e livre. */
async function drain(p: PublishOutbox): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) {
    if ((await p.runOnce()).claimed === 0) return;
  }
  throw new Error('a outbox não esvaziou');
}

async function openWalletWithBets(bets: number): Promise<string> {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: brl(100_000n),
  });
  const submit = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm));
  for (let i = 0; i < bets; i += 1) {
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
      money: brl(1_000n),
    });
  }
  return wallet.id;
}

interface Row {
  id: string;
  attempts: number;
  last_error_code: string | null;
  published: boolean;
  claimed: boolean;
  due: boolean;
}

/** Eventos de uma wallet em ordem de `seq`, com o estado de publicação. */
const rowsOf = (walletId: string) =>
  sql<Row>(
    `select id, attempts, last_error_code, published_at is not null as published,
            claim_token is not null as claimed, next_attempt_at <= now() as due
       from outbox_messages where message_group_id = ? order by seq`,
    [walletId],
  );

const idsOf = async (walletId: string) => (await rowsOf(walletId)).map((r) => r.id);

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  otherOrm = await MikroORM.init(createOrmConfig());
  // O banco de teste é compartilhado: eventos deixados por outras suítes são "publicados" num broker
  // descartável, para que cada teste veja apenas os eventos das próprias wallets.
  await drain(publisher(orm, new RecordingBroker().as('setup'), { maxGroups: 1_000 }));
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await otherOrm?.close(true);
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('publisher da outbox com o PostgreSQL real', () => {
  test('publica cada evento uma vez, em ordem de seq por wallet, e só então o marca', async () => {
    const walletId = await openWalletWithBets(3);
    const broker = new RecordingBroker();

    await drain(publisher(orm, broker.as('p1')));

    const expected = await idsOf(walletId);
    expect(expected).toHaveLength(8); // abertura (2) + 3 BETs (2 cada)
    expect(broker.of(walletId)).toEqual(expected);
    for (const row of await rowsOf(walletId)) {
      expect(row).toMatchObject({ published: true, claimed: false, attempts: 0 });
    }

    // Nova rodada: nada a reenviar.
    await publisher(orm, broker.as('p1')).runOnce();
    expect(broker.of(walletId)).toEqual(expected);
  });

  test('falha no envio: não marca, reagenda com backoff e bloqueia só aquela wallet', async () => {
    const blocked = await openWalletWithBets(2);
    const free = await openWalletWithBets(1);
    const broker = new RecordingBroker();
    const [first, ...rest] = await idsOf(blocked);
    broker.failing.add(first as string);

    await drain(publisher(orm, broker.as('p1')));

    // A wallet livre sai inteira; a bloqueada não envia nada depois do evento que falhou.
    expect(broker.of(free)).toEqual(await idsOf(free));
    expect(broker.of(blocked)).toEqual([]);
    const [failed, ...waiting] = await rowsOf(blocked);
    expect(failed).toMatchObject({
      published: false,
      claimed: false,
      due: false,
      attempts: 1,
      last_error_code: 'SimulatedSqsOutage',
    });
    for (const row of waiting) expect(row).toMatchObject({ published: false, claimed: false });

    // O broker volta; depois do backoff (300 ms), a wallet sai inteira e em ordem.
    broker.failing.clear();
    await sleep(350);
    await drain(publisher(orm, broker.as('p1')));

    expect(broker.of(blocked)).toEqual([first as string, ...rest]);
    expect((await rowsOf(blocked)).every((r) => r.published)).toBe(true);
  });

  test('dois publishers concorrentes: cada evento uma única vez e em ordem por wallet', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWalletWithBets(3)));
    const broker = new RecordingBroker();
    // Lotes pequenos e envios lentos forçam várias rodadas intercaladas nos dois pools.
    const options = { maxGroups: 2, maxPerGroup: 3 };
    const p1 = publisher(orm, broker.as('p1', 2), options);
    const p2 = publisher(otherOrm, broker.as('p2', 2), options);

    for (let round = 0; round < 200; round += 1) {
      const [a, b] = await Promise.all([p1.runOnce(), p2.runOnce()]);
      if (a.claimed === 0 && b.claimed === 0) break;
    }

    const ids = broker.sent.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const walletId of wallets) {
      expect(broker.of(walletId)).toEqual(await idsOf(walletId));
    }
    expect(new Set(broker.sent.map((s) => s.by))).toEqual(new Set(['p1', 'p2']));
  });

  test('reserva de um publisher caído expira e outro assume; o antigo não marca mais', async () => {
    const walletId = await openWalletWithBets(1);
    const crashedStore = new MikroOrmOutboxRepository(orm);
    const crashedToken = randomUUID();
    // Publisher que reservou (e talvez tenha enviado) e caiu antes de marcar.
    const claimed = await crashedStore.claim({
      claimToken: crashedToken,
      maxGroups: 1_000,
      maxPerGroup: 50,
      leaseMs: 300,
    });
    const own = claimed.filter((m) => m.messageGroupId === walletId);
    expect(own.map((m) => m.id)).toEqual(await idsOf(walletId));

    // Enquanto a reserva vale, ninguém publica a wallet.
    const broker = new RecordingBroker();
    await publisher(otherOrm, broker.as('p2')).runOnce();
    expect(broker.of(walletId)).toEqual([]);

    // Expirada, outro publisher reenvia tudo, com os mesmos eventIds (at-least-once).
    await sleep(350);
    await drain(publisher(otherOrm, broker.as('p2')));
    expect(broker.of(walletId)).toEqual(await idsOf(walletId));

    // O publisher antigo, se voltar, não consegue marcar nem reagendar.
    expect(await crashedStore.markPublished(own[0]?.id as string, crashedToken)).toBe(false);
    expect(await crashedStore.scheduleRetry(own[0]?.id as string, crashedToken, 1, 'X')).toBe(
      false,
    );
  });
});
