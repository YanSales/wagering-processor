import { randomUUID } from 'node:crypto';
import { applyBet } from '../domain/bet';
import { applyLoss } from '../domain/loss';
import type { Money } from '../domain/money';
import {
  type FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from '../domain/wager-transaction';
import { applyWin } from '../domain/win';
import { movementFailureCodeFor } from './failure-codes';
import { computeWagerPayloadHash } from './payload-hash';
import { DEFAULT_REFERENCE_RETRY, ReferenceRetryPolicy } from './reference-retry-policy';
import { decideRefund, decideRollback } from './refund-decision';
import type {
  ExistingSubmissions,
  InboxReceipt,
  StoredSubmission,
  SubmissionContext,
  SubmissionKeys,
  WagerTransactionRepository,
} from './wager-transaction-repository';

/** Submissão de transação (contrato §9, `POST /wagering/transactions`, e mensagens da fila). */
export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/** Resultado de uma submissão (contrato §9). `balance` é o saldo observado ao concluir. */
export interface SubmissionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: Money;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

/**
 * Processa uma submissão de transação: `BET`, `WIN` e `LOSS` sem referência, `REFUND` e `ROLLBACK`.
 *
 * - Idempotência (§9): a mesma `idempotencyKey` com o mesmo `payloadHash` devolve o resultado
 *   original (`idempotentReplay: true`), inclusive o saldo observado na época (§7, regra 7); com
 *   outro payload, `IdempotencyConflictError`. O mesmo `(providerId, externalTransactionId)` sob
 *   outra chave é `DuplicateExternalTransactionError`. Nenhum desses casos aplica efeito.
 * - Submissão nova: a persistência trava a wallet; `applyBet` debita (BET), `applyWin` credita
 *   (WIN) ou `applyLoss` só registra (LOSS, sem lançamento) e a transação vira `PROCESSED`, ou uma
 *   violação de negócio a torna `REJECTED` com `failureCode`, sem lançamento. Tudo na mesma
 *   transação SQL.
 * - REFUND e ROLLBACK (`decideRefund`, `decideRollback`): a referência é lida sob o mesmo lock.
 *   Válida, movimento (REFUND credita; ROLLBACK inverte a referência) e `PROCESSED`; existente, mas
 *   inválida, ou ROLLBACK que deixaria saldo negativo, `REJECTED`; ausente, `PENDING_REFERENCE` com a
 *   próxima tentativa agendada para o worker do §7.1, sem lançamento.
 * - Recusados sem gravar nada (`UnsupportedSubmissionError`): outros tipos (fora desta etapa) e
 *   casos sem regra definida (BET, WIN ou REFUND de valor zero; BET, WIN ou LOSS com referência).
 *   Wallet inexistente: `WalletNotFoundError`.
 *
 * Reutilizável por qualquer entrada (HTTP, consumidor SQS): a garantia está no banco, não no
 * chamador.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly referenceRetry: ReferenceRetryPolicy = ReferenceRetryPolicy.from(
      DEFAULT_REFERENCE_RETRY,
    ),
    /** Correlação de cada submissão nova: gerada no servidor, nunca derivada da chave de idempotência. */
    private readonly newCorrelationId: () => string = randomUUID,
  ) {}

  /**
   * `inbox`: mensagem da fila que originou a submissão. Numa submissão nova, é gravada na mesma
   * transação SQL do efeito; num replay (`idempotentReplay: true`) nada é gravado, e o registro cabe
   * ao chamador.
   */
  async execute(
    command: SubmitWagerTransactionCommand,
    inbox?: InboxReceipt,
  ): Promise<SubmissionResult> {
    assertSupported(command);
    const payloadHash = computeWagerPayloadHash(command);
    const keys: SubmissionKeys = {
      idempotencyKey: command.idempotencyKey,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
    };

    // Caminho rápido: um replay não abre transação nem trava a wallet.
    const known = resolveExisting(await this.transactions.findExisting(keys), keys, payloadHash);
    if (known !== undefined) return known;

    const at = this.now();
    // Valida a submissão (campos, kind, valor) antes de tocar o banco.
    const transaction = WagerTransaction.create({
      id: this.newId(),
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: at,
    });
    const ledgerEntryId = this.newId();
    // Gravada na transação e nos eventos dela; um replay devolve o resultado sem usá-la.
    const context: SubmissionContext = {
      correlationId: this.newCorrelationId(),
      decidedAt: at,
      ...(inbox === undefined ? {} : { inbox }),
    };

    const decideReversal = REVERSALS[command.kind as ReversalKind];
    const outcome =
      decideReversal !== undefined
        ? await this.transactions.applyToLockedWallet(
            command.walletId,
            keys,
            context,
            (wallet, reference) =>
              decideReversal({
                transaction,
                wallet,
                reference,
                attempts: 0,
                ledgerEntryId,
                at,
                policy: this.referenceRetry,
              }),
            {
              providerId: command.providerId,
              externalTransactionId: command.referenceExternalTransactionId as string,
            },
          )
        : await this.transactions.applyToLockedWallet(command.walletId, keys, context, (wallet) => {
            const apply = MOVEMENTS[command.kind as MovementKind];
            try {
              const ledgerEntry = apply({ transaction, wallet, ledgerEntryId, at });
              return { transaction, wallet, ledgerEntry };
            } catch (error) {
              const code = movementFailureCodeFor(error);
              if (code === undefined) throw error;
              // `applyBet`/`applyWin`/`applyLoss` não alteram wallet nem transação ao falhar:
              // rejeição sem lançamento (§7, regra 6).
              transaction.reject(code);
              return { transaction, wallet, ledgerEntry: null };
            }
          });

    if (outcome.kind === 'APPLIED') return toResult(outcome.submission, false);
    const concurrent = resolveExisting(outcome.existing, keys, payloadHash);
    if (concurrent === undefined) {
      throw new Error('A persistência informou submissão existente, mas não a devolveu.');
    }
    return concurrent;
  }
}

