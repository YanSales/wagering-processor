import { CurrencyMismatchError, Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  /** A moeda da wallet é a moeda do saldo. */
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identificação do lançamento produzido por uma movimentação. Ids e datas vêm do chamador. */
export interface WalletMovement {
  /** Transação financeira que origina a movimentação (ex.: BET, WIN, OPENING). */
  transactionId: string;
  ledgerEntryId: string;
  money: Money;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openedAt: Date;
  /**
   * Obrigatório se `initialBalance` > 0, proibido se for zero: o saldo inicial positivo gera um
   * lançamento `CREDIT` ligado à transação interna `OPENING` (contrato §9).
   */
  opening?: { transactionId: string; ledgerEntryId: string };
}

/**
 * Wallet (aggregate root, contrato §6.2).
 *
 * - O saldo só muda por `debit`/`credit`, e toda mudança produz exatamente um lançamento do ledger,
 *   validado antes de alterar o estado: não há mudança de saldo sem lançamento nem lançamento sem
 *   mudança de saldo.
 * - Saldo nunca negativo; operações em outra moeda lançam `CurrencyMismatchError`.
 * - `version` começa em 1 na abertura e incrementa somente quando o saldo muda.
 *
 * Unicidade por `playerId` + `currency`, ausência de lost update e a atomicidade entre saldo e
 * ledger são garantias da persistência, não desta classe.
 */
export class Wallet {
  #balance: Money;
  #version: number;
  readonly #createdAt: Date;
  #updatedAt: Date;

  private constructor(
    readonly id: string,
    readonly playerId: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.#balance = balance;
    this.#version = version;
    this.#createdAt = new Date(createdAt.getTime());
    this.#updatedAt = new Date(updatedAt.getTime());
    // Campos `#` continuam mutáveis por debit/credit; o freeze protege id e playerId.
    Object.freeze(this);
  }

  /**
   * Abre a wallet com `version` 1. Saldo inicial positivo gera o lançamento `CREDIT` de abertura
   * (de zero até o saldo inicial), sem incrementar a versão; saldo inicial zero não gera lançamento.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | null } {
    assertNonEmpty('id', props.id);
    assertNonEmpty('playerId', props.playerId);
    assertMoney(props.initialBalance);
    assertValidDate(props.openedAt);
    const { initialBalance, opening } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('o saldo inicial não pode ser negativo.');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance,
      1,
      props.openedAt,
      props.openedAt,
    );
    if (initialBalance.isZero()) {
      if (opening !== undefined) {
        throw new InvalidWalletOperationError(
          'saldo inicial zero não gera lançamento de abertura.',
        );
      }
      return { wallet, openingEntry: null };
    }
    if (opening === undefined) {
      throw new InvalidWalletOperationError(
        'saldo inicial positivo exige a transação OPENING e o id do lançamento de abertura.',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: opening.ledgerEntryId,
      walletId: props.id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: props.openedAt,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência; não revalida transições (contrato §6.0). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get currency(): string {
    return this.#balance.currency;
  }

  get balance(): Money {
    return this.#balance;
  }

  get version(): number {
    return this.#version;
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt.getTime());
  }

  /** Debita `money`; lança `InsufficientFundsError` sem alterar a wallet se o saldo não bastar. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.#assertMovement(movement);
    const after = this.#balance.subtract(movement.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError(this.id, this.#balance, movement.money);
    }
    return this.#apply(LedgerDirection.Debit, movement, after);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.#assertMovement(movement);
    return this.#apply(LedgerDirection.Credit, movement, this.#balance.add(movement.money));
  }

  #assertMovement(movement: WalletMovement): void {
    assertMoney(movement.money);
    if (movement.money.currency !== this.currency) {
      throw new CurrencyMismatchError('movimentar', this.currency, movement.money.currency);
    }
    if (movement.money.isZero() || movement.money.isNegative()) {
      throw new InvalidWalletOperationError(
        'o valor da movimentação deve ser positivo; sem alteração de saldo não há lançamento.',
      );
    }
  }

  // Cria (e assim valida) o lançamento antes de alterar o estado: se falhar, a wallet não muda.
  #apply(direction: LedgerDirection, movement: WalletMovement, after: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this.#balance,
      balanceAfter: after,
      createdAt: movement.at,
    });
    this.#balance = after;
    this.#version += 1;
    this.#updatedAt = entry.createdAt;
    return entry;
  }
}

/** Erro de domínio: débito maior que o saldo disponível. A wallet permanece inalterada. */
export class InsufficientFundsError extends Error {
  override readonly name = 'InsufficientFundsError';

  constructor(
    readonly walletId: string,
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(
      `Saldo insuficiente na wallet ${walletId}: saldo ${balance.toProps().amount}, ` +
        `débito ${requested.toProps().amount} ${requested.currency}.`,
    );
  }
}

/** Erro de domínio: abertura ou movimentação que viola as regras da wallet. */
export class InvalidWalletOperationError extends Error {
  override readonly name = 'InvalidWalletOperationError';

  constructor(detail: string) {
    super(`Operação de wallet inválida: ${detail}`);
  }
}

function assertNonEmpty(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWalletOperationError(`${name} deve ser uma string não vazia.`);
  }
}

function assertMoney(value: unknown): void {
  if (!(value instanceof Money)) {
    throw new InvalidWalletOperationError('valores monetários devem ser instâncias de Money.');
  }
}

function assertValidDate(value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidWalletOperationError('a data deve ser válida.');
  }
}
