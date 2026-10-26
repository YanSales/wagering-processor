import type {
  SubmissionResult,
  SubmitWagerTransactionCommand,
} from '../application/submit-wager-transaction';
import { Money, type MoneyProps } from '../domain/money';
import { WagerTransactionKind, type WagerTransactionStatus } from '../domain/wager-transaction';

/** Resposta de `POST /wagering/transactions` (contrato §9). `failureCode` só em `REJECTED` (§7.2). */
export interface SubmissionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: string;
}

/** Requisição que não tem a forma do contrato §9. */
export class InvalidSubmissionRequestError extends Error {
  override readonly name = 'InvalidSubmissionRequestError';
}

/** Tipos que o contrato permite submeter (§6.3: `OPENING` é interno). */
const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

// `wallets.id` é `uuid`: outro formato nunca corresponderia a uma wallet.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lê `Idempotency-Key` e o corpo de `POST /wagering/transactions` (contrato §9).
 *
 * Valida só a forma: strings não vazias, `walletId` UUID, `kind` submetível, `money` pelas regras
 * do §6.1 (`Money.fromProps`, string decimal convertida direto para centavos `bigint`, que lança
 * `InvalidMoneyError`). Regras de negócio, tipos ainda não processados e idempotência ficam com o
 * caso de uso. Campos extras são ignorados.
 */
export function parseSubmissionRequest(
  idempotencyKey: unknown,
  body: unknown,
): SubmitWagerTransactionCommand {
  const key = requiredText('Idempotency-Key', idempotencyKey);
  if (!isPlainObject(body)) {
    throw new InvalidSubmissionRequestError('o corpo deve ser um objeto JSON.');
  }
  const walletId = requiredText('walletId', body.walletId);
  if (!UUID.test(walletId)) {
    throw new InvalidSubmissionRequestError('walletId deve ser um UUID.');
  }
  const kind = requiredText('kind', body.kind);
  if (!SUBMITTABLE_KINDS.has(kind)) {
    throw new InvalidSubmissionRequestError(
      kind === WagerTransactionKind.Opening
        ? 'kind OPENING é interno e não pode ser submetido.'
        : `kind inválido: use ${[...SUBMITTABLE_KINDS].join(', ')}.`,
    );
  }
  if (!isPlainObject(body.money)) {
    throw new InvalidSubmissionRequestError('money deve ser um objeto { amount, currency }.');
  }
  const { amount, currency } = body.money;

  const command: SubmitWagerTransactionCommand = {
    idempotencyKey: key,
    providerId: requiredText('providerId', body.providerId),
    externalTransactionId: requiredText('externalTransactionId', body.externalTransactionId),
    playerId: requiredText('playerId', body.playerId),
    walletId,
    roundId: requiredText('roundId', body.roundId),
    gameId: requiredText('gameId', body.gameId),
    kind: kind as WagerTransactionKind,
    money: Money.fromProps({ amount, currency } as MoneyProps),
  };
  if (body.referenceExternalTransactionId !== undefined) {
    command.referenceExternalTransactionId = requiredText(
      'referenceExternalTransactionId',
      body.referenceExternalTransactionId,
    );
  }
  return command;
}

export function toSubmissionResponse(result: SubmissionResult): SubmissionResponse {
  const response: SubmissionResponse = {
    transactionId: result.transactionId,
    status: result.status,
    balance: result.balance.toProps(),
    idempotentReplay: result.idempotentReplay,
  };
  if (result.failureCode !== undefined) response.failureCode = result.failureCode;
  return response;
}

/** String não vazia, sem o caractere NUL (que o PostgreSQL não armazena em `text`). */
function requiredText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidSubmissionRequestError(`${name} deve ser uma string não vazia.`);
  }
  if (value.includes('\u0000')) {
    throw new InvalidSubmissionRequestError(`${name} não pode conter o caractere NUL.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