/**
 * Tipos processados nesta etapa e a regra de domínio de cada um (contrato §7, tabela). Todos passam
 * pela wallet travada: o LOSS não a movimenta, mas grava o saldo observado (§7, regra 7) no mesmo
 * ponto de serialização das BETs e WINs da wallet.
 */
const MOVEMENTS = {
  [WagerTransactionKind.Bet]: applyBet,
  [WagerTransactionKind.Win]: applyWin,
  [WagerTransactionKind.Loss]: applyLoss,
} as const;
type MovementKind = keyof typeof MOVEMENTS;
/** Reversões: exigem a referência, lida sob o lock da wallet (§7, regras 1 a 5, 8 e 9). */
const REVERSALS = {
  [WagerTransactionKind.Refund]: decideRefund,
  [WagerTransactionKind.Rollback]: decideRollback,
} as const;
type ReversalKind = keyof typeof REVERSALS;
/** Tipos processados: os movimentos sem referência e as reversões (REFUND e ROLLBACK). */
const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  ...Object.keys(MOVEMENTS),
  ...Object.keys(REVERSALS),
]);
/** LOSS não move saldo: valor zero não esbarra em nenhuma invariante (ver `applyLoss`). */
const ZERO_AMOUNT_ALLOWED: ReadonlySet<string> = new Set([WagerTransactionKind.Loss]);

function assertSupported(command: SubmitWagerTransactionCommand): void {
  if (!SUPPORTED_KINDS.has(command.kind)) {
    throw new UnsupportedSubmissionError(
      command.kind === WagerTransactionKind.Opening
        ? 'OPENING é interno e não pode ser submetido.'
        : `o processamento de ${command.kind} ainda não está implementado.`,
    );
  }
  // REFUND e ROLLBACK exigem a referência (§7, regra 1), validada por `WagerTransaction.create`.
  if (!(command.kind in REVERSALS) && command.referenceExternalTransactionId !== undefined) {
    throw new UnsupportedSubmissionError(
      command.kind === WagerTransactionKind.Win
        ? 'WIN com referência: o contrato não define o caso de uma BET referenciada que não ' +
            'esteja PROCESSED.'
        : command.kind === WagerTransactionKind.Loss
          ? 'LOSS com referência: o contrato não define se ela é permitida nem o que pode referenciar.'
          : `${command.kind} com referência: a regra ainda não foi definida.`,
    );
  }
  if (command.money.isZero() && !ZERO_AMOUNT_ALLOWED.has(command.kind)) {
    throw new UnsupportedSubmissionError(
      `${command.kind} de valor zero: a regra ainda não foi definida.`,
    );
  }
}

/** Replay, conflito ou `undefined` (submissão nova). */
function resolveExisting(
  existing: ExistingSubmissions,
  keys: SubmissionKeys,
  payloadHash: string,
): SubmissionResult | undefined {
  const { byIdempotencyKey, byExternalTransaction } = existing;
  if (byIdempotencyKey !== null) {
    if (byIdempotencyKey.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError(keys.idempotencyKey);
    }
    return toResult(byIdempotencyKey, true);
  }
  if (byExternalTransaction !== null) {
    throw new DuplicateExternalTransactionError(keys, byExternalTransaction.idempotencyKey);
  }
  return undefined;
}

function toResult(submission: StoredSubmission, idempotentReplay: boolean): SubmissionResult {
  return {
    transactionId: submission.transactionId,
    status: submission.status,
    balance: submission.resultBalance,
    failureCode: submission.failureCode,
    idempotentReplay,
  };
}

/** A mesma chave de idempotência já foi usada com outro payload (§6.3 e §9): conflito, não replay. */
export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';

  constructor(readonly idempotencyKey: string) {
    super(`A chave de idempotência ${idempotencyKey} já foi usada com outro payload.`);
  }
}

/**
 * A operação `(providerId, externalTransactionId)` já foi submetida com outra chave de idempotência.
 * Não é replay (a chave é a fonte da verdade, §9) nem pode aplicar o efeito de novo.
 */
export class DuplicateExternalTransactionError extends Error {
  override readonly name = 'DuplicateExternalTransactionError';

  constructor(
    readonly keys: SubmissionKeys,
    readonly existingIdempotencyKey: string,
  ) {
    super(
      `A transação ${keys.externalTransactionId} do provedor ${keys.providerId} já foi submetida ` +
        `com outra chave de idempotência.`,
    );
  }
}

/** Submissão fora do que o processamento atual suporta; nada é gravado. */
export class UnsupportedSubmissionError extends Error {
  override readonly name = 'UnsupportedSubmissionError';

  constructor(detail: string) {
    super(`Submissão não suportada: ${detail}`);
  }
}
