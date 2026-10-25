import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  type WagerTransactionKind,
} from '../../src/domain/wager-transaction';

export const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
export const T0 = new Date('2026-10-25T12:00:00.000Z');
export const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

/** Transação submetida em PENDING, com valores coerentes por padrão (mesmo provider, player etc.). */
export function wager(
  kind: WagerTransactionKind,
  id: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create({
    id,
    providerId: 'provider-a',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `provider-a:ext-${id}`,
    payloadHash: `hash-${id}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(2_500n),
    createdAt: T0,
    ...overrides,
  });
}

/** Transação já processada (referência sem referência própria, ex.: BET ou WIN). */
export function processed(
  kind: WagerTransactionKind,
  id: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
  referenceTransactionId?: string,
): WagerTransaction {
  const tx = wager(kind, id, overrides);
  tx.markProcessed(referenceTransactionId, at(1));
  return tx;
}

/** Reversão (REFUND/ROLLBACK) que referencia `reference` pelo seu id externo. */
export function reversalOf(
  kind: WagerTransactionKind,
  id: string,
  reference: WagerTransaction,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return wager(kind, id, {
    referenceExternalTransactionId: reference.externalTransactionId,
    money: reference.money,
    ...overrides,
  });
}
