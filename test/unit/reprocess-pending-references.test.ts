import { describe, expect, test } from 'bun:test';
import { FailureCodes } from '../../src/application/failure-codes';
import {
  DEFAULT_REFERENCE_RETRY,
  ReferenceRetryPolicy,
} from '../../src/application/reference-retry-policy';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references';
import {
  type PendingReferenceRepository,
  type PendingReferenceState,
  type PendingReferenceTask,
  type SubmissionDecision,
  TransientPersistenceError,
} from '../../src/application/wager-transaction-repository';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { at, brl, processed, reversalOf, T0, wager } from '../support/wager-fixtures';

const { Bet, Refund } = WagerTransactionKind;

/** REFUND reidratado em `PENDING_REFERENCE`. */
function pendingRefund(id: string, kind: WagerTransactionKind = Refund): WagerTransaction {
  const base =
    kind === Refund ? reversalOf(Refund, id, processed(Bet, 'bet-1')) : wager(kind, id, {});
  return WagerTransaction.rehydrate({
    id: base.id,
    providerId: base.providerId,
    externalTransactionId: base.externalTransactionId,
    idempotencyKey: base.idempotencyKey,
    payloadHash: base.payloadHash,
    walletId: base.walletId,
    playerId: base.playerId,
    roundId: base.roundId,
    gameId: base.gameId,
    kind: base.kind,
    money: base.money,
    referenceExternalTransactionId: base.referenceExternalTransactionId ?? 'ext-x',
    createdAt: base.createdAt,
    status: WagerTransactionStatus.PendingReference,
  });
}

const wallet = () =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(10_000n),
    openedAt: T0,
    opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' },
  }).wallet;

type Behavior =
  | { kind: 'state'; state: () => PendingReferenceState }
  | { kind: 'skip' }
  | { kind: 'throw'; error: unknown };

/** Porta falsa: entrega estados prontos e guarda as decisões recebidas. */
class FakePending implements PendingReferenceRepository {
  readonly decisions: SubmissionDecision[] = [];
  readonly seen: { now: Date; limit: number }[] = [];

  constructor(private readonly behaviors: Map<string, Behavior>) {}

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceTask[]> {
    this.seen.push({ now, limit });
    return [...this.behaviors.keys()].map((id) => ({ transactionId: id, walletId: 'wallet-1' }));
  }

  async resolvePendingReference(
    task: PendingReferenceTask,
    _now: Date,
    decide: (state: PendingReferenceState) => SubmissionDecision,
  ): Promise<boolean> {
    const behavior = this.behaviors.get(task.transactionId);
    if (behavior === undefined || behavior.kind === 'skip') return false;
    if (behavior.kind === 'throw') throw behavior.error;
    this.decisions.push(decide(behavior.state()));
    return true;
  }
}

const stateWith = (
  transaction: WagerTransaction,
  completedAttempts: number,
  reference: PendingReferenceState['reference'] = null,
): Behavior => ({
  kind: 'state',
  state: () => ({ transaction, wallet: wallet(), reference, completedAttempts }),
});

function run(behaviors: [string, Behavior][], onError?: (t: PendingReferenceTask) => void) {
  const pending = new FakePending(new Map(behaviors));
  const reprocess = new ReprocessPendingReferences(pending, {
    batchSize: 25,
    now: () => at(100),
    newId: () => 'entry-new',
    policy: ReferenceRetryPolicy.from(DEFAULT_REFERENCE_RETRY),
    onError,
  });
  return { pending, summary: reprocess.runOnce() };
}

describe('ReprocessPendingReferences', () => {
  test('cada tentativa conta uma vez: resolvida, reagendada, esgotada e já resolvida por outro', async () => {
    const bet = processed(Bet, 'bet-1');
    const { pending, summary } = run([
      [
        'resolved',
        stateWith(pendingRefund('resolved'), 0, { transaction: bet, alreadyReversed: false }),
      ],
      ['waiting', stateWith(pendingRefund('waiting'), 3)],
      ['exhausted', stateWith(pendingRefund('exhausted'), 9)],
      ['skipped', { kind: 'skip' }],
    ]);

    expect(await summary).toEqual({
      due: 4,
      processed: 1,
      rejected: 1,
      rescheduled: 1,
      skipped: 1,
      transientFailures: 0,
      failures: 0,
    });
    expect(pending.seen).toEqual([{ now: at(100), limit: 25 }]);
    const [resolved, waiting, exhausted] = pending.decisions;
    expect(resolved?.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(resolved?.ledgerEntry?.id).toBe('entry-new');
    // 3 tentativas feitas + esta = 4: espera de 2 s × 2^4 = 32 s.
    expect(waiting?.nextReferenceAttemptAt?.getTime()).toBe(at(132).getTime());
    expect(exhausted?.transaction.failureCode).toBe(FailureCodes.ReferenceNotFound);
  });

  test('falha transitória: contada, sem onError; a rodada segue com as demais', async () => {
    const errors: PendingReferenceTask[] = [];
    const { summary } = run(
      [
        [
          'flaky',
          { kind: 'throw', error: new TransientPersistenceError({ cause: new Error('x') }) },
        ],
        ['waiting', stateWith(pendingRefund('waiting'), 0)],
      ],
      (task) => errors.push(task),
    );

    expect(await summary).toMatchObject({ transientFailures: 1, rescheduled: 1, failures: 0 });
    expect(errors).toEqual([]);
  });

  test('falha inesperada: relatada a onError com a tarefa; a rodada segue', async () => {
    const errors: PendingReferenceTask[] = [];
    const { summary } = run(
      [
        ['broken', { kind: 'throw', error: new Error('bug') }],
        ['waiting', stateWith(pendingRefund('waiting'), 0)],
      ],
      (task) => errors.push(task),
    );

    expect(await summary).toMatchObject({ failures: 1, rescheduled: 1 });
    expect(errors).toEqual([{ transactionId: 'broken', walletId: 'wallet-1' }]);
  });

  test('pendência de outro tipo não tem reprocessamento: falha, nada é decidido', async () => {
    const { pending, summary } = run([
      ['win', stateWith(pendingRefund('win', WagerTransactionKind.Win), 0)],
    ]);

    expect(await summary).toMatchObject({ failures: 1, processed: 0 });
    expect(pending.decisions).toEqual([]);
  });

  test('falha transitória na busca sobe para o agendador', async () => {
    const reprocess = new ReprocessPendingReferences(
      {
        findDuePendingReferences: async () => {
          throw new TransientPersistenceError({ cause: new Error('x') });
        },
        resolvePendingReference: async () => false,
      },
      { batchSize: 1 },
    );

    await expect(reprocess.runOnce()).rejects.toBeInstanceOf(TransientPersistenceError);
  });

  test.each([0, -1, 1.5])('batchSize inválido (%p)', (batchSize) => {
    expect(() => new ReprocessPendingReferences(new FakePending(new Map()), { batchSize })).toThrow(
      RangeError,
    );
  });
});
