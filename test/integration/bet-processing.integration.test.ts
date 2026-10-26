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

async function openWallet(cents: bigint, currency = 'BRL') {
  const playerId = `player-${randomUUID()}`;
  const wallet = await new OpenWallet(new MikroOrmWalletRepository(orm)).execute({
    playerId,
    initialBalance: Money.fromCents(cents, currency),
  });
  return { walletId: wallet.id, playerId };
}

function betOn(
  wallet: { walletId: string; playerId: string },
  cents: bigint,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId = `tx-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl(cents),
    ...overrides,
  };
}

const toWorker = (command: SubmitWagerTransactionCommand): WorkerCommand => ({
  ...command,
  money: command.money.toProps(),
});

/** Estado persistido de uma wallet, com o saldo reconstruído pelo ledger. */
async function walletState(walletId: string) {
  const [wallet] = await sql<{ balance: string; version: number; rebuilt: string; debits: number }>(
    `select w.balance_cents::text as balance, w.version,
            coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)::text as rebuilt,
            (count(*) filter (where e.direction = 'DEBIT'))::int as debits
       from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  const transactions = await sql<{
    id: string;
    status: string;
    failure_code: string | null;
    result_balance: string | null;
    entries: number;
  }>(
    `select t.id, t.status, t.failure_code, t.result_balance_cents::text as result_balance,
            (select count(*) from wallet_ledger_entries e where e.transaction_id = t.id)::int as entries
       from wager_transactions t where t.wallet_id = ? and t.kind = 'BET' order by t.created_at`,
    [walletId],
  );
  if (wallet === undefined) throw new Error(`wallet ${walletId} não existe no banco de teste.`);
  return { ...wallet, transactions };
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

/**
 * Executa cada lote em um processo Bun separado (`bet-worker.ts`), com seu próprio pool. Todos
 * conectam antes e só então recebem `GO`, para que as submissões disputem a wallet ao mesmo tempo.
 */
