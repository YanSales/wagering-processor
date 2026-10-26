import { describe, expect, test } from 'bun:test';
import { OutboxRetryPolicy } from '../../src/application/outbox/outbox-retry-policy';
import {
  type ClaimedOutboxMessage,
  type ClaimRequest,
  type EventPublisher,
  type OutboxStore,
  PublishOutbox,
} from '../../src/application/outbox/publish-outbox';

const message = (id: string, group: string, attempts = 0): ClaimedOutboxMessage => ({
  id,
  messageGroupId: group,
  eventType: 'WagerTransactionProcessed',
  payload: { eventId: id },
  attempts,
});

/** Store em memória que registra as chamadas; o comportamento do banco é testado na integração. */
class FakeStore implements OutboxStore {
  readonly calls: string[] = [];
  lostLease = new Set<string>();
  failMark = false;

  constructor(private readonly claimed: ClaimedOutboxMessage[]) {}

  async claim(request: ClaimRequest) {
    this.calls.push(`claim:${request.maxGroups}/${request.maxPerGroup}/${request.leaseMs}`);
    return this.claimed;
  }
  async markPublished(id: string) {
    if (this.failMark) throw new Error('db down');
    this.calls.push(`published:${id}`);
    return !this.lostLease.has(id);
  }
  async scheduleRetry(id: string, _token: string, delayMs: number, errorCode: string) {
    this.calls.push(`retry:${id}:${delayMs}:${errorCode}`);
    return true;
  }
  async release(token: string) {
    this.calls.push(`release:${token}`);
  }
}

class SimulatedOutage extends Error {
  override name = 'SimulatedOutage';
}

function publisherFailingOn(ids: string[], sent: string[]): EventPublisher {
  return {
    async publish(m) {
      if (ids.includes(m.id)) throw new SimulatedOutage();
      sent.push(m.id);
    },
  };
}

const options = { maxGroups: 5, maxPerGroup: 10, leaseMs: 1_000, newToken: () => 'token-1' };

describe('PublishOutbox.runOnce', () => {
  test('envia na ordem recebida e só marca depois do envio; libera a reserva ao fim', async () => {
    const store = new FakeStore([message('a1', 'A'), message('b1', 'B'), message('a2', 'A')]);
    const sent: string[] = [];

    const summary = await new PublishOutbox(store, publisherFailingOn([], sent), options).runOnce();

    expect(sent).toEqual(['a1', 'a2', 'b1']);
    expect(store.calls).toEqual([
      'claim:5/10/1000',
      'published:a1',
      'published:a2',
      'published:b1',
      'release:token-1',
    ]);
    expect(summary).toEqual({ claimed: 3, published: 3, failed: 0, leaseLost: 0, released: 0 });
  });

  test('falha no envio: reagenda com backoff, interrompe a wallet e segue com as outras', async () => {
    const store = new FakeStore([
      message('a1', 'A', 2),
      message('a2', 'A'),
      message('a3', 'A'),
      message('b1', 'B'),
    ]);
    const sent: string[] = [];
    const policy = OutboxRetryPolicy.from({ baseDelayMs: 100, maxDelayMs: 1_000 });
    const errors: string[] = [];

    const summary = await new PublishOutbox(store, publisherFailingOn(['a1'], sent), {
      ...options,
      policy,
      onError: (m) => errors.push(m.id),
    }).runOnce();

    // a1 tinha 2 falhas: 100 → 200 → 400 ms. a2 e a3 não saem antes dele.
    expect(sent).toEqual(['b1']);
    expect(store.calls).not.toContain('published:a1');
    expect(store.calls).toContain('retry:a1:400:SimulatedOutage');
    expect(errors).toEqual(['a1']);
    expect(summary).toEqual({ claimed: 4, published: 1, failed: 1, leaseLost: 0, released: 2 });
  });

  test('reserva perdida na marcação: a wallet para; as demais continuam', async () => {
    const store = new FakeStore([message('a1', 'A'), message('a2', 'A'), message('b1', 'B')]);
    store.lostLease.add('a1');
    const sent: string[] = [];

    const summary = await new PublishOutbox(store, publisherFailingOn([], sent), options).runOnce();

    expect(sent).toEqual(['a1', 'b1']);
    expect(summary).toMatchObject({ published: 1, leaseLost: 1, released: 1 });
  });

  test('nenhum envio começa depois de metade da reserva: o restante é liberado', async () => {
    const store = new FakeStore([message('a1', 'A'), message('a2', 'A'), message('b1', 'B')]);
    const sent: string[] = [];
    let clock = 0;
    const publisher: EventPublisher = {
      async publish(m) {
        sent.push(m.id);
        clock += 600; // além de metade da reserva de 1 s
      },
    };

    const summary = await new PublishOutbox(store, publisher, {
      ...options,
      elapsed: () => clock,
    }).runOnce();

    expect(sent).toEqual(['a1']);
    expect(summary).toMatchObject({ claimed: 3, published: 1, released: 2 });
    expect(store.calls.at(-1)).toBe('release:token-1');
  });

  test('falha ao marcar sobe, mas a reserva é liberada', async () => {
    const store = new FakeStore([message('a1', 'A')]);
    store.failMark = true;

    const error = await new PublishOutbox(store, publisherFailingOn([], []), options)
      .runOnce()
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe('db down');
    expect(store.calls.at(-1)).toBe('release:token-1');
  });

  test('nada reservado: não libera nem envia', async () => {
    const store = new FakeStore([]);

    const summary = await new PublishOutbox(store, publisherFailingOn([], []), options).runOnce();

    expect(summary.claimed).toBe(0);
    expect(store.calls).toEqual(['claim:5/10/1000']);
  });
});

describe('OutboxRetryPolicy', () => {
  test('dobra a cada falha até o teto, sem limite de tentativas', () => {
    const policy = OutboxRetryPolicy.from({ baseDelayMs: 1_000, maxDelayMs: 60_000 });
    expect([0, 1, 2, 5, 6, 50, 10_000].map((n) => policy.delayAfterFailure(n))).toEqual([
      1_000, 2_000, 4_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });

  test('configuração inválida é recusada', () => {
    expect(() => OutboxRetryPolicy.from({ baseDelayMs: 0, maxDelayMs: 10 })).toThrow(RangeError);
    expect(() => OutboxRetryPolicy.from({ baseDelayMs: 20, maxDelayMs: 10 })).toThrow(RangeError);
  });
});
