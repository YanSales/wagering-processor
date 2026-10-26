import { describe, expect, test } from 'bun:test';
import { FailureCodes } from '../../src/application/failure-codes';
import { ReferenceRetryPolicy } from '../../src/application/reference-retry-policy';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
  UnsupportedSubmissionError,
} from '../../src/application/submit-wager-transaction';
import {
  type ExistingSubmissions,
  type ReferenceQuery,
  type ResolvedReference,
  type StoredSubmission,
  type SubmissionContext,
  type SubmissionDecision,
  type SubmissionKeys,
  type SubmissionOutcome,
  type WagerTransactionRepository,
  WalletNotFoundError,
} from '../../src/application/wager-transaction-repository';
import { Money } from '../../src/domain/money';
import {
  type WagerTransactionKind as Kind,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet, type WalletState } from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { brl, T0 } from '../support/wager-fixtures';

const { Processed, Rejected, PendingReference } = WagerTransactionStatus;

/**
 * Repositório em memória da porta: guarda wallets, submissões e lançamentos. Não simula a
 * concorrência do banco (coberta pelos testes de integração); serve para as regras do caso de uso.
 */
class InMemoryWagerTransactionRepository implements WagerTransactionRepository {
  readonly wallets = new Map<string, WalletState>();
  readonly submissions: StoredSubmission[] = [];
  readonly entries: WalletLedgerEntry[] = [];
  /** Transações decididas, para resolver referências como o banco faria. */
  readonly transactions: WagerTransaction[] = [];
  readonly schedules = new Map<string, Date>();
  /** Contexto recebido em cada chamada a `applyToLockedWallet`. */
  readonly contexts: SubmissionContext[] = [];
  decideCalls = 0;

  resolve(query: ReferenceQuery): ResolvedReference | null {
    const reference = this.transactions.find(
      (t) =>
        t.providerId === query.providerId &&
        t.externalTransactionId === query.externalTransactionId,
    );
    if (reference === undefined) return null;
    const alreadyReversed = this.transactions.some(
      (t) =>
        t.referenceTransactionId === reference.id &&
        t.kind === query.reversalKind &&
        t.status === WagerTransactionStatus.Processed,
    );
    return { transaction: reference, alreadyReversed };
  }

