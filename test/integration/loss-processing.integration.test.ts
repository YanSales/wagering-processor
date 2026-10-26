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
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/database/repositories/wallet.repository';
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

type WalletRef = { walletId: string; playerId: string };

async function openWallet(cents: bigint): Promise<WalletRef> {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: brl(cents),
  });
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

const lossOn = (w: WalletRef, c: bigint, o: Partial<SubmitWagerTransactionCommand> = {}) =>
  submission(WagerTransactionKind.Loss, w, c, o);
const betOn = (w: WalletRef, c: bigint) => submission(WagerTransactionKind.Bet, w, c);
const winOn = (w: WalletRef, c: bigint) => submission(WagerTransactionKind.Win, w, c);

/** Estado persistido de uma wallet, com o saldo reconstruído pelo ledger. */
async function walletState(walletId: string) {
  const [wallet] = await sql<{
    balance: string;
    version: number;
    rebuilt: string;
    entries: number;
    debits: number;
  }>(
    `select w.balance_cents::text as balance, w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)::text as rebuilt,
            count(e.id)::int as entries,
            (count(*) filter (where e.direction = 'DEBIT'))::int as debits
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  if (wallet === undefined) throw new Error(`wallet ${walletId} não existe no banco de teste.`);
  const [losses] = await sql<{ count: number }>(
    "select count(*)::int as count from wager_transactions where wallet_id = ? and kind = 'LOSS'",
    [walletId],
  );
  return { ...wallet, losses: losses?.count ?? 0 };
}

async function transactionRow(id: string) {
  const [row] = await sql<{
    kind: string;
    status: string;
    failure_code: string | null;
    money: string;
    result_balance: string;
    payload_hash: string;
    processed: boolean;
    entries: number;
  }>(
    `select t.kind, t.status, t.failure_code, t.money_cents::text as money,
            t.result_balance_cents::text as result_balance, t.payload_hash,
            t.processed_at is not null as processed,
            (select count(*) from wallet_ledger_entries e where e.transaction_id = t.id)::int as entries
       from wager_transactions t where t.id = ?`,
    [id],
  );
  return row;
}

const rowsWithKey = (key: string) =>
  sql('select 1 from wager_transactions where idempotency_key = ?', [key]);

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

describe('LOSS no PostgreSQL', () => {
  test('processado: transação gravada, sem lançamento, saldo e versão inalterados', async () => {
    const wallet = await openWallet(2_000n);
    const command = lossOn(wallet, 5_000n);

    const result = await submit.execute(command);

    expect(result).toMatchObject({ status: Processed, idempotentReplay: false });
    expect(result.balance.toProps()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(await transactionRow(result.transactionId)).toEqual({
      kind: 'LOSS',
      status: Processed,
      failure_code: null,
      money: '5000',
      result_balance: '2000',
      payload_hash: computeWagerPayloadHash(command),
      processed: true,
      entries: 0,
    });
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '2000',
      version: 1,
      rebuilt: '2000',
      entries: 1, // só a OPENING
      losses: 1,
    });
  });

  test('valor zero é registrado como LOSS processado, sem lançamento', async () => {
    const wallet = await openWallet(2_000n);

    const result = await submit.execute(lossOn(wallet, 0n));

    expect(await transactionRow(result.transactionId)).toMatchObject({
      status: Processed,
      money: '0',
      entries: 0,
    });
  });

  test.each([
    ['moeda incompatível', { money: Money.fromCents(100n, 'USD') }, FailureCodes.CurrencyMismatch],
    ['wallet de outro player', { playerId: 'outro-player' }, FailureCodes.PlayerWalletMismatch],
  ])('%s: REJECTED gravado, sem lançamento', async (_case, overrides, code) => {
    const wallet = await openWallet(2_000n);

    const result = await submit.execute(lossOn(wallet, 100n, overrides));

    expect(result).toMatchObject({ status: Rejected, failureCode: code });
    expect(await transactionRow(result.transactionId)).toMatchObject({
      status: Rejected,
      failure_code: code,
      result_balance: '2000',
      entries: 0,
    });
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '2000', version: 1 });
  });

  test('wallet inexistente: recusado sem gravar nada', async () => {
    const command = lossOn({ walletId: randomUUID(), playerId: 'player-x' }, 100n);

    await expect(submit.execute(command)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(await rowsWithKey(command.idempotencyKey)).toEqual([]);
  });

  test('LOSS com referência (mesmo a uma BET existente): recusado sem gravar nada', async () => {
    const wallet = await openWallet(2_000n);
    const bet = betOn(wallet, 1_000n);
    await submit.execute(bet);
    const command = lossOn(wallet, 1_000n, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    await expect(submit.execute(command)).rejects.toBeInstanceOf(UnsupportedSubmissionError);
    expect(await rowsWithKey(command.idempotencyKey)).toEqual([]);
  });
});

describe('LOSS: atomicidade', () => {
  test(
    'falha ao gravar a transação: nada persiste, nenhum UPDATE da wallet; o retry registra uma vez',
    async () => {
      const wallet = await openWallet(2_000n);
      const [taken] = await sql<{ id: string }>(
        'select id from wager_transactions order by created_at limit 1',
      );
      const queries: string[] = [];
      const logged = await MikroORM.init({
        ...createOrmConfig(),
        debug: ['query'],
        colors: false,
        logger: (message: string) => queries.push(message),
      });
      const command = lossOn(wallet, 3_000n);
      try {
        // Id de transação já usado: falha real de PK no INSERT da transação.
        const ids = [taken?.id as string, randomUUID()];
        const failing = new SubmitWagerTransaction(
          new MikroOrmWagerTransactionRepository(logged),
          () => new Date(),
          () => ids.shift() as string,
        );

        const error = await failing.execute(command).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UniqueConstraintViolationException);
        expect((error as { constraint?: string }).constraint).toBe('wager_transactions_pkey');
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
          'rollback',
        ]);
      } finally {
        await logged.close(true);
      }
      expect(await rowsWithKey(command.idempotencyKey)).toEqual([]);
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '2000',
        version: 1,
        losses: 0,
      });

      const retry = await submit.execute(command);
      expect(retry).toMatchObject({ status: Processed, idempotentReplay: false });
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '2000',
        version: 1,
        losses: 1,
      });
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );
});

describe('LOSS: concorrência', () => {
  test('vinte LOSS simultâneos, por dois pools: vinte registros, saldo e versão intactos', async () => {
    const wallet = await openWallet(2_000n);
    const losses = Array.from({ length: 20 }, () => lossOn(wallet, 100n));

    const results = await Promise.all(
      losses.map((l, i) => (i % 2 === 0 ? submit : submitElsewhere).execute(l)),
    );

    expect(results.every((r) => r.status === Processed)).toBe(true);
    expect(results.every((r) => r.balance.cents === 2_000n)).toBe(true);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '2000',
      version: 1,
      entries: 1,
      losses: 20,
    });
  });

  test('LOSS simultâneos com BETs e WINs: saldo igual ao ledger e saldos observados reais', async () => {
    const wallet = await openWallet(5_000n);
    const operations = [
      ...Array.from({ length: 10 }, () => betOn(wallet, 1_000n)),
      ...Array.from({ length: 10 }, () => winOn(wallet, 1_000n)),
      ...Array.from({ length: 10 }, () => lossOn(wallet, 1_000n)),
    ];

    const results = await Promise.all(
      operations.map((op, i) => (i % 2 === 0 ? submit : submitElsewhere).execute(op)),
    );

    const kindOf = (i: number) => operations[i]?.kind;
    const processedBets = results.filter(
      (r, i) => kindOf(i) === WagerTransactionKind.Bet && r.status === Processed,
    ).length;
    const lossResults = results.filter((_r, i) => kindOf(i) === WagerTransactionKind.Loss);
    expect(lossResults.every((r) => r.status === Processed)).toBe(true);
    const expected = 5_000n + 10_000n - 1_000n * BigInt(processedBets);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: expected.toString(),
      rebuilt: expected.toString(),
      version: 1 + 10 + processedBets,
      entries: 1 + 10 + processedBets,
      losses: 10,
    });
    // Cada LOSS viu um saldo que de fato existiu: o saldo posterior de algum lançamento da wallet.
    const existed = new Set(
      (
        await sql<{ after: string }>(
          'select balance_after_cents::text as after from wallet_ledger_entries where wallet_id = ?',
          [wallet.walletId],
        )
      ).map((r) => r.after),
    );
    expect(lossResults.every((r) => existed.has(r.balance.cents.toString()))).toBe(true);
    const [lossEntries] = await sql<{ count: number }>(
      `select count(*)::int as count from wallet_ledger_entries e
         join wager_transactions t on t.id = e.transaction_id
        where t.wallet_id = ? and t.kind = 'LOSS'`,
      [wallet.walletId],
    );
    expect(lossEntries?.count).toBe(0);
  });

  test(
    'três processos independentes, um LOSS cada: três registros, saldo intacto',
    async () => {
      const wallet = await openWallet(2_000n);

      const { pids, results } = await runInSeparateProcesses([
        [lossOn(wallet, 1_000n)],
        [lossOn(wallet, 1_000n)],
        [lossOn(wallet, 1_000n)],
      ]);

      expect(new Set(pids).size).toBe(3);
      const ok = results.flat() as Extract<WorkerResult, { ok: true }>[];
      expect(ok.map((r) => r.status)).toEqual([Processed, Processed, Processed]);
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '2000',
        version: 1,
        entries: 1,
        losses: 3,
      });
    },
    WORKERS_TIMEOUT_MS,
  );

  // Com a wallet A travada por FOR UPDATE, o LOSS em A espera (pelo lock do repositório e, mesmo sem
  // ele, pelo FOR KEY SHARE da FK no INSERT da transação); o LOSS em B não espera.
  test('LOSS numa wallet travada espera; em outra wallet, não', async () => {
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
    const lossA = submit.execute(lossOn(walletA, 500n)).finally(() => {
      settledA = true;
    });
    const resultB = await submit.execute(lossOn(walletB, 500n));

    expect(resultB.status).toBe(Processed);
    await Bun.sleep(200);
    expect(settledA).toBe(false);
    release();
    await holder;
    expect((await lossA).status).toBe(Processed);
  });
});

describe('LOSS: idempotência persistente', () => {
  test('dois LOSS equivalentes simultâneos: um registro; o outro é replay', async () => {
    const wallet = await openWallet(2_000n);
    const command = lossOn(wallet, 2_500n);

    const results = await Promise.all([submit.execute(command), submitElsewhere.execute(command)]);

    expect(results.map((r) => r.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0]?.transactionId).toBe(results[1]?.transactionId as string);
    expect((await walletState(wallet.walletId)).losses).toBe(1);
  });

  test('replay devolve o saldo observado na época, mesmo com outra instância do ORM', async () => {
    const wallet = await openWallet(2_000n);
    const command = lossOn(wallet, 2_500n);
    const original = await submit.execute(command);
    await submit.execute(betOn(wallet, 500n));

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
    expect(replay.balance.toProps()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '1500', losses: 1 });
  });

  test('mesma chave com payload diferente: conflito, sem novo registro', async () => {
    const wallet = await openWallet(2_000n);
    const command = lossOn(wallet, 2_500n);
    await submit.execute(command);

    await expect(submit.execute({ ...command, money: brl(2_600n) })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect((await walletState(wallet.walletId)).losses).toBe(1);
  });

  test('mesma operação externa com outra chave: recusada, sem novo registro', async () => {
    const wallet = await openWallet(2_000n);
    const command = lossOn(wallet, 2_500n);
    await submit.execute(command);

    await expect(
      submit.execute({ ...command, idempotencyKey: `${command.idempotencyKey}:retry` }),
    ).rejects.toBeInstanceOf(DuplicateExternalTransactionError);
    expect((await walletState(wallet.walletId)).losses).toBe(1);
  });

  test('o id externo de uma BET não pode ser reaproveitado por um LOSS', async () => {
    const wallet = await openWallet(5_000n);
    const bet = betOn(wallet, 1_000n);
    await submit.execute(bet);

    await expect(
      submit.execute({
        ...bet,
        kind: WagerTransactionKind.Loss,
        idempotencyKey: `${bet.idempotencyKey}:loss`,
      }),
    ).rejects.toBeInstanceOf(DuplicateExternalTransactionError);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '4000',
      debits: 1,
      losses: 0,
    });
  });
});

describe('reconciliação após os testes de LOSS', () => {
  test('nenhum LOSS tem lançamento no ledger', async () => {
    const withEntries = await sql<{ id: string }>(
      `select t.id from wager_transactions t
         join wallet_ledger_entries e on e.transaction_id = t.id
        where t.kind = 'LOSS'`,
    );
    expect(withEntries).toEqual([]);
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
