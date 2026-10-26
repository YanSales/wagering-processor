import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { FailureCodes } from '../../src/application/failure-codes';
import { OpenWallet } from '../../src/application/open-wallet';
import { computeWagerPayloadHash } from '../../src/application/payload-hash';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  type SubmissionResult,
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
  UnsupportedSubmissionError,
} from '../../src/application/submit-wager-transaction';
import { WalletNotFoundError } from '../../src/application/wager-transaction-repository';
import { AmountOutOfStorageRangeError } from '../../src/application/wallet-repository';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import {
  MikroOrmWalletRepository,
  PG_BIGINT_MAX,
} from '../../src/database/repositories/wallet.repository';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import type { WorkerCommand, WorkerResult } from '../support/bet-worker';
import { assertTestDatabaseEnv, DATABASE_BOOTSTRAP_TIMEOUT_MS } from '../support/test-database';

// Grava no banco de teste (migrations reais aplicadas); recusa qualquer banco que não seja *_test.
assertTestDatabaseEnv();

const { Processed, Rejected } = WagerTransactionStatus;
const WORKER = fileURLToPath(new URL('../support/bet-worker.ts', import.meta.url));
const WORKERS_TIMEOUT_MS = 30_000;
const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');

// Duas instâncias do MikroORM, com pools independentes, no mesmo processo de teste.
let orm: MikroORM;
let otherOrm: MikroORM;
let submit: SubmitWagerTransaction;
let submitElsewhere: SubmitWagerTransaction;

const sql = <T>(query: string, params: unknown[] = []) =>
  orm.em.getConnection().execute(query, params) as Promise<T[]>;

async function openWallet(cents: bigint, currency = 'BRL') {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: Money.fromCents(cents, currency),
  });
  return { walletId: wallet.id, playerId };
}

