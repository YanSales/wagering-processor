import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

/** Tipos de transação (contrato §6.3). `OPENING` é interno: não é submetido pela API nem pela fila. */
export const WagerTransactionKind = {
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;
export type WagerTransactionKind = (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

/** Estados (contrato §6.3). `PROCESSED`, `REJECTED` e `FAILED` são terminais. */
export const WagerTransactionStatus = {
  Pending: 'PENDING',
  PendingReference: 'PENDING_REFERENCE',
  Processed: 'PROCESSED',
  Rejected: 'REJECTED',
  Failed: 'FAILED',
} as const;
export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

/**
 * Código de falha estável e legível por máquina (contrato §7.2). A taxonomia ainda não foi definida;
 * o domínio só exige o formato: letras maiúsculas, dígitos e `_`, começando por letra.
 */
export type FailureCode = string;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id da transação referenciada no provedor, não o id interno. Obrigatório em REFUND e ROLLBACK. */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);
const REQUIRES_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);
/** Tipos que um ROLLBACK pode reverter (contrato §7, regra 3). */
const ROLLBACK_TARGETS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);
const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);
const FAILURE_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Transação de aposta e sua máquina de estados (contrato §6.3).
 *
 * Transições válidas; as demais lançam `InvalidTransactionStateError` sem alterar o estado:
 *
 *   PENDING ou PENDING_REFERENCE -> PROCESSED          markProcessed(referenceTransactionId, at)
 *     (a partir de PENDING_REFERENCE, sempre com o id interno da referência resolvida)
 *   PENDING ou PENDING_REFERENCE -> PENDING_REFERENCE  markPendingReference() (exige referência)
 *   PENDING ou PENDING_REFERENCE -> REJECTED           reject(code)
 *   PENDING ou PENDING_REFERENCE -> FAILED             fail(code)
 *
 * Estados terminais (PROCESSED, REJECTED, FAILED) não mudam mais. A máquina não interpreta o valor
 * da transação: decidir se uma operação é aplicada ou rejeitada cabe ao processamento.
 */