  addWallet(cents: bigint, currency = 'BRL', playerId = 'player-1', id = 'wallet-1') {
    this.wallets.set(id, {
      id,
      playerId,
      balance: Money.fromCents(cents, currency),
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
  }

  async findExisting(keys: SubmissionKeys): Promise<ExistingSubmissions> {
    return {
      byIdempotencyKey:
        this.submissions.find((s) => s.idempotencyKey === keys.idempotencyKey) ?? null,
      byExternalTransaction:
        this.submissions.find(
          (s) =>
            s.providerId === keys.providerId &&
            s.externalTransactionId === keys.externalTransactionId,
        ) ?? null,
    };
  }

  async applyToLockedWallet(
    walletId: string,
    keys: SubmissionKeys,
    context: SubmissionContext,
    decide: (wallet: Wallet, reference: ResolvedReference | null) => SubmissionDecision,
    query?: ReferenceQuery,
  ): Promise<SubmissionOutcome> {
    this.contexts.push(context);
    const state = this.wallets.get(walletId);
    if (state === undefined) throw new WalletNotFoundError(walletId);
    const existing = await this.findExisting(keys);
    if (existing.byIdempotencyKey !== null || existing.byExternalTransaction !== null) {
      return { kind: 'EXISTING', existing };
    }
    this.decideCalls += 1;
    const decision = decide(Wallet.rehydrate(state), query ? this.resolve(query) : null);
    const { transaction, wallet, ledgerEntry } = decision;
    this.transactions.push(transaction);
    if (decision.nextReferenceAttemptAt !== undefined) {
      this.schedules.set(transaction.id, decision.nextReferenceAttemptAt);
    }
    const submission: StoredSubmission = {
      transactionId: transaction.id,
      idempotencyKey: keys.idempotencyKey,
      payloadHash: transaction.payloadHash as string,
      providerId: keys.providerId,
      externalTransactionId: keys.externalTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      resultBalance: wallet.balance,
    };
    this.submissions.push(submission);
    if (ledgerEntry !== null) this.entries.push(ledgerEntry);
    this.wallets.set(walletId, {
      ...state,
      balance: wallet.balance,
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    });
    return { kind: 'APPLIED', submission };
  }
}

function setup() {
  const repository = new InMemoryWagerTransactionRepository();
  let sequence = 0;
  let correlations = 0;
  const useCase = new SubmitWagerTransaction(
    repository,
    () => T0,
    () => `id-${++sequence}`,
    undefined,
    () => `corr-${++correlations}`,
  );
  return { repository, useCase };
}

function bet(
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  return {
    idempotencyKey: 'provider-a:tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl(8_000n),
    ...overrides,
  };
}

describe('SubmitWagerTransaction: BET', () => {
  test('saldo suficiente: PROCESSED, saldo debitado e um lançamento DEBIT', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);

    const result = await useCase.execute(bet());

    expect(result).toEqual({
      transactionId: 'id-1',
      status: Processed,
      balance: expect.anything(),
      failureCode: undefined,
      idempotentReplay: false,
    });
    expect(result.balance.cents).toBe(2_000n);
    expect(repository.wallets.get('wallet-1')?.balance.cents).toBe(2_000n);
    expect(repository.wallets.get('wallet-1')?.version).toBe(2);
    expect(repository.entries).toHaveLength(1);
    expect(repository.entries[0]?.id).toBe('id-2');
    expect(repository.entries[0]?.direction).toBe('DEBIT');
  });

  test.each([
    ['saldo insuficiente', bet({ money: brl(10_001n) }), FailureCodes.InsufficientFunds],
    [
      'moeda incompatível',
      bet({ money: Money.fromCents(100n, 'USD') }),
      FailureCodes.CurrencyMismatch,
    ],
    ['wallet de outro player', bet({ playerId: 'player-2' }), FailureCodes.PlayerWalletMismatch],
  ])(
    '%s: REJECTED com failureCode, saldo inalterado e nenhum lançamento',
    async (_case, command, code) => {
      const { repository, useCase } = setup();
      repository.addWallet(10_000n);

      const result = await useCase.execute(command);

      expect(result.status).toBe(Rejected);
      expect(result.failureCode).toBe(code);
      expect(result.balance.cents).toBe(10_000n);
      expect(result.balance.currency).toBe('BRL');
      expect(repository.entries).toEqual([]);
      expect(repository.wallets.get('wallet-1')?.version).toBe(1);
      expect(repository.submissions.map((s) => s.status)).toEqual([Rejected]);
    },
  );

  test('os códigos de falha são distintos', () => {
    const codes = Object.values(FailureCodes);

    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('SubmitWagerTransaction: idempotência', () => {
  test('mesma chave e mesmo payload: replay do resultado original, sem novo efeito', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    const first = await useCase.execute(bet());
    // Outra aposta muda o saldo; o replay ainda devolve o saldo observado na primeira (§7, regra 7).
    await useCase.execute(
      bet({ idempotencyKey: 'k-2', externalTransactionId: 'tx-2', money: brl(1_000n) }),
    );

    const replay = await useCase.execute(bet());

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance.cents).toBe(2_000n);
    expect(repository.entries).toHaveLength(2);
    expect(repository.decideCalls).toBe(2);
  });

  test('replay de uma rejeição devolve a mesma rejeição', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(1_000n);
    const first = await useCase.execute(bet());

    const replay = await useCase.execute(bet());

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.failureCode).toBe(FailureCodes.InsufficientFunds);
  });

  test('a ordem das propriedades do comando não altera o payload', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    await useCase.execute(bet());
    const reordered = Object.fromEntries(
      Object.entries(bet()).reverse(),
    ) as unknown as SubmitWagerTransactionCommand;

    expect((await useCase.execute(reordered)).idempotentReplay).toBe(true);
  });

