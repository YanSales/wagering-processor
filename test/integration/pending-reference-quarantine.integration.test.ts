import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../src/application/open-wallet';
import {
  DEFAULT_REFERENCE_RETRY,
  ReferenceRetryPolicy,
} from '../../src/application/reference-retry-policy';
import {
  type ReprocessFailureStage,
  type ReprocessOptions,
  ReprocessPendingReferences,
  type ReprocessSummary,
} from '../../src/application/reprocess-pending-references';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/submit-wager-transaction';
import type { PendingReferenceRepository } from '../../src/application/wager-transaction-repository';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// Grava no banco de teste (migrations reais aplicadas); recusa qualquer banco que não seja *_test.
assertTestDatabaseEnv();

const { Processed, PendingReference } = WagerTransactionStatus;
const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
const policy = ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY);
// O cenário de starvation precisa de mais pendências (58) que o lote (50): o preparo e a rodada de 50
// tentativas reais, cada uma desfeita e adiada em transação própria, levam ~4 s sem carga.
const STARVATION_TIMEOUT_MS = 20_000;

let orm: MikroORM;
let otherOrm: MikroORM;
let thirdOrm: MikroORM;
let submit: SubmitWagerTransaction;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

type WalletRef = { walletId: string; playerId: string };
const usedWallets: string[] = [];

async function openWallet(cents = 10_000n): Promise<WalletRef> {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: brl(cents),
  });
  usedWallets.push(wallet.id);
  return { walletId: wallet.id, playerId };
}

function submission(
  kind: WagerTransactionKind,
  wallet: WalletRef,
  cents: bigint,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId = `${kind.toLowerCase()}-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(cents),
    ...overrides,
  };
}

const betOn = (w: WalletRef) => submission(WagerTransactionKind.Bet, w, 3_000n);
const refundOf = (w: WalletRef, bet: SubmitWagerTransactionCommand) =>
  submission(WagerTransactionKind.Refund, w, 3_000n, {
    referenceExternalTransactionId: bet.externalTransactionId,
  });

/** REFUND pendente numa wallet nova; a BET referenciada só é submetida quando o teste quiser. */
async function pendingRefund(submitter: SubmitWagerTransaction = submit) {
  const wallet = await openWallet();
  const bet = betOn(wallet);
  const refund = refundOf(wallet, bet);
  expect((await submitter.execute(refund)).status).toBe(PendingReference);
  const { id } = await row(refund.idempotencyKey);
  return { wallet, bet, refund, id };
}

type Fault = 'defect' | 'transient';

/**
 * Repositório real restrito às wallets do teste. As transações em `faults` falham dentro da
 * tentativa real (sob o lock, antes de gravar), e o PostgreSQL desfaz a transação de verdade: um
 * defeito de código (não transitório) ou um deadlock (transitório). `deferFails` faz o adiamento
 * falhar. Todo o resto é o caminho de produção.
 */
function repository(
  walletIds: string[],
  faults: Map<string, Fault> = new Map(),
  target: MikroORM = orm,
  deferFails = false,
): PendingReferenceRepository {
  const real = new MikroOrmWagerTransactionRepository(target);
  return {
    async findDuePendingReferences(now, limit) {
      const due = await real.findDuePendingReferences(now, 10_000);
      return due.filter((t) => walletIds.includes(t.walletId)).slice(0, limit);
    },
    resolvePendingReference: (task, now, decide) => {
      const fault = faults.get(task.transactionId);
      if (fault === undefined) return real.resolvePendingReference(task, now, decide);
      return real.resolvePendingReference(task, now, (state) => {
        decide(state);
        throw fault === 'defect'
          ? new TypeError('defeito simulado')
          : Object.assign(new Error('deadlock simulado'), { code: '40P01' });
      });
    },
    deferAfterFailure: (task, now, next) => {
      if (deferFails) {
        return Promise.reject(Object.assign(new Error('banco indisponível'), { code: '08006' }));
      }
      return real.deferAfterFailure(task, now, next);
    },
  };
}

function worker(
  pending: PendingReferenceRepository,
  now: () => Date,
  options: Partial<ReprocessOptions> = {},
): ReprocessPendingReferences {
  return new ReprocessPendingReferences(pending, { batchSize: 50, now, policy, ...options });
}

async function row(idempotencyKey: string) {
  const [found] = await sql<{
    id: string;
    status: string;
    failure_code: string | null;
    attempts: number;
    processing_failures: number;
    next_ms: string | null;
    entries: number;
  }>(
    `select t.id, t.status, t.failure_code, t.reference_attempts as attempts, t.processing_failures,
            (extract(epoch from t.next_reference_attempt_at) * 1000)::bigint::text as next_ms,
            (select count(*) from wallet_ledger_entries e where e.transaction_id = t.id)::int as entries
       from wager_transactions t where t.idempotency_key = ?`,
    [idempotencyKey],
  );
  if (found === undefined) throw new Error(`transação ${idempotencyKey} não gravada.`);
  return found;
}

async function walletState(walletId: string) {
  const [wallet] = await sql<{ balance: string; version: number; rebuilt: string }>(
    `select w.balance_cents::text as balance, w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)::text as rebuilt
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  if (wallet === undefined) throw new Error(`wallet ${walletId} não existe no banco de teste.`);
  return wallet;
}

