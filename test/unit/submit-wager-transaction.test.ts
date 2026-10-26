import { describe, expect, test } from 'bun:test';
import { FailureCodes } from '../../src/application/failure-codes';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
  UnsupportedSubmissionError,
} from '../../src/application/submit-wager-transaction';
import {
  type ExistingSubmissions,
  type StoredSubmission,
  type SubmissionDecision,
  type SubmissionKeys,
  type SubmissionOutcome,
  type WagerTransactionRepository,
  WalletNotFoundError,
} from '../../src/application/wager-transaction-repository';
import { Money } from '../../src/domain/money';
import {
  type WagerTransactionKind as Kind,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet, type WalletState } from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { brl, T0 } from '../support/wager-fixtures';

const { Processed, Rejected } = WagerTransactionStatus;

/**
 * Repositório em memória da porta: guarda wallets, submissões e lançamentos. Não simula a
 * concorrência do banco (coberta pelos testes de integração); serve para as regras do caso de uso.
 */
class InMemoryWagerTransactionRepository implements WagerTransactionRepository {
  readonly wallets = new Map<string, WalletState>();
  readonly submissions: StoredSubmission[] = [];
  readonly entries: WalletLedgerEntry[] = [];
  decideCalls = 0;

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
    decide: (wallet: Wallet) => SubmissionDecision,
  ): Promise<SubmissionOutcome> {
    const state = this.wallets.get(walletId);
    if (state === undefined) throw new WalletNotFoundError(walletId);
    const existing = await this.findExisting(keys);
    if (existing.byIdempotencyKey !== null || existing.byExternalTransaction !== null) {
      return { kind: 'EXISTING', existing };
    }
    this.decideCalls += 1;
    const { transaction, wallet, ledgerEntry } = decide(Wallet.rehydrate(state));
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
  const useCase = new SubmitWagerTransaction(
    repository,
    () => T0,
    () => `id-${++sequence}`,
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

describe('SubmitWagerTransaction: submissões recusadas sem gravar', () => {
  test.each([
    ['OPENING (interno)', bet({ kind: WagerTransactionKind.Opening })],
    [
      'WIN com referência (PENDING_REFERENCE e §7.1 ainda não existem)',
      bet({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'tx-0' }),
    ],
    [
      'WIN de valor zero (regra não definida)',
      bet({ kind: WagerTransactionKind.Win, money: brl(0n) }),
    ],
    ['LOSS (fora desta etapa)', bet({ kind: WagerTransactionKind.Loss })],
    [
      'REFUND (fora desta etapa)',
      bet({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'tx-0' }),
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
