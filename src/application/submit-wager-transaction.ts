import { randomUUID } from 'node:crypto';
import { applyBet } from '../domain/bet';
import type { Money } from '../domain/money';
import {
  type FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from '../domain/wager-transaction';
import { betFailureCodeFor } from './failure-codes';
import { computeWagerPayloadHash } from './payload-hash';
import type {
  ExistingSubmissions,
  StoredSubmission,
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
 * Processa uma submissão de transação. Nesta etapa, somente `BET`.
 *
 * - Idempotência (§9): a mesma `idempotencyKey` com o mesmo `payloadHash` devolve o resultado
 *   original (`idempotentReplay: true`), inclusive o saldo observado na época (§7, regra 7); com
 *   outro payload, `IdempotencyConflictError`. O mesmo `(providerId, externalTransactionId)` sob
 *   outra chave é `DuplicateExternalTransactionError`. Nenhum desses casos aplica efeito.
 * - BET nova: a persistência trava a wallet; `applyBet` debita e a transação vira `PROCESSED`, ou
 *   uma violação de negócio a torna `REJECTED` com `failureCode`, sem lançamento. Tudo na mesma
 *   transação SQL.
 * - Recusados sem gravar nada (`UnsupportedSubmissionError`): outros tipos (fora desta etapa) e
 *   casos sem regra definida (BET de valor zero, BET com referência). Wallet inexistente:
 *   `WalletNotFoundError`.
 *
 * Reutilizável por qualquer entrada (HTTP, consumidor SQS): a garantia está no banco, não no
 * chamador.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
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
      createdAt: at,
    });
    const ledgerEntryId = this.newId();

    const outcome = await this.transactions.applyToLockedWallet(
      command.walletId,
      keys,
      (wallet) => {
        try {
          const ledgerEntry = applyBet({ transaction, wallet, ledgerEntryId, at });
          return { transaction, wallet, ledgerEntry };
        } catch (error) {
          const code = betFailureCodeFor(error);
          if (code === undefined) throw error;
          // `applyBet` não altera wallet nem transação ao falhar: rejeição sem lançamento (§7, regra 6).
          transaction.reject(code);
          return { transaction, wallet, ledgerEntry: null };
        }
      },
    );

    if (outcome.kind === 'APPLIED') return toResult(outcome.submission, false);
    const concurrent = resolveExisting(outcome.existing, keys, payloadHash);
    if (concurrent === undefined) {
      throw new Error('A persistência informou submissão existente, mas não a devolveu.');
    }
    return concurrent;
  }
}

function assertSupported(command: SubmitWagerTransactionCommand): void {
  if (command.kind !== WagerTransactionKind.Bet) {
    throw new UnsupportedSubmissionError(
      command.kind === WagerTransactionKind.Opening
        ? 'OPENING é interno e não pode ser submetido.'
        : `o processamento de ${command.kind} ainda não está implementado.`,
    );
  }
  if (command.referenceExternalTransactionId !== undefined) {
    throw new UnsupportedSubmissionError('BET com referência: a regra ainda não foi definida.');
  }
  if (command.money.isZero()) {
    throw new UnsupportedSubmissionError('BET de valor zero: a regra ainda não foi definida.');
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