/** Relógio que o teste avança; começa depois da primeira tentativa agendada (submissão + 2 s). */
function clockAt(ms: number) {
  const clock = { ms };
  return { clock, now: () => new Date(clock.ms) };
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  otherOrm = await MikroORM.init(createOrmConfig());
  thirdOrm = await MikroORM.init(createOrmConfig());
  submit = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm));
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await thirdOrm?.close(true);
  await otherOrm?.close(true);
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('quarentena de falhas operacionais do worker', () => {
  test('falha operacional: tentativa desfeita, quarentena com backoff, tentativas de resolução intactas', async () => {
    const { wallet, refund, id } = await pendingRefund();
    const before = await walletState(wallet.walletId);
    const pending = repository([wallet.walletId], new Map([[id, 'defect']]));
    const { clock, now } = clockAt(Date.now() + 3_000);
    const delays: number[] = [];

    for (let failure = 1; failure <= 3; failure++) {
      const summary = await worker(pending, now).runOnce();
      const stored = await row(refund.idempotencyKey);
      expect(summary).toMatchObject({ due: 1, failures: 1, deferred: 1, processed: 0 });
      expect(stored).toMatchObject({
        status: PendingReference,
        attempts: 0,
        processing_failures: failure,
        entries: 0,
      });
      delays.push(Number(stored.next_ms) - clock.ms);
      clock.ms = Number(stored.next_ms);
    }

    expect(delays).toEqual([2_000, 4_000, 8_000]);
    expect(await walletState(wallet.walletId)).toEqual(before);
  });

  test('15 falhas operacionais seguidas nunca produzem REFERENCE_NOT_FOUND; corrigida a causa, resolve e zera o contador', async () => {
    const { wallet, bet, refund, id } = await pendingRefund();
    const faults = new Map<string, Fault>([[id, 'defect']]);
    const pending = repository([wallet.walletId], faults);
    const { clock, now } = clockAt(Date.now() + 3_000);
    const delays: number[] = [];

    for (let failure = 1; failure <= 15; failure++) {
      await worker(pending, now).runOnce();
      const stored = await row(refund.idempotencyKey);
      expect(stored).toMatchObject({
        status: PendingReference,
        failure_code: null,
        attempts: 0,
        processing_failures: failure,
      });
      delays.push((Number(stored.next_ms) - clock.ms) / 1_000);
      clock.ms = Number(stored.next_ms);
    }
    // Mais falhas que o limite de 10 tentativas, todas com o backoff e o teto (5 min) da política.
    expect(delays).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300, 300, 300, 300, 300]);

    // A causa some (correção implantada) e a BET chega: a tentativa conclui e zera a quarentena.
    faults.clear();
    await submit.execute(bet);
    expect((await worker(pending, now).runOnce()).processed).toBe(1);
    expect(await row(refund.idempotencyKey)).toMatchObject({
      status: Processed,
      attempts: 1,
      processing_failures: 0,
      next_ms: null,
      entries: 1,
    });
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '10000',
      rebuilt: '10000',
    });
  });

  test('corrigida a causa sem a BET: a tentativa reagenda pela política de referência e zera a quarentena', async () => {
    const { wallet, refund, id } = await pendingRefund();
    const faults = new Map<string, Fault>([[id, 'defect']]);
    const pending = repository([wallet.walletId], faults);
    const { clock, now } = clockAt(Date.now() + 3_000);
    await worker(pending, now).runOnce();
    await worker(pending, now).runOnce(); // ainda em quarentena: não vencida, nada a fazer
    expect((await row(refund.idempotencyKey)).processing_failures).toBe(1);

    faults.clear();
    clock.ms = Number((await row(refund.idempotencyKey)).next_ms);
    expect((await worker(pending, now).runOnce()).rescheduled).toBe(1);

    const stored = await row(refund.idempotencyKey);
    expect(stored).toMatchObject({ status: PendingReference, attempts: 1, processing_failures: 0 });
    // 1 tentativa de resolução feita: espera de 2 s × 2^1.
    expect(Number(stored.next_ms) - clock.ms).toBe(4_000);
  });

  test(
    'starvation: 55 transações com defeito não impedem as saudáveis de avançar',
    async () => {
      // Relógios fixos: as 55 com defeito são submetidas em t0 e as saudáveis em t0 + 1 ms, então são
      // sempre as mais antigas (ordem por próxima tentativa), qualquer que seja a duração do preparo.
      // O worker roda as duas rodadas no mesmo instante, depois da primeira tentativa (t0 + 2 s).
      const t0 = Date.now();
      const submitAt = (ms: number) =>
        new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm), () => new Date(ms));
      const walletIds: string[] = [];
      const faults = new Map<string, Fault>();
      const defective = await Promise.all(
        Array.from({ length: 55 }, () => pendingRefund(submitAt(t0))),
      );
      for (const { wallet, id } of defective) {
        walletIds.push(wallet.walletId);
        faults.set(id, 'defect');
      }
      const healthy: SubmitWagerTransactionCommand[] = [];
      for (let i = 0; i < 3; i++) {
        const { wallet, bet, refund } = await pendingRefund(submitAt(t0 + 1));
        await submit.execute(bet);
        walletIds.push(wallet.walletId);
        healthy.push(refund);
      }
      const pending = repository(walletIds, faults);
      const { now } = clockAt(t0 + 3_000);

      // 1ª rodada: o lote (50) é todo de transações com defeito, as mais antigas; vão para a quarentena.
      const first = await worker(pending, now).runOnce();
      expect(first).toMatchObject({ due: 50, failures: 50, deferred: 50, processed: 0 });

      // 2ª rodada, mesmo instante: as adiadas saem do caminho, e as saudáveis são processadas.
      const second = await worker(pending, now).runOnce();
      expect(second).toMatchObject({ due: 8, failures: 5, deferred: 5, processed: 3 });
      for (const refund of healthy) {
        expect(await row(refund.idempotencyKey)).toMatchObject({
          status: Processed,
          processing_failures: 0,
        });
      }
      // Todas as 55 com defeito: em quarentena, nenhuma tentativa de resolução consumida.
      const [stuck] = await sql<{ count: number }>(
        `select count(*)::int as count from wager_transactions
        where id = any(string_to_array(?, ',')::uuid[])
          and status = 'PENDING_REFERENCE' and reference_attempts = 0 and processing_failures = 1`,
        [[...faults.keys()].join(',')],
      );
      expect(stuck?.count).toBe(55);
    },
    STARVATION_TIMEOUT_MS,
  );

  test('falha transitória: sem quarentena, sem consumir tentativa, linha intacta', async () => {
    const { wallet, refund, id } = await pendingRefund();
    const before = await row(refund.idempotencyKey);
    const pending = repository([wallet.walletId], new Map([[id, 'transient']]));
    const now = () => new Date(Date.now() + 3_000);

    for (let round = 0; round < 3; round++) {
      expect(await worker(pending, now).runOnce()).toMatchObject({
        transientFailures: 1,
        failures: 0,
        deferred: 0,
      });
    }

    expect(await row(refund.idempotencyKey)).toEqual(before);
  });

  test('falha ao gravar a quarentena: relatada, a linha continua vencida e as demais seguem', async () => {
    const broken = await pendingRefund();
    const healthy = await pendingRefund();
    await submit.execute(healthy.bet);
    const before = await row(broken.refund.idempotencyKey);
    const stages: [string, ReprocessFailureStage][] = [];
    const pending = repository(
      [broken.wallet.walletId, healthy.wallet.walletId],
      new Map([[broken.id, 'defect']]),
      orm,
      true,
    );

    const summary = await worker(pending, () => new Date(Date.now() + 3_000), {
      onError: (task, _error, stage) => stages.push([task.transactionId, stage]),
    }).runOnce();

    expect(summary).toMatchObject({ failures: 1, deferred: 0, deferFailures: 1, processed: 1 });
    expect(stages).toEqual([
      [broken.id, 'attempt'],
      [broken.id, 'defer'],
    ]);
    expect(await row(broken.refund.idempotencyKey)).toEqual(before);
    expect(await row(healthy.refund.idempotencyKey)).toMatchObject({ status: Processed });
  });

  describe('corridas com o adiamento, em ordem controlada', () => {
    /** Sessão do PostgreSQL esperando um lock, com quem a bloqueia. */
    interface Waiter {
      pid: number;
      blockers: number[];
      query: string;
    }

    interface Participant<T> {
      label: string;
      /** Reconhece a consulta do participante em `pg_stat_activity` enquanto ele espera o lock. */
      matches: (waiter: Waiter) => boolean;
      start: () => Promise<T>;
    }

    const isResolver = (w: Waiter) =>
      w.query.includes('reference_attempts') && w.query.includes('for update');
    const isDeferral = (w: Waiter) => w.query.includes('select processing_failures');

    async function lockWaiters(): Promise<Waiter[]> {
      return sql<Waiter>(
        `select pid, pg_blocking_pids(pid) as blockers, query from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and pid <> pg_backend_pid()`,
      );
    }

    /**
     * Espera uma condição observável no PostgreSQL: a sessão do participante bloqueada num lock. A
     * consulta se repete a cada 10 ms até 5 s; o intervalo não sincroniza nada, a condição sim.
     */
    async function waitForWaiter(label: string, match: (w: Waiter) => boolean): Promise<Waiter> {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = (await lockWaiters()).find(match);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`${label} não ficou esperando lock em 5 s.`);
        await Bun.sleep(10);
      }
    }

    /**
     * Segura o lock da linha numa transação real (sem escrever nada) até `release`, e enfileira
     * `first` e depois `second` atrás dela. Antes de liberar, confere a ordem pela estrutura dos
     * bloqueios, não por suposição: `first` espera a sessão que segura a linha, e `second` espera
     * `first` (quem está à frente na fila segura o lock da tupla). Só então libera e devolve os
     * resultados reais dos dois.
     */
    async function inOrder<A, B>(
      transactionId: string,
      first: Participant<A>,
      second: Participant<B>,
    ): Promise<[A, B]> {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holderPid = 0;
      let locked = () => {};
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = orm.em.fork().transactional(async (em) => {
        const ctx = em.getTransactionContext();
        const [me] = (await em
          .getConnection()
          .execute('select pg_backend_pid() as pid', [], 'all', ctx)) as { pid: number }[];
        holderPid = me?.pid ?? 0;
        await em
          .getConnection()
          .execute(
            'select id from wager_transactions where id = ? for update',
            [transactionId],
            'all',
            ctx,
          );
        locked();
        await released;
      });
      const running: Promise<unknown>[] = [holder];
      try {
        await holding;

        const firstRun = first.start();
        running.push(firstRun);
        const firstWaiter = await waitForWaiter(first.label, first.matches);
        expect(firstWaiter.blockers).toContain(holderPid);

        const secondRun = second.start();
        running.push(secondRun);
        const secondWaiter = await waitForWaiter(
          second.label,
          (w) => second.matches(w) && w.pid !== firstWaiter.pid,
        );
        // A ordem é verificada antes de liberar: o segundo está bloqueado pelo primeiro, e não o
        // contrário.
        expect(secondWaiter.blockers).toContain(firstWaiter.pid);
        expect(firstWaiter.blockers).not.toContain(secondWaiter.pid);

        release();
        await holder;
        return [await firstRun, await secondRun];
      } finally {
        release();
        await Promise.allSettled(running);
      }
    }

    const resolver = (walletId: string, due: Date): Participant<ReprocessSummary> => ({
      label: 'resolver',
      matches: isResolver,
      start: () => worker(repository([walletId], new Map(), otherOrm), () => due).runOnce(),
    });

    const deferral = (
      target: MikroORM,
      task: { transactionId: string; walletId: string },
      due: Date,
      label = 'adiamento',
    ): Participant<boolean> => ({
      label,
      matches: isDeferral,
      start: () =>
        new MikroOrmWagerTransactionRepository(target).deferAfterFailure(task, due, (failures) =>
          policy.nextAttemptAfterFailure(failures, due),
        ),
    });

    /** REFUND pendente e o instante em que ele vence (primeira tentativa agendada). */
    async function dueRefund(withBet: boolean) {
      const pending = await pendingRefund();
      if (withBet) await submit.execute(pending.bet);
      const due = new Date(Number((await row(pending.refund.idempotencyKey)).next_ms));
      const task = { transactionId: pending.id, walletId: pending.wallet.walletId };
      return { ...pending, due, task };
    }

    test('A: a resolução para PROCESSED vem antes; o adiamento não altera o registro', async () => {
      const { wallet, refund, id, due, task } = await dueRefund(true);

      const [summary, deferred] = await inOrder(
        id,
        resolver(wallet.walletId, due),
        deferral(thirdOrm, task, due),
      );

      expect(summary).toMatchObject({ due: 1, processed: 1, failures: 0 });
      expect(deferred).toBe(false);
      expect(await row(refund.idempotencyKey)).toMatchObject({
        status: Processed,
        attempts: 1,
        processing_failures: 0,
        next_ms: null,
        entries: 1,
      });
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '10000',
        rebuilt: '10000',
      });
    });

    test('B: a resolução reagenda para o futuro; o adiamento não sobrescreve a data nem o contador', async () => {
      const { wallet, refund, id, due, task } = await dueRefund(false);

      const [summary, deferred] = await inOrder(
        id,
        resolver(wallet.walletId, due),
        deferral(thirdOrm, task, due),
      );

      expect(summary).toMatchObject({ due: 1, rescheduled: 1, failures: 0 });
      expect(deferred).toBe(false);
      // Exatamente o que o resolver gravou: 1 tentativa de resolução, espera de 2 s × 2^1.
      expect(await row(refund.idempotencyKey)).toMatchObject({
        status: PendingReference,
        attempts: 1,
        processing_failures: 0,
        next_ms: String(due.getTime() + 4_000),
        entries: 0,
      });
    });

    test('C: o adiamento vem antes; o resolver encontra a linha não vencida, sem tentativa nem lançamento', async () => {
      const { wallet, refund, id, due, task } = await dueRefund(true);

      const [deferred, summary] = await inOrder(
        id,
        deferral(thirdOrm, task, due),
        resolver(wallet.walletId, due),
      );

      expect(deferred).toBe(true);
      expect(summary).toMatchObject({ due: 1, skipped: 1, processed: 0, failures: 0 });
      expect(await row(refund.idempotencyKey)).toMatchObject({
        status: PendingReference,
        attempts: 0,
        processing_failures: 1,
        next_ms: String(due.getTime() + 2_000),
        entries: 0,
      });
      // Só o débito da BET: o REFUND não creditou.
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '7000',
        rebuilt: '7000',
      });
    });

    test('D: dois adiamentos concorrentes; somente um altera o registro', async () => {
      const { refund, id, due, task } = await dueRefund(false);

      const results = await inOrder(
        id,
        deferral(otherOrm, task, due, 'primeiro adiamento'),
        deferral(thirdOrm, task, due, 'segundo adiamento'),
      );

      expect(results).toEqual([true, false]);
      expect(await row(refund.idempotencyKey)).toMatchObject({
        status: PendingReference,
        attempts: 0,
        processing_failures: 1,
        next_ms: String(due.getTime() + 2_000),
      });
    });
  });

  test('o adiamento não sobrescreve uma transição concluída nem uma linha ainda não vencida', async () => {
    const real = new MikroOrmWagerTransactionRepository(orm);
    const later = (failures: number) => new Date(Date.now() + 1_000_000 + failures);

    // Não vencida: a quarentena exige que a tentativa estivesse vencida no instante da falha.
    const waiting = await pendingRefund();
    const beforeWaiting = await row(waiting.refund.idempotencyKey);
    expect(
      await real.deferAfterFailure(
        { transactionId: waiting.id, walletId: waiting.wallet.walletId },
        new Date(Date.now() - 60_000),
        later,
      ),
    ).toBe(false);
    expect(await row(waiting.refund.idempotencyKey)).toEqual(beforeWaiting);

    // Concluída por outro worker: o estado terminal e o contador zerado permanecem.
    const done = await pendingRefund();
    await submit.execute(done.bet);
    const resolveNow = () => new Date(Date.now() + 3_000);
    await worker(repository([done.wallet.walletId]), resolveNow).runOnce();
    const beforeDone = await row(done.refund.idempotencyKey);
    expect(beforeDone.status).toBe(Processed);
    expect(
      await real.deferAfterFailure(
        { transactionId: done.id, walletId: done.wallet.walletId },
        resolveNow(),
        later,
      ),
    ).toBe(false);
    expect(await row(done.refund.idempotencyKey)).toEqual(beforeDone);
  });

  test('replay de uma transação em quarentena: o mesmo PENDING_REFERENCE, nada muda', async () => {
    const { wallet, refund, id } = await pendingRefund();
    await worker(
      repository([wallet.walletId], new Map([[id, 'defect']])),
      () => new Date(Date.now() + 3_000),
    ).runOnce();
    const quarantined = await row(refund.idempotencyKey);
    expect(quarantined.processing_failures).toBe(1);

    const replay = await submit.execute(refund);

    expect(replay).toMatchObject({
      transactionId: id,
      status: PendingReference,
      idempotentReplay: true,
    });
    expect(await row(refund.idempotencyKey)).toEqual(quarantined);
  });

  test('CHECKs: processing_failures não negativo e diferente de zero só em PENDING_REFERENCE', async () => {
    const { bet, refund } = await pendingRefund();
    await submit.execute(bet);

    await expect(
      sql('update wager_transactions set processing_failures = -1 where idempotency_key = ?', [
        refund.idempotencyKey,
      ]),
    ).rejects.toThrow('wager_transactions_processing_failures_check');
    await expect(
      sql('update wager_transactions set processing_failures = 1 where idempotency_key = ?', [
        bet.idempotencyKey,
      ]),
    ).rejects.toThrow('wager_transactions_processing_failures_pending_check');
    expect(
      await sql(
        'update wager_transactions set processing_failures = 2 where idempotency_key = ? returning id',
        [refund.idempotencyKey],
      ),
    ).toHaveLength(1);
  });

  test('reconciliação: em toda wallet usada, saldo armazenado = saldo reconstruído pelo ledger', async () => {
    expect(usedWallets.length).toBeGreaterThan(0);
    for (const walletId of usedWallets) {
      const state = await walletState(walletId);
      expect(state.rebuilt).toBe(state.balance);
    }
  });
});