function submission(
  kind: WagerTransactionKind,
  wallet: { walletId: string; playerId: string },
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

const winOn = (w: { walletId: string; playerId: string }, c: bigint, o = {}) =>
  submission(WagerTransactionKind.Win, w, c, o);
const betOn = (w: { walletId: string; playerId: string }, c: bigint, o = {}) =>
  submission(WagerTransactionKind.Bet, w, c, o);

/** Estado persistido de uma wallet, com o saldo reconstruído pelo ledger. */
async function walletState(walletId: string) {
  const [wallet] = await sql<{
    balance: string;
    version: number;
    rebuilt: string;
    credits: number;
    debits: number;
    lowest: string;
  }>(
    `select w.balance_cents::text as balance, w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)::text as rebuilt,
            (count(*) filter (where e.direction = 'CREDIT'))::int as credits,
            (count(*) filter (where e.direction = 'DEBIT'))::int as debits,
            coalesce(min(e.balance_after_cents), 0)::text as lowest
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  if (wallet === undefined) throw new Error(`wallet ${walletId} não existe no banco de teste.`);
  return wallet;
}

async function transactionRow(id: string) {
  const [row] = await sql<{
    kind: string;
    status: string;
    failure_code: string | null;
    result_balance: string;
    payload_hash: string;
    processed: boolean;
    entries: number;
  }>(
    `select t.kind, t.status, t.failure_code, t.result_balance_cents::text as result_balance,
            t.payload_hash, t.processed_at is not null as processed,
            (select count(*) from wallet_ledger_entries e where e.transaction_id = t.id)::int as entries
       from wager_transactions t where t.id = ?`,
    [id],
  );
  return row;
}

/** Lê linhas de um stream de processo até achar uma que comece com `prefix`. */
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
      if (done) throw new Error(`o worker encerrou antes de "${prefix}".`);
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

/** Executa cada lote num processo Bun separado (`bet-worker.ts`), sincronizados por READY/GO. */
async function runInSeparateProcesses(batches: SubmitWagerTransactionCommand[][]) {
  const children = batches.map((batch) =>
    Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        WORKER,
        JSON.stringify(batch.map((c): WorkerCommand => ({ ...c, money: c.money.toProps() }))),
      ],
      { env: process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    ),
  );
  try {
    const readers = children.map((child) => lineReader(child.stdout));
    await Promise.all(readers.map((next) => next('READY')));
    for (const child of children) {
      child.stdin.write('GO\n');
      await child.stdin.end();
    }
    const lines = await Promise.all(readers.map((next) => next('RESULT ')));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual(children.map(() => 0));
    return {
      pids: children.map((child) => child.pid),
      results: lines.map((line) => JSON.parse(line.slice('RESULT '.length)) as WorkerResult[]),
    };
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig());
  await orm.migrator.up();
  otherOrm = await MikroORM.init(createOrmConfig());
  submit = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm));
  submitElsewhere = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(otherOrm));
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

afterAll(async () => {
  await otherOrm?.close(true);
  await orm?.close(true);
}, DATABASE_BOOTSTRAP_TIMEOUT_MS);

describe('WIN no PostgreSQL', () => {
  test('processado: crédito, versão, CREDIT e saldo observado gravados juntos', async () => {
    const wallet = await openWallet(2_000n);
    const command = winOn(wallet, 5_000n);

    const result = await submit.execute(command);

    expect(result).toMatchObject({ status: Processed, idempotentReplay: false });
    expect(result.balance.toProps()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '7000',
      version: 2,
      rebuilt: '7000',
      credits: 2, // OPENING e WIN
      debits: 0,
    });
    expect(await transactionRow(result.transactionId)).toEqual({
      kind: 'WIN',
      status: Processed,
      failure_code: null,
      result_balance: '7000',
      payload_hash: computeWagerPayloadHash(command),
      processed: true,
      entries: 1,
    });
    const [entry] = await sql<{ direction: string; before: string; after: string }>(
      `select direction, balance_before_cents::text as before, balance_after_cents::text as after
         from wallet_ledger_entries where transaction_id = ?`,
      [result.transactionId],
    );
    expect(entry).toEqual({ direction: 'CREDIT', before: '2000', after: '7000' });
  });

  test('wallet com saldo zero (sem OPENING) recebe o crédito', async () => {
    const wallet = await openWallet(0n);

    const result = await submit.execute(winOn(wallet, 1_000n));

    expect(result.status).toBe(Processed);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '1000',
      rebuilt: '1000',
      credits: 1,
    });
  });

  test.each([
    ['moeda incompatível', { money: Money.fromCents(100n, 'USD') }, FailureCodes.CurrencyMismatch],
    ['wallet de outro player', { playerId: 'outro-player' }, FailureCodes.PlayerWalletMismatch],
  ])('%s: REJECTED gravado, sem crédito nem lançamento', async (_case, overrides, code) => {
    const wallet = await openWallet(2_000n);

    const result = await submit.execute(winOn(wallet, 100n, overrides));

    expect(result).toMatchObject({ status: Rejected, failureCode: code });
    expect(result.balance.toProps()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(await transactionRow(result.transactionId)).toMatchObject({
      status: Rejected,
      failure_code: code,
      result_balance: '2000',
      entries: 0,
    });
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '2000', version: 1 });
  });

  test('WIN que levaria o saldo acima do bigint do PostgreSQL: recusado, nada gravado', async () => {
    const wallet = await openWallet(PG_BIGINT_MAX);
    const command = winOn(wallet, 1n);

    await expect(submit.execute(command)).rejects.toBeInstanceOf(AmountOutOfStorageRangeError);
    expect(
      await sql('select 1 from wager_transactions where idempotency_key = ?', [
        command.idempotencyKey,
      ]),
    ).toEqual([]);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: PG_BIGINT_MAX.toString(),
      version: 1,
      credits: 1,
    });
  });

  test('wallet inexistente: recusado sem gravar nada', async () => {
    const command = winOn({ walletId: randomUUID(), playerId: 'player-x' }, 100n);

    await expect(submit.execute(command)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(
      await sql('select 1 from wager_transactions where idempotency_key = ?', [
        command.idempotencyKey,
      ]),
    ).toEqual([]);
  });

  test('WIN com referência: recusado sem gravar nada', async () => {
    const wallet = await openWallet(2_000n);
    const bet = betOn(wallet, 1_000n);
    await submit.execute(bet);
    const command = winOn(wallet, 3_000n, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    await expect(submit.execute(command)).rejects.toBeInstanceOf(UnsupportedSubmissionError);
    expect(
      await sql('select 1 from wager_transactions where idempotency_key = ?', [
        command.idempotencyKey,
      ]),
    ).toEqual([]);
    expect((await walletState(wallet.walletId)).balance).toBe('1000');
  });
});

describe('WIN: atomicidade', () => {
  test(
    'falha no último INSERT (ledger) desfaz transação e crédito já enviados; o retry aplica uma vez',
    async () => {
      const wallet = await openWallet(2_000n);
      const [taken] = await sql<{ id: string }>(
        'select id from wallet_ledger_entries order by created_at limit 1',
      );
      const queries: string[] = [];
      const logged = await MikroORM.init({
        ...createOrmConfig(),
        debug: ['query'],
        colors: false,
        logger: (message: string) => queries.push(message),
      });
      const command = winOn(wallet, 3_000n);
      try {
        const ids = [randomUUID(), taken?.id as string];
        const failing = new SubmitWagerTransaction(
          new MikroOrmWagerTransactionRepository(logged),
          () => new Date(),
          () => ids.shift() as string,
        );

        const error = await failing.execute(command).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UniqueConstraintViolationException);
        expect((error as { constraint?: string }).constraint).toBe('wallet_ledger_entries_pkey');
        const sequence = queries
          .map(
            (q) =>
              q.match(
                /\[query\] (begin|commit|rollback|insert into "\w+"|update "\w+"|select .* for update)/,
              )?.[1],
          )
          .filter(Boolean)
          .map((q) => (q?.startsWith('select') ? 'select … for update' : q));
        expect(sequence).toEqual([
          'begin',
          'select … for update',
          'insert into "wager_transactions"',
          'update "wallets"',
          'insert into "wallet_ledger_entries"',
          'rollback',
        ]);
      } finally {
        await logged.close(true);
      }
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '2000',
        version: 1,
        credits: 1,
      });

      const retry = await submit.execute(command);
      expect(retry).toMatchObject({ status: Processed, idempotentReplay: false });
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '5000',
        version: 2,
        credits: 2,
      });
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );
});

describe('WIN: concorrência', () => {
  test('vinte WINs simultâneos de 1.00, por dois pools: nenhum crédito perdido', async () => {
    const wallet = await openWallet(0n);
    const wins = Array.from({ length: 20 }, () => winOn(wallet, 100n));

    const results = await Promise.all(
      wins.map((w, i) => (i % 2 === 0 ? submit : submitElsewhere).execute(w)),
    );

    expect(results.every((r) => r.status === Processed)).toBe(true);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '2000',
      version: 21,
      rebuilt: '2000',
      credits: 20,
    });
  });

  test('BETs e WINs simultâneos na mesma wallet: saldo nunca negativo e igual ao ledger', async () => {
    const wallet = await openWallet(5_000n);
    const operations = [
      ...Array.from({ length: 10 }, () => betOn(wallet, 1_000n)),
      ...Array.from({ length: 10 }, () => winOn(wallet, 1_000n)),
    ];

    const results = await Promise.all(
      operations.map((op, i) => (i % 2 === 0 ? submit : submitElsewhere).execute(op)),
    );

    const processedBets = results.filter(
      (r, i) => operations[i]?.kind === WagerTransactionKind.Bet && r.status === Processed,
    ).length;
    expect(
      results
        .filter((_result, i) => operations[i]?.kind === WagerTransactionKind.Win)
        .every((r) => r.status === Processed),
    ).toBe(true);
    const rejected = results.filter((r) => r.status === Rejected);
    expect(rejected.every((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    // Com 50.00 iniciais e 10 BETs de 10.00, pelo menos 5 BETs passam em qualquer ordem.
    expect(processedBets).toBeGreaterThanOrEqual(5);
    const expected = 5_000n + 10_000n - 1_000n * BigInt(processedBets);
    const state = await walletState(wallet.walletId);
    expect(state).toMatchObject({
      balance: expected.toString(),
      rebuilt: expected.toString(),
      version: 1 + 10 + processedBets,
      credits: 11,
      debits: processedBets,
    });
    expect(BigInt(state.lowest) >= 0n).toBe(true);
  });

  test(
    'três processos independentes, um WIN de 10.00 cada: os três créditos aplicados',
    async () => {
      const wallet = await openWallet(0n);

      const { pids, results } = await runInSeparateProcesses([
        [winOn(wallet, 1_000n)],
        [winOn(wallet, 1_000n)],
        [winOn(wallet, 1_000n)],
      ]);

      expect(new Set(pids).size).toBe(3);
      const ok = results.flat() as Extract<WorkerResult, { ok: true }>[];
      expect(ok.map((r) => r.status)).toEqual([Processed, Processed, Processed]);
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '3000',
        version: 4,
        rebuilt: '3000',
        credits: 3,
      });
    },
    WORKERS_TIMEOUT_MS,
  );

  test('wallets diferentes avançam em paralelo: o lock de uma não bloqueia o WIN da outra', async () => {
    const walletA = await openWallet(1_000n);
    const walletB = await openWallet(1_000n);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = otherOrm.em.fork().transactional(async (em) => {
      await em
        .getConnection()
        .execute(
          'select id from wallets where id = ? for update',
          [walletA.walletId],
          'all',
          em.getTransactionContext(),
        );
      signalLocked();
      await released;
    });
    await locked;

    let settledA = false;
    const winA = submit.execute(winOn(walletA, 500n)).finally(() => {
      settledA = true;
    });
    const resultB = await submit.execute(winOn(walletB, 500n));

    expect(resultB.status).toBe(Processed);
    await Bun.sleep(200);
    expect(settledA).toBe(false);
    release();
    await holder;
    expect((await winA).status).toBe(Processed);
    expect((await walletState(walletA.walletId)).balance).toBe('1500');
  });
});

describe('WIN: idempotência persistente', () => {
  test('dois WINs equivalentes simultâneos: um crédito; o outro é replay', async () => {
    const wallet = await openWallet(0n);
    const command = winOn(wallet, 2_500n);

    const results = await Promise.all([submit.execute(command), submitElsewhere.execute(command)]);

    expect(results.map((r) => r.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0]?.transactionId).toBe(results[1]?.transactionId as string);
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '2500', credits: 1 });
  });

  test('replay devolve o saldo observado na época, mesmo com outra instância do ORM', async () => {
    const wallet = await openWallet(0n);
    const command = winOn(wallet, 2_500n);
    const original = await submit.execute(command);
    await submit.execute(winOn(wallet, 1_000n));

    const restarted = await MikroORM.init(createOrmConfig());
    let replay: SubmissionResult;
    try {
      replay = await new SubmitWagerTransaction(
        new MikroOrmWagerTransactionRepository(restarted),
      ).execute(command);
    } finally {
      await restarted.close(true);
    }

    expect(replay).toMatchObject({
      transactionId: original.transactionId,
      status: Processed,
      idempotentReplay: true,
    });
    expect(replay.balance.toProps()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '3500', credits: 2 });
  });

  test('mesma chave com payload diferente: conflito, sem novo crédito', async () => {
    const wallet = await openWallet(0n);
    const command = winOn(wallet, 2_500n);
    await submit.execute(command);

    await expect(submit.execute({ ...command, money: brl(2_600n) })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '2500', credits: 1 });
  });

  test('mesma operação externa com outra chave: recusada, sem novo crédito', async () => {
    const wallet = await openWallet(0n);
    const command = winOn(wallet, 2_500n);
    await submit.execute(command);

    await expect(
      submit.execute({ ...command, idempotencyKey: `${command.idempotencyKey}:retry` }),
    ).rejects.toBeInstanceOf(DuplicateExternalTransactionError);
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '2500', credits: 1 });
  });

  test('o id externo de uma BET não pode ser reaproveitado por um WIN', async () => {
    const wallet = await openWallet(5_000n);
    const bet = betOn(wallet, 1_000n);
    await submit.execute(bet);

    await expect(
      submit.execute({
        ...bet,
        kind: WagerTransactionKind.Win,
        idempotencyKey: `${bet.idempotencyKey}:win`,
      }),
    ).rejects.toBeInstanceOf(DuplicateExternalTransactionError);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '4000',
      credits: 1,
      debits: 1,
    });
  });
});

describe('reconciliação após os testes de WIN', () => {
  test('todo WIN PROCESSED tem exatamente um CREDIT; todo WIN REJECTED não tem lançamento', async () => {
    const inconsistent = await sql<{ id: string }>(
      `select t.id from wager_transactions t
         left join wallet_ledger_entries e on e.transaction_id = t.id
        where t.kind = 'WIN'
        group by t.id, t.status
       having (t.status = 'PROCESSED' and (count(e.id) <> 1 or bool_or(e.direction <> 'CREDIT')))
           or (t.status = 'REJECTED' and count(e.id) <> 0)`,
    );
    expect(inconsistent).toEqual([]);
  });

  test('em todas as wallets, o saldo materializado é igual ao reconstruído pelo ledger', async () => {
    const divergent = await sql<{ id: string }>(
      `select w.id from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
        group by w.id, w.balance_cents
       having w.balance_cents <>
              coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)`,
    );
    expect(divergent).toEqual([]);
  });
});