export class WagerTransaction {
  #status: WagerTransactionStatus;
  #referenceTransactionId: string | undefined;
  #failureCode: FailureCode | undefined;
  #processedAt: Date | undefined;
  readonly #createdAt: Date;

  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId: string | undefined,
    failureCode: FailureCode | undefined,
    processedAt: Date | undefined,
  ) {
    this.#createdAt = new Date(createdAt.getTime());
    this.#status = status;
    this.#referenceTransactionId = referenceTransactionId;
    this.#failureCode = failureCode;
    this.#processedAt = processedAt === undefined ? undefined : new Date(processedAt.getTime());
    // Campos `#` mudam só pelas transições; o freeze protege os campos públicos.
    Object.freeze(this);
  }

  /**
   * Cria uma transação submetida (API ou fila) em `PENDING`. Valida os campos e a exigência de
   * referência por tipo: `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. `OPENING`
   * é interno e não é aceito aqui. O valor não pode ser negativo (contrato §6.1); zero é aceito, e
   * seu tratamento de negócio cabe ao processamento.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const required = [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const;
    for (const name of required) {
      assertNonEmpty(name, props[name]);
    }
    if (!SUBMITTABLE_KINDS.has(props.kind)) {
      throw new InvalidWagerTransactionError(
        props.kind === WagerTransactionKind.Opening
          ? 'OPENING é interno e não pode ser submetido.'
          : `kind inválido: ${String(props.kind)}.`,
      );
    }
    if (!(props.money instanceof Money)) {
      throw new InvalidWagerTransactionError('money deve ser uma instância de Money.');
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('money não pode ser negativo.');
    }
    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined) {
      assertNonEmpty('referenceExternalTransactionId', reference);
    } else if (REQUIRES_REFERENCE.has(props.kind)) {
      throw new InvalidWagerTransactionError(`${props.kind} exige referenceExternalTransactionId.`);
    }
    assertValidDate('createdAt', props.createdAt);

    return WagerTransaction.rehydrate({ ...props, status: WagerTransactionStatus.Pending });
  }

  /** Reconstrução a partir da persistência; não revalida transições (contrato §6.0). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this.#status;
  }

  get referenceTransactionId(): string | undefined {
    return this.#referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this.#failureCode;
  }

  get processedAt(): Date | undefined {
    return this.#processedAt === undefined ? undefined : new Date(this.#processedAt.getTime());
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  /**
   * Marca como aplicada. `referenceTransactionId` é o id interno da transação referenciada: exigido
   * quando o tipo exige referência ou quando a transação está em `PENDING_REFERENCE` (aguardando a
   * referência, §6.3 e §7.1), e proibido quando não há referência externa a resolver.
   */
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.#assertNotTerminal('markProcessed');
    if (referenceTransactionId !== undefined) {
      if (this.referenceExternalTransactionId === undefined) {
        this.#invalid('markProcessed', 'não há referência externa a resolver.');
      }
      assertNonEmpty('referenceTransactionId', referenceTransactionId);
    } else if (this.#status === WagerTransactionStatus.PendingReference) {
      this.#invalid(
        'markProcessed',
        'a transação aguarda a referência; informe o id interno da transação referenciada.',
      );
    } else if (this.requiresReference()) {
      this.#invalid('markProcessed', `${this.kind} exige o id interno da transação referenciada.`);
    }
    assertValidDate('at', at);

    this.#status = WagerTransactionStatus.Processed;
    this.#referenceTransactionId = referenceTransactionId;
    this.#processedAt = new Date(at.getTime());
  }

  /** Aguarda a transação referenciada (§7.1). Exige referência externa; repetível enquanto aguarda. */
  markPendingReference(): void {
    this.#assertNotTerminal('markPendingReference');
    if (this.referenceExternalTransactionId === undefined) {
      this.#invalid('markPendingReference', 'a transação não referencia outra transação.');
    }
    this.#status = WagerTransactionStatus.PendingReference;
  }

  /** Rejeição por regra de negócio (terminal). */
  reject(code: FailureCode): void {
    this.#assertNotTerminal('reject');
    assertFailureCode(code);
    this.#status = WagerTransactionStatus.Rejected;
    this.#failureCode = code;
  }

  /** Erro permanente de infraestrutura (terminal, auditável). */
  fail(code: FailureCode): void {
    this.#assertNotTerminal('fail');
    assertFailureCode(code);
    this.#status = WagerTransactionStatus.Failed;
    this.#failureCode = code;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this.#status);
  }

  /** `false` somente para `LOSS`, que registra o resultado sem mover saldo (contrato §6.3 e §7). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** `true` para `REFUND` e `ROLLBACK` (contrato §7, regra 1). */
  requiresReference(): boolean {
    return REQUIRES_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger (contrato §7): `BET` debita; `WIN`, `REFUND` e `OPENING`
   * creditam; `ROLLBACK` inverte a direção da referência, que deve ser `BET`, `WIN` ou `REFUND`.
   * `LOSS` não gera lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!(reference instanceof WagerTransaction) || !ROLLBACK_TARGETS.has(reference.kind)) {
          throw new InvalidWagerTransactionError(
            'ROLLBACK exige como referência uma transação BET, WIN ou REFUND.',
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS não gera lançamento no ledger.');
      default:
        throw new InvalidWagerTransactionError(`kind inválido: ${String(this.kind)}.`);
    }
  }

  #assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      this.#invalid(transition, 'o estado atual é terminal.');
    }
  }

  #invalid(transition: string, detail: string): never {
    throw new InvalidTransactionStateError(this.id, this.#status, transition, detail);
  }
}

/**
 * Transição não permitida no estado atual. Erro de programação, não caminho de negócio (§6.3).
 * O estado da transação permanece inalterado.
 */
export class InvalidTransactionStateError extends Error {
  override readonly name = 'InvalidTransactionStateError';

  constructor(
    readonly transactionId: string,
    readonly status: WagerTransactionStatus,
    readonly transition: string,
    detail: string,
  ) {
    super(`Transição ${transition} inválida para ${transactionId} em ${status}: ${detail}`);
  }
}

/** Erro de domínio: dados de transação que violam o contrato §6.3 ou §7. */
export class InvalidWagerTransactionError extends Error {
  override readonly name = 'InvalidWagerTransactionError';

  constructor(detail: string) {
    super(`Transação inválida: ${detail}`);
  }
}

function assertNonEmpty(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWagerTransactionError(`${name} deve ser uma string não vazia.`);
  }
}

function assertValidDate(name: string, value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidWagerTransactionError(`${name} deve ser uma data válida.`);
  }
}

function assertFailureCode(code: unknown): void {
  if (typeof code !== 'string' || !FAILURE_CODE.test(code)) {
    const shown = typeof code === 'string' ? `"${code}"` : typeof code;
    throw new InvalidWagerTransactionError(
      `failureCode inválido: ${shown}. Use letras maiúsculas, dígitos e "_", começando por letra.`,
    );
  }
}