async function runInSeparateProcesses(batches: SubmitWagerTransactionCommand[][]) {
  const children = batches.map((batch) =>
    Bun.spawn([process.execPath, '--no-env-file', WORKER, JSON.stringify(batch.map(toWorker))], {
      env: process.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    }),
  );
  try {
    const readers = children.map((child) => lineReader(child.stdout));
    await Promise.all(readers.map((next) => next('READY')));
    for (const child of children) {
      child.stdin.write('GO\n');
      await child.stdin.end();
    }
    const lines = await Promise.all(readers.map((next) => next('RESULT ')));
    const codes = await Promise.all(children.map((child) => child.exited));
    expect(codes).toEqual(children.map(() => 0));
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

describe('BET no PostgreSQL', () => {
  test('processada: saldo, versão, transação, lançamento DEBIT e saldo observado gravados juntos', async () => {
    const wallet = await openWallet(10_000n);
    const command = betOn(wallet, 8_000n);

    const result = await submit.execute(command);

    expect(result.status).toBe(Processed);
    expect(result.balance.toProps()).toEqual({ amount: '20.00', currency: 'BRL' });
    const state = await walletState(wallet.walletId);
    expect(state).toMatchObject({ balance: '2000', version: 2, rebuilt: '2000', debits: 1 });
    expect(state.transactions).toEqual([
      {
        id: result.transactionId,
        status: Processed,
        failure_code: null,
        result_balance: '2000',
        entries: 1,
      },
    ]);
    const [row] = await sql<{ payload_hash: string; processed: boolean; key: string }>(
      `select payload_hash, processed_at is not null as processed, idempotency_key as key
         from wager_transactions where id = ?`,
      [result.transactionId],
    );
    expect(row).toEqual({
      payload_hash: computeWagerPayloadHash(command),
      processed: true,
      key: command.idempotencyKey,
    });
    const [entry] = await sql<{ before: string; after: string; money: string }>(
      `select balance_before_cents::text as before, balance_after_cents::text as after,
              money_cents::text as money
         from wallet_ledger_entries where transaction_id = ? and direction = 'DEBIT'`,
      [result.transactionId],
    );
    expect(entry).toEqual({ before: '10000', after: '2000', money: '8000' });
  });

  test('saldo insuficiente: REJECTED auditável, sem lançamento, saldo e versão intactos', async () => {
    const wallet = await openWallet(10_000n);

    const result = await submit.execute(betOn(wallet, 10_001n));

    expect(result).toMatchObject({ status: Rejected, failureCode: FailureCodes.InsufficientFunds });
    expect(result.balance.toProps()).toEqual({ amount: '100.00', currency: 'BRL' });
    const state = await walletState(wallet.walletId);
    expect(state).toMatchObject({ balance: '10000', version: 1, debits: 0 });
    expect(state.transactions).toEqual([
      {
        id: result.transactionId,
        status: Rejected,
        failure_code: 'INSUFFICIENT_FUNDS',
        result_balance: '10000',
        entries: 0,
      },
    ]);
  });

  test('moeda incompatível: REJECTED gravado na moeda da aposta, saldo na moeda da wallet', async () => {
    const wallet = await openWallet(10_000n);

    const result = await submit.execute(
      betOn(wallet, 100n, { money: Money.fromCents(100n, 'USD') }),
    );

    expect(result).toMatchObject({ status: Rejected, failureCode: FailureCodes.CurrencyMismatch });
    expect(result.balance.toProps()).toEqual({ amount: '100.00', currency: 'BRL' });
    const [row] = await sql<{ currency: string }>(
      'select currency from wager_transactions where id = ?',
      [result.transactionId],
    );
    expect(row?.currency).toBe('USD');
    expect((await walletState(wallet.walletId)).debits).toBe(0);
  });

  test('wallet inexistente: recusada sem gravar nada', async () => {
    const command = betOn({ walletId: randomUUID(), playerId: 'player-x' }, 100n);

    await expect(submit.execute(command)).rejects.toBeInstanceOf(WalletNotFoundError);
    const rows = await sql('select 1 from wager_transactions where idempotency_key = ?', [
      command.idempotencyKey,
    ]);
    expect(rows).toEqual([]);
  });
});

describe('atomicidade', () => {
  test(
    'falha no último INSERT (ledger) desfaz transação e saldo já enviados; o retry aplica uma vez',
    async () => {
      const wallet = await openWallet(10_000n);
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
      const command = betOn(wallet, 3_000n);
      try {
        // Ids: transação nova, lançamento com id já usado (falha real de PK no último comando).
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
        balance: '10000',
        version: 1,
        debits: 0,
        transactions: [],
      });

      // Nada foi confirmado: a mesma submissão, repetida, aplica o efeito exatamente uma vez.
      const retry = await submit.execute(command);
      expect(retry).toMatchObject({ status: Processed, idempotentReplay: false });
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '7000',
        version: 2,
        debits: 1,
      });
    },
    DATABASE_BOOTSTRAP_TIMEOUT_MS,
  );
});