  test('mesma chave com payload diferente: conflito, sem novo efeito', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    await useCase.execute(bet());

    await expect(useCase.execute(bet({ money: brl(1_000n) }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(repository.entries).toHaveLength(1);
    expect(repository.submissions).toHaveLength(1);
  });

  test('mesma operação externa com outra chave: recusada, sem novo efeito', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    await useCase.execute(bet());

    await expect(useCase.execute(bet({ idempotencyKey: 'outra-chave' }))).rejects.toBeInstanceOf(
      DuplicateExternalTransactionError,
    );
    expect(repository.entries).toHaveLength(1);
    expect(repository.decideCalls).toBe(1);
  });
});

describe('SubmitWagerTransaction: correlação', () => {
  test('cada submissão nova leva uma correlação própria e o instante da decisão', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);

    await useCase.execute(bet());
    await useCase.execute(
      bet({ idempotencyKey: 'provider-a:tx-2', externalTransactionId: 'tx-2' }),
    );

    expect(repository.contexts).toEqual([
      { correlationId: 'corr-1', decidedAt: T0 },
      { correlationId: 'corr-2', decidedAt: T0 },
    ]);
  });

  test('a correlação não é derivada da chave de idempotência', async () => {
    const repository = new InMemoryWagerTransactionRepository();
    repository.addWallet(10_000n);
    const useCase = new SubmitWagerTransaction(repository, () => T0);

    await useCase.execute(bet());

    const [context] = repository.contexts;
    expect(context?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(context?.correlationId).not.toContain('tx-1');
  });

  test('replay não chega à persistência transacional: nenhuma correlação nova', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    await useCase.execute(bet());

    await useCase.execute(bet());

    expect(repository.contexts).toHaveLength(1);
  });
});

describe('SubmitWagerTransaction: WIN sem referência', () => {
  const win = (overrides: Partial<SubmitWagerTransactionCommand> = {}) =>
    bet({
      kind: WagerTransactionKind.Win,
      idempotencyKey: 'provider-a:win-1',
      externalTransactionId: 'win-1',
      money: brl(5_000n),
      ...overrides,
    });

  test('PROCESSED: saldo creditado, versão incrementada e um lançamento CREDIT', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(2_000n);

    const result = await useCase.execute(win());

    expect(result).toMatchObject({ status: Processed, idempotentReplay: false });
    expect(result.failureCode).toBeUndefined();
    expect(result.balance.cents).toBe(7_000n);
    expect(repository.wallets.get('wallet-1')).toMatchObject({ version: 2 });
    expect(repository.entries.map((e) => [e.direction, e.money.cents])).toEqual([
      ['CREDIT', 5_000n],
    ]);
  });

  test('credita mesmo com saldo zero (não há regra de saldo para crédito)', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(0n);

    expect((await useCase.execute(win())).balance.cents).toBe(5_000n);
  });

  test.each([
    ['moeda incompatível', { money: Money.fromCents(100n, 'USD') }, FailureCodes.CurrencyMismatch],
    ['wallet de outro player', { playerId: 'player-2' }, FailureCodes.PlayerWalletMismatch],
  ])('%s: REJECTED com failureCode, sem crédito nem lançamento', async (_case, overrides, code) => {
    const { repository, useCase } = setup();
    repository.addWallet(2_000n);

    const result = await useCase.execute(win(overrides));

    expect(result).toMatchObject({ status: Rejected, failureCode: code });
    expect(result.balance.cents).toBe(2_000n);
    expect(repository.entries).toEqual([]);
    expect(repository.wallets.get('wallet-1')?.version).toBe(1);
  });

  test('replay devolve o resultado original; conflito e operação duplicada não creditam de novo', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(2_000n);
    const first = await useCase.execute(win());

    expect(await useCase.execute(win())).toEqual({ ...first, idempotentReplay: true });
    await expect(useCase.execute(win({ money: brl(5_001n) }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(useCase.execute(win({ idempotencyKey: 'outra' }))).rejects.toBeInstanceOf(
      DuplicateExternalTransactionError,
    );
    expect(repository.entries).toHaveLength(1);
    expect(repository.wallets.get('wallet-1')?.balance.cents).toBe(7_000n);
  });

  test('a mesma operação externa não pode ser BET e WIN', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    await useCase.execute(bet());

    await expect(
      useCase.execute(bet({ kind: WagerTransactionKind.Win, idempotencyKey: 'outra' })),
    ).rejects.toBeInstanceOf(DuplicateExternalTransactionError);
    expect(repository.entries).toHaveLength(1);
  });
});

