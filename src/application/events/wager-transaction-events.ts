import type { MoneyProps } from '../../domain/money';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
  InvalidIntegrationEventError,
} from './integration-event';

/**
 * `data` dos eventos de transação. O contrato (§11) define o nome e o momento de cada evento, mas
 * não o `data`: todos os campos abaixo são decisão do projeto, tirados de `WagerTransaction`
 * (§6.3). Ficam de fora o saldo (pertence a `WalletBalanceChanged`), `status` (redundante com
 * `eventType`), `idempotencyKey` e `payloadHash` (internos), `gameId` (nenhuma regra o usa) e
 * contadores operacionais do reprocessamento.
 */
interface TransactionIdentity {
  /** Id interno; também é o `aggregateId` do envelope. */
  transactionId: string;
  /** Unidade de concorrência (§8). */
  walletId: string;
  playerId: string;
  money: MoneyProps;
}

/** Transação submetida (API ou fila): os campos externos sempre existem. */
interface SubmittedFields {
  kind: Exclude<WagerTransactionKind, typeof WagerTransactionKind.Opening>;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
}

/** Referências de uma transação submetida aplicada. */
interface SubmittedReferences {
  /** Referência no provedor; `null` quando a transação não referencia outra. */
  referenceExternalTransactionId: string | null;
  /** Id interno da referência resolvida (reversões); `null` sem referência. */
  referenceTransactionId: string | null;
}

/**
 * `OPENING` é interna (§6.3, `WagerTransaction.opening`): não tem provedor, operação externa, rodada
 * nem referência.
 */
interface OpeningFields {
  kind: typeof WagerTransactionKind.Opening;
  providerId: null;
  externalTransactionId: null;
  roundId: null;
  referenceExternalTransactionId: null;
  referenceTransactionId: null;
}

export type WagerTransactionProcessedData = TransactionIdentity &
  ((SubmittedFields & SubmittedReferences) | OpeningFields);

/**
 * Sem `referenceTransactionId`: o domínio só grava o id interno da referência em `markProcessed`;
 * `reject` não o registra, e a persistência nunca o grava numa rejeição (o índice de reversão
 * única não pode ser ocupado por ela). O campo seria sempre `null`. `OPENING` nunca é rejeitada.
 */
export type WagerTransactionRejectedData = TransactionIdentity &
  SubmittedFields & {
    /** Código estável do domínio (§7.2), nunca a mensagem de uma exceção. */
    failureCode: string;
    referenceExternalTransactionId: string | null;
  };

export type WagerTransactionPendingReferenceData = TransactionIdentity &
  SubmittedFields & {
    /** A transação aguardada (§7, regra 8). */
    referenceExternalTransactionId: string;
  };

/** Qualquer transação aplicada, inclusive `LOSS` (§11) e, por interpretação do projeto, `OPENING`. */
export class WagerTransactionProcessed extends IntegrationEvent<
  'WagerTransactionProcessed',
  WagerTransactionProcessedData
> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  /** `occurredAt` é o `processedAt` da transação. */
  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    const processedAt = transaction.processedAt;
    if (processedAt === undefined) {
      throw new InvalidIntegrationEventError(
        `A transação ${transaction.id} está PROCESSED sem processedAt.`,
      );
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      occurredAt: processedAt,
      data: { ...identityOf(transaction), ...processedFieldsOf(transaction) },
    });
  }
}

/** Transação rejeitada por regra de negócio (§11), com o `failureCode` da decisão (§7.2). */
export class WagerTransactionRejected extends IntegrationEvent<
  'WagerTransactionRejected',
  WagerTransactionRejectedData
> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  /** `at` é o instante da decisão: a transação não registra quando foi rejeitada. */
  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
    at: Date,
  ): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    const failureCode = transaction.failureCode;
    if (failureCode === undefined) {
      throw new InvalidIntegrationEventError(
        `A transação ${transaction.id} está REJECTED sem failureCode.`,
      );
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      occurredAt: at,
      data: {
        ...identityOf(transaction),
        ...submittedFieldsOf(transaction),
        failureCode,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      },
    });
  }
}

/** Entrada em `PENDING_REFERENCE`: referência ausente (§7, regra 8; §11). */
export class WagerTransactionPendingReference extends IntegrationEvent<
  'WagerTransactionPendingReference',
  WagerTransactionPendingReferenceData
> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  /** `at` é o instante da decisão que colocou a transação em espera. */
  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
    at: Date,
  ): WagerTransactionPendingReference {
    assertStatus(
      transaction,
      WagerTransactionStatus.PendingReference,
      'WagerTransactionPendingReference',
    );
    const reference = transaction.referenceExternalTransactionId;
    if (reference === undefined) {
      throw new InvalidIntegrationEventError(
        `A transação ${transaction.id} aguarda referência sem referenceExternalTransactionId.`,
      );
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      occurredAt: at,
      data: {
        ...identityOf(transaction),
        ...submittedFieldsOf(transaction),
        referenceExternalTransactionId: reference,
      },
    });
  }
}

function assertStatus(
  transaction: WagerTransaction,
  expected: WagerTransactionStatus,
  eventType: string,
): void {
  if (transaction.status !== expected) {
    throw new InvalidIntegrationEventError(
      `${eventType} exige uma transação ${expected}; ${transaction.id} está ${transaction.status}.`,
    );
  }
}

function identityOf(transaction: WagerTransaction): TransactionIdentity {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    money: transaction.money.toProps(),
  };
}

function processedFieldsOf(
  transaction: WagerTransaction,
): (SubmittedFields & SubmittedReferences) | OpeningFields {
  const referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
  const referenceTransactionId = transaction.referenceTransactionId ?? null;
  if (transaction.kind !== WagerTransactionKind.Opening) {
    return {
      ...submittedFieldsOf(transaction),
      referenceExternalTransactionId,
      referenceTransactionId,
    };
  }
  if (referenceExternalTransactionId !== null || referenceTransactionId !== null) {
    throw new InvalidIntegrationEventError(`A OPENING ${transaction.id} não tem referência.`);
  }
  return {
    kind: transaction.kind,
    providerId: null,
    externalTransactionId: null,
    roundId: null,
    referenceExternalTransactionId,
    referenceTransactionId,
  };
}

/** Campos externos obrigatórios fora da `OPENING`; faltar um é erro de programação. */
function submittedFieldsOf(transaction: WagerTransaction): SubmittedFields {
  const { kind, providerId, externalTransactionId, roundId } = transaction;
  if (kind === WagerTransactionKind.Opening) {
    throw new InvalidIntegrationEventError(
      `A OPENING ${transaction.id} não tem campos de submissão.`,
    );
  }
  if (providerId === undefined || externalTransactionId === undefined || roundId === undefined) {
    throw new InvalidIntegrationEventError(
      `A transação ${transaction.id} (${kind}) não tem os campos de submissão.`,
    );
  }
  return { kind, providerId, externalTransactionId, roundId };
}