describe('concorrência por wallet', () => {
  test(
    'cenário obrigatório: duas BETs de 80.00 sobre 100.00 em dois processos independentes',
    async () => {
      const wallet = await openWallet(10_000n);
      const bets = [betOn(wallet, 8_000n), betOn(wallet, 8_000n)];

      const { pids, results } = await runInSeparateProcesses(bets.map((bet) => [bet]));

      expect(new Set(pids).size).toBe(2);
      expect(new Set(pids).has(process.pid)).toBe(false);
      const outcomes = results.flat();
      expect(outcomes.every((r) => r.ok)).toBe(true);
      const ok = outcomes as Extract<WorkerResult, { ok: true }>[];
      expect(ok.map((r) => r.status).sort()).toEqual([Processed, Rejected]);
      expect(ok.find((r) => r.status === Rejected)?.failureCode).toBe('INSUFFICIENT_FUNDS');
      // Os dois observaram o saldo depois do único débito: o lock serializou as transações.
      expect(ok.map((r) => r.balance)).toEqual([
        { amount: '20.00', currency: 'BRL' },
        { amount: '20.00', currency: 'BRL' },
      ]);
      const state = await walletState(wallet.walletId);
      expect(state).toMatchObject({ balance: '2000', version: 2, rebuilt: '2000', debits: 1 });
      expect(state.transactions.map((t) => [t.status, t.entries]).sort()).toEqual([
        [Processed, 1],
        [Rejected, 0],
      ]);

      // Reentrega das duas mensagens: replays, nenhum débito novo.
      const replays = await Promise.all(bets.map((bet) => submitElsewhere.execute(bet)));
      expect(replays.every((r) => r.idempotentReplay)).toBe(true);
      expect(replays.map((r) => r.status).sort()).toEqual([Processed, Rejected]);
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '2000',
        version: 2,
        debits: 1,
      });
    },
    WORKERS_TIMEOUT_MS,
  );

  test(
    'três processos independentes, uma BET de 40.00 cada, sobre 100.00: duas aplicadas, uma rejeitada',
    async () => {
      const wallet = await openWallet(10_000n);

      const { pids, results } = await runInSeparateProcesses([
        [betOn(wallet, 4_000n)],
        [betOn(wallet, 4_000n)],
        [betOn(wallet, 4_000n)],
      ]);

      expect(new Set(pids).size).toBe(3);
      const ok = results.flat() as Extract<WorkerResult, { ok: true }>[];
      expect(ok.map((r) => r.status).sort()).toEqual([Processed, Processed, Rejected]);
      expect(await walletState(wallet.walletId)).toMatchObject({
        balance: '2000',
        version: 3,
        rebuilt: '2000',
        debits: 2,
      });
    },
    WORKERS_TIMEOUT_MS,
  );

  test('vinte BETs concorrentes de 10.00 sobre 100.00, por dois pools: saldo nunca negativo', async () => {
    const wallet = await openWallet(10_000n);
    const bets = Array.from({ length: 20 }, () => betOn(wallet, 1_000n));

    const results = await Promise.all(
      bets.map((bet, i) => (i % 2 === 0 ? submit : submitElsewhere).execute(bet)),
    );

    expect(results.filter((r) => r.status === Processed)).toHaveLength(10);
    const rejected = results.filter((r) => r.status === Rejected);
    expect(rejected).toHaveLength(10);
    expect(rejected.every((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(results.every((r) => !r.balance.isNegative())).toBe(true);
    expect(await walletState(wallet.walletId)).toMatchObject({
      balance: '0',
      version: 11,
      rebuilt: '0',
      debits: 10,
    });
    const [lowest] = await sql<{ min: string }>(
      'select min(balance_after_cents)::text as min from wallet_ledger_entries where wallet_id = ?',
      [wallet.walletId],
    );
    expect(lowest?.min).toBe('0');
  });

  test('wallets diferentes avançam em paralelo: o lock de uma não bloqueia a outra', async () => {
    const walletA = await openWallet(10_000n);
    const walletB = await openWallet(10_000n);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    // Outra unidade de trabalho segura o lock da wallet A, como uma transação longa.
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
    const betA = submit.execute(betOn(walletA, 1_000n)).finally(() => {
      settledA = true;
    });
    const resultB = await submit.execute(betOn(walletB, 1_000n));

    expect(resultB.status).toBe(Processed);
    // Com B já confirmada, A continua esperando o lock da sua wallet.
    await Bun.sleep(200);
    expect(settledA).toBe(false);
    release();
    await holder;
    expect((await betA).status).toBe(Processed);
    expect((await walletState(walletA.walletId)).balance).toBe('9000');
  });
});

describe('idempotência persistente', () => {
  test('duas submissões equivalentes simultâneas: um débito; a outra é replay do mesmo resultado', async () => {
    const wallet = await openWallet(10_000n);
    const command = betOn(wallet, 2_500n);

    const results = await Promise.all([submit.execute(command), submitElsewhere.execute(command)]);

    expect(results.map((r) => r.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0]?.transactionId).toBe(results[1]?.transactionId as string);
    expect(results[0]?.balance.equals(results[1]?.balance as Money)).toBe(true);
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '7500', debits: 1 });
  });

  test('replay devolve o saldo observado na época e funciona com outra instância do ORM', async () => {
    const wallet = await openWallet(10_000n);
    const command = betOn(wallet, 2_500n);
    const original = await submit.execute(command);
    await submit.execute(betOn(wallet, 1_000n));

    // ORM recém-criado: nenhum estado em memória da primeira execução (equivale a um reinício).
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
    expect(replay.balance.toProps()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '6500', debits: 2 });
  });

  test('mesma chave com payload diferente: conflito, sem novo efeito', async () => {
    const wallet = await openWallet(10_000n);
    const command = betOn(wallet, 2_500n);
    await submit.execute(command);

    await expect(submit.execute({ ...command, money: brl(2_600n) })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '7500', debits: 1 });
  });

  test('mesma chave com payload diferente, em paralelo e em wallets distintas: um efeito, um conflito', async () => {
    const walletA = await openWallet(10_000n);
    const walletB = await openWallet(10_000n);
    const command = betOn(walletA, 2_500n);
    // Mesma chave e mesma operação externa, mas outro payload (outra wallet e outro player).
    const other = { ...command, walletId: walletB.walletId, playerId: walletB.playerId };

    const settled = await Promise.allSettled([
      submit.execute(command),
      submitElsewhere.execute(other),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(IdempotencyConflictError);
    const debits =
      (await walletState(walletA.walletId)).debits + (await walletState(walletB.walletId)).debits;
    expect(debits).toBe(1);
    const rows = await sql('select 1 from wager_transactions where idempotency_key = ?', [
      command.idempotencyKey,
    ]);
    expect(rows).toHaveLength(1);
  });

  test('mesma operação externa com outra chave: recusada, sem novo efeito', async () => {
    const wallet = await openWallet(10_000n);
    const command = betOn(wallet, 2_500n);
    await submit.execute(command);

    await expect(
      submit.execute({ ...command, idempotencyKey: `${command.idempotencyKey}:retry` }),
    ).rejects.toBeInstanceOf(DuplicateExternalTransactionError);
    expect(await walletState(wallet.walletId)).toMatchObject({ balance: '7500', debits: 1 });
  });

  test('mesma operação externa com outra chave, em paralelo e em wallets distintas: um efeito', async () => {
    const walletA = await openWallet(10_000n);
    const walletB = await openWallet(10_000n);
    const command = betOn(walletA, 2_500n);
    const other = {
      ...command,
      idempotencyKey: `${command.idempotencyKey}:other`,
      walletId: walletB.walletId,
      playerId: walletB.playerId,
    };

    const settled = await Promise.allSettled([
      submit.execute(command),
      submitElsewhere.execute(other),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DuplicateExternalTransactionError);
    const debits =
      (await walletState(walletA.walletId)).debits + (await walletState(walletB.walletId)).debits;
    expect(debits).toBe(1);
  });
});

describe('reconciliação após os testes', () => {
  test('em todas as wallets, o saldo materializado é igual ao reconstruído pelo ledger', async () => {
    const divergent = await sql<{ id: string }>(
      `select w.id from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
        group by w.id, w.balance_cents
       having w.balance_cents <>
              coalesce(sum(case e.direction when 'CREDIT' then e.money_cents else -e.money_cents end), 0)`,
    );
    expect(divergent).toEqual([]);
    const [negative] = await sql<{ count: number }>(
      'select count(*)::int as count from wallets where balance_cents < 0',
    );
    expect(negative?.count).toBe(0);
  });

  test('toda BET PROCESSED tem exatamente um DEBIT; toda BET REJECTED não tem lançamento', async () => {
    const inconsistent = await sql<{ id: string }>(
      `select t.id from wager_transactions t
         left join wallet_ledger_entries e on e.transaction_id = t.id
        where t.kind = 'BET'
        group by t.id, t.status
       having (t.status = 'PROCESSED' and (count(e.id) <> 1 or bool_or(e.direction <> 'DEBIT')))
           or (t.status = 'REJECTED' and count(e.id) <> 0)`,
    );
    expect(inconsistent).toEqual([]);
  });
});
