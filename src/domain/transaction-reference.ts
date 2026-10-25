import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

/**
 * Motivo de uma referência inválida, nos termos do contrato §7. Não é `failureCode`: o mapeamento
 * para a taxonomia de códigos (§7.2) cabe ao processamento, quando ela for definida.
 */
export type ReferenceViolation =
  | 'NOT_THE_REFERENCED_TRANSACTION'
  | 'DIFFERENT_PLAYER'
  | 'DIFFERENT_WALLET'
  | 'DIFFERENT_CURRENCY'
  | 'DIFFERENT_ROUND'
  | 'KIND_NOT_ALLOWED'
  | 'REFERENCE_NOT_PROCESSED'
  | 'AMOUNT_MISMATCH';

/** Tipos que cada transação pode referenciar (contrato §7: tabela e regra 3). */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly string[]>>> =
  {
    [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Rollback]: [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ],
    [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  };

/**
 * Valida que `reference` é a transação referenciada por `transaction` e que a combinação respeita o
 * contrato §7. Lança `InvalidReferenceError` na primeira violação; não altera nenhum objeto.
 *
 * - regra 2: resolvida por `(providerId, referenceExternalTransactionId)` e pertencente ao mesmo
 *   provider, player, wallet, moeda e rodada;
 * - regra 3 e tabela: REFUND só referencia BET; ROLLBACK, BET/WIN/REFUND; WIN, BET;
 * - tabela e regra 5: REFUND e ROLLBACK revertem uma transação `PROCESSED`, de valor igual.
 *
 * Não verifica se a referência já foi revertida pelo mesmo tipo (regra 4): essa garantia depende da
 * persistência (unicidade no banco, §5.9). Referências em BET e LOSS não têm regra no contrato e são
 * recusadas com `UnsupportedReferenceError`.
 */
export function validateReference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): void {
  const allowedKinds = ALLOWED_REFERENCE_KINDS[transaction.kind];
  if (allowedKinds === undefined) {
    throw new UnsupportedReferenceError(transaction.kind);
  }

  if (
    transaction.referenceExternalTransactionId === undefined ||
    reference.providerId !== transaction.providerId ||
    reference.externalTransactionId !== transaction.referenceExternalTransactionId
  ) {
    throw new InvalidReferenceError('NOT_THE_REFERENCED_TRANSACTION', transaction, reference);
  }
  if (reference.playerId !== transaction.playerId) {
    throw new InvalidReferenceError('DIFFERENT_PLAYER', transaction, reference);
  }
  if (reference.walletId !== transaction.walletId) {
    throw new InvalidReferenceError('DIFFERENT_WALLET', transaction, reference);
  }
  if (reference.money.currency !== transaction.money.currency) {
    throw new InvalidReferenceError('DIFFERENT_CURRENCY', transaction, reference);
  }
  if (reference.roundId !== transaction.roundId) {
    throw new InvalidReferenceError('DIFFERENT_ROUND', transaction, reference);
  }
  if (!allowedKinds.includes(reference.kind)) {
    throw new InvalidReferenceError('KIND_NOT_ALLOWED', transaction, reference);
  }
  if (transaction.requiresReference()) {
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidReferenceError('REFERENCE_NOT_PROCESSED', transaction, reference);
    }
    if (!reference.money.equals(transaction.money)) {
      throw new InvalidReferenceError('AMOUNT_MISMATCH', transaction, reference);
    }
  }
}

/** Referência que viola uma regra do contrato §7. Erro de negócio: a transação deve ser rejeitada. */
export class InvalidReferenceError extends Error {
  override readonly name = 'InvalidReferenceError';
  readonly transactionId: string;
  readonly referenceId: string;

  constructor(
    readonly violation: ReferenceViolation,
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ) {
    super(
      `Referência inválida (${violation}): ${transaction.kind} ${transaction.id} → ` +
        `${reference.kind} ${reference.id}.`,
    );
    this.transactionId = transaction.id;
    this.referenceId = reference.id;
  }
}

/** O contrato não define regras de referência para este tipo (pendente de decisão). */
export class UnsupportedReferenceError extends Error {
  override readonly name = 'UnsupportedReferenceError';

  constructor(readonly kind: WagerTransactionKind) {
    super(`O contrato não define referências para ${kind}; decisão pendente.`);
  }
}