describe('SubmitWagerTransaction: LOSS sem referência', () => {
  const loss = (overrides: Partial<SubmitWagerTransactionCommand> = {}) =>
    bet({
      kind: WagerTransactionKind.Loss,
      idempotencyKey: 'provider-a:loss-1',
      externalTransactionId: 'loss-1',
      money: brl(5_000n),
      ...overrides,
    });

  test('PROCESSED: saldo e versão inalterados, nenhum lançamento, saldo observado gravado', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(2_000n);

    const result = await useCase.execute(loss());

    expect(result).toMatchObject({ status: Processed, idempotentReplay: false });
    expect(result.failureCode).toBeUndefined();
    expect(result.balance.cents).toBe(2_000n);
    expect(repository.wallets.get('wallet-1')).toMatchObject({ version: 1 });
    expect(repository.wallets.get('wallet-1')?.balance.cents).toBe(2_000n);
    expect(repository.entries).toEqual([]);
    expect(repository.submissions.map((s) => s.status)).toEqual([Processed]);
  });

  test('valor zero é registrado como LOSS processado', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(2_000n);

    const result = await useCase.execute(loss({ money: brl(0n) }));

    expect(result.status).toBe(Processed);
    expect(repository.entries).toEqual([]);
  });

  test.each([
    ['moeda incompatível', { money: Money.fromCents(100n, 'USD') }, FailureCodes.CurrencyMismatch],
    ['wallet de outro player', { playerId: 'player-2' }, FailureCodes.PlayerWalletMismatch],
  ])('%s: REJECTED com failureCode, sem lançamento', async (_case, overrides, code) => {
    const { repository, useCase } = setup();
    repository.addWallet(2_000n);

    const result = await useCase.execute(loss(overrides));

    expect(result).toMatchObject({ status: Rejected, failureCode: code });
    expect(result.balance.cents).toBe(2_000n);
    expect(repository.entries).toEqual([]);
  });

  test('replay devolve o resultado original; conflito e operação duplicada não registram de novo', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(2_000n);
    const first = await useCase.execute(loss());

    expect(await useCase.execute(loss())).toEqual({ ...first, idempotentReplay: true });
    await expect(useCase.execute(loss({ money: brl(5_001n) }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(useCase.execute(loss({ idempotencyKey: 'outra' }))).rejects.toBeInstanceOf(
      DuplicateExternalTransactionError,
    );
    expect(repository.submissions).toHaveLength(1);
    expect(repository.decideCalls).toBe(1);
  });
});

