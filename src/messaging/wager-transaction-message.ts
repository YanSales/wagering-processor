import type { WagerTransactionMessage } from '../application/inbox/handle-wager-transaction-message';
import { InvalidMoneyError } from '../domain/money';
import {
  InvalidSubmissionRequestError,
  parseSubmissionRequest,
} from '../wagering/submit-transaction.request';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/** Mensagem que não tem a forma do contrato §10: vai para a DLQ sem tentar de novo. */
export class InvalidWagerTransactionMessageError extends Error {
  override readonly name = 'InvalidWagerTransactionMessageError';
}

/**
 * Lê o corpo de uma mensagem `WagerTransactionRequested` (contrato §10):
 * `{ messageId, type, occurredAt, data: { idempotencyKey, providerId, …, money } }`.
 *
 * O envelope é validado aqui; `data` passa pela mesma validação de forma da API
 * (`parseSubmissionRequest`), com `data.idempotencyKey` no papel do header `Idempotency-Key`.
 */
export function parseWagerTransactionMessage(body: string | undefined): WagerTransactionMessage {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body ?? '');
  } catch {
    throw new InvalidWagerTransactionMessageError('o corpo não é JSON válido.');
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new InvalidWagerTransactionMessageError('o corpo deve ser um objeto JSON.');
  }
  const { messageId, type, occurredAt, data } = envelope as Record<string, unknown>;
  if (typeof messageId !== 'string' || messageId.trim() === '' || messageId.length > 256) {
    throw new InvalidWagerTransactionMessageError(
      'messageId deve ser uma string não vazia (até 256).',
    );
  }
  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidWagerTransactionMessageError(`type deve ser ${WAGER_TRANSACTION_REQUESTED}.`);
  }
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidWagerTransactionMessageError('occurredAt deve ser uma data ISO-8601.');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InvalidWagerTransactionMessageError('data deve ser um objeto.');
  }
  try {
    const command = parseSubmissionRequest((data as Record<string, unknown>).idempotencyKey, data);
    return { messageId, command };
  } catch (error) {
    if (error instanceof InvalidSubmissionRequestError || error instanceof InvalidMoneyError) {
      throw new InvalidWagerTransactionMessageError(`data: ${error.message}`);
    }
    throw error;
  }
}
