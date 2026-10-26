import { createHash } from 'node:crypto';
import type { Money } from '../domain/money';

/** Campos de negócio de uma submissão (contrato §9). A `Idempotency-Key` não faz parte. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * `payloadHash` de uma submissão (contrato §9): SHA-256, em hexadecimal minúsculo, do JSON canônico
 * dos campos de negócio.
 *
 * JSON canônico: chaves ordenadas por ponto de código em todos os níveis, sem espaços, `money` como
 * `{ "amount": "<2 casas>", "currency": "<ISO>" }` (forma `MoneyProps`, a partir dos centavos), e
 * `referenceExternalTransactionId` omitido quando ausente. O header `Idempotency-Key` e metadados
 * de transporte não entram no hash. Dois payloads com os mesmos valores de negócio têm o mesmo hash,
 * independentemente da ordem das chaves recebidas.
 */
export function computeWagerPayloadHash(fields: WagerPayloadFields): string {
  const business: Record<string, unknown> = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: fields.money.toProps(),
  };
  if (fields.referenceExternalTransactionId !== undefined) {
    business.referenceExternalTransactionId = fields.referenceExternalTransactionId;
  }
  return createHash('sha256').update(canonicalJson(business), 'utf8').digest('hex');
}

/** JSON com chaves ordenadas em todos os níveis. Aceita apenas strings e objetos simples. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson aceita apenas strings e objetos; recebido ${typeof value}.`);
}