describe('SubmitWagerTransaction: REFUND', () => {
  const refundOf = (betTx: string, overrides: Partial<SubmitWagerTransactionCommand> = {}) =>
    bet({
      idempotencyKey: `provider-a:refund-of-${betTx}`,
      externalTransactionId: `refund-of-${betTx}`,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: betTx,
      ...overrides,
    });

  test('BET ainda ausente: PENDING_REFERENCE, saldo intacto, sem lançamento, tentativa em T0 + 2 s', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);

    const result = await useCase.execute(refundOf('tx-1'));

    expect(result).toMatchObject({ status: PendingReference, idempotentReplay: false });
    expect(result.balance.cents).toBe(10_000n);
    expect(repository.entries).toEqual([]);
    expect(repository.wallets.get('wallet-1')?.version).toBe(1);
    expect(repository.schedules.get(result.transactionId)?.getTime()).toBe(T0.getTime() + 2_000);
  });

  test('BET já aplicada: crédito de igual valor, PROCESSED com o id interno da BET', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    const placed = await useCase.execute(bet());

    const result = await useCase.execute(refundOf('tx-1'));

    expect(result).toMatchObject({ status: Processed, failureCode: undefined });
    expect(result.balance.cents).toBe(10_000n);
    expect(repository.entries.map((e) => e.direction)).toEqual(['DEBIT', 'CREDIT']);
    const refund = repository.transactions.find((t) => t.id === result.transactionId);
    expect(refund?.referenceTransactionId).toBe(placed.transactionId);
    expect(repository.schedules.has(result.transactionId)).toBe(false);
  });

  test('referência existente e incompatível: REJECTED de imediato, sem agendamento', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    await useCase.execute(bet());

    const result = await useCase.execute(refundOf('tx-1', { roundId: 'round-2' }));

    expect(result).toMatchObject({
      status: Rejected,
      failureCode: FailureCodes.ReferenceMismatch,
    });
    expect(result.balance.cents).toBe(2_000n);
    expect(repository.entries).toHaveLength(1);
    expect(repository.schedules.size).toBe(0);
  });

  test('segundo REFUND da mesma BET: REJECTED REFERENCE_ALREADY_REVERSED (§7, regra 4)', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    await useCase.execute(bet());
    await useCase.execute(refundOf('tx-1'));

    const second = await useCase.execute(
      refundOf('tx-1', { idempotencyKey: 'provider-a:r2', externalTransactionId: 'r2' }),
    );

    expect(second).toMatchObject({
      status: Rejected,
      failureCode: FailureCodes.ReferenceAlreadyReversed,
    });
    expect(repository.entries).toHaveLength(2);
  });

  test('moeda diferente da wallet: REJECTED CURRENCY_MISMATCH sem esperar a referência', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);

    const result = await useCase.execute(
      refundOf('tx-1', { money: Money.fromCents(8_000n, 'USD') }),
    );

    expect(result).toMatchObject({ status: Rejected, failureCode: FailureCodes.CurrencyMismatch });
    expect(repository.schedules.size).toBe(0);
  });

  test('replay de um REFUND pendente: o mesmo resultado, sem nova decisão', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);
    const first = await useCase.execute(refundOf('tx-1'));

    const replay = await useCase.execute(refundOf('tx-1'));

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(repository.decideCalls).toBe(1);
  });

  test('a política de tentativas injetada define o primeiro agendamento', async () => {
    const repository = new InMemoryWagerTransactionRepository();
    repository.addWallet(10_000n);
    const useCase = new SubmitWagerTransaction(
      repository,
      () => T0,
      () => 'id-1',
      ReferenceRetryPolicy.from({ maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 50 }),
    );

    await useCase.execute(refundOf('tx-1'));

    expect(repository.schedules.get('id-1')?.getTime()).toBe(T0.getTime() + 50);
  });
});

describe('SubmitWagerTransaction: submissões recusadas sem gravar', () => {
  test.each([
    ['OPENING (interno)', bet({ kind: WagerTransactionKind.Opening })],
    [
      'WIN com referência (BET referenciada não PROCESSED sem regra definida)',
      bet({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'tx-0' }),
    ],
    [
      'WIN de valor zero (regra não definida)',
      bet({ kind: WagerTransactionKind.Win, money: brl(0n) }),
    ],
    [
      'LOSS com referência (regra não definida)',
      bet({ kind: WagerTransactionKind.Loss, referenceExternalTransactionId: 'tx-0' }),
    ],
    [
      'REFUND de valor zero (regra não definida)',
      bet({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'tx-0',
        money: brl(0n),
      }),
    ],
    [
      'ROLLBACK (fora desta etapa)',
      bet({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'tx-0' }),
    ],
    ['BET com referência (regra não definida)', bet({ referenceExternalTransactionId: 'tx-0' })],
    ['BET de valor zero (regra não definida)', bet({ money: brl(0n) })],
    ['kind desconhecido', bet({ kind: 'JACKPOT' as Kind })],
  ])('%s', async (_case, command) => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);

    await expect(useCase.execute(command)).rejects.toBeInstanceOf(UnsupportedSubmissionError);
    expect(repository.submissions).toEqual([]);
    expect(repository.decideCalls).toBe(0);
  });

  test('wallet inexistente: WalletNotFoundError, nada gravado', async () => {
    const { repository, useCase } = setup();

    await expect(useCase.execute(bet())).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(repository.submissions).toEqual([]);
  });

  test('campo de submissão vazio é recusado pelo domínio antes da persistência', async () => {
    const { repository, useCase } = setup();
    repository.addWallet(10_000n);

    await expect(useCase.execute(bet({ roundId: ' ' }))).rejects.toThrow('roundId');
    expect(repository.decideCalls).toBe(0);
  });
});
