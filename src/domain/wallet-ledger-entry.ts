import { Money } from './money';

/** Direção de um lançamento no ledger (contrato §6.4). */
export const LedgerDirection = { Debit: 'DEBIT', Credit: 'CREDIT' } as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export interface LedgerEntryState {
  id: string;
  walletId: string;
  /** Transação financeira que produziu o lançamento (ex.: BET, ou OPENING na abertura). */
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger de uma wallet (contrato §6.4).
 *
 * Imutabilidade estrutural: campos somente leitura, instância congelada e datas copiadas na entrada
 * e na saída (`Date` é mutável). `create` valida o lançamento; `rehydrate` apenas reconstrói o
 * estado persistido, sem revalidar (§6.0).
 */
export class WalletLedgerEntry {
  readonly #createdAt: Date;

  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.#createdAt = new Date(createdAt.getTime());
    Object.freeze(this);
  }

  /**
   * Valida e cria um lançamento:
   * - `money` positivo: todo lançamento corresponde a uma alteração de saldo (§6.2, "e vice-versa");
   * - mesma moeda em `money`, `balanceBefore` e `balanceAfter`;
   * - saldos não negativos (saldo nunca negativo, §6.2);
   * - `balanceBefore ± money === balanceAfter` conforme a direção.
   */
  static create(props: LedgerEntryState): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    for (const [name, value] of [
      ['id', props.id],
      ['walletId', props.walletId],
      ['transactionId', props.transactionId],
    ] as const) {
      assertNonEmpty(name, value);
    }
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError(`direção inválida: ${String(props.direction)}.`);
    }
    for (const value of [money, balanceBefore, balanceAfter]) {
      if (!(value instanceof Money)) {
        throw new InvalidLedgerEntryError('money, balanceBefore e balanceAfter devem ser Money.');
      }
    }
    assertValidDate(props.createdAt);
    if (balanceBefore.currency !== money.currency || balanceAfter.currency !== money.currency) {
      throw new InvalidLedgerEntryError(
        `moedas divergentes: money ${money.currency}, saldo anterior ${balanceBefore.currency}, ` +
          `saldo posterior ${balanceAfter.currency}.`,
      );
    }
    if (money.isZero() || money.isNegative()) {
      throw new InvalidLedgerEntryError('o valor do lançamento deve ser positivo.');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('saldos de um lançamento não podem ser negativos.');
    }

    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `aritmética inválida: ${balanceBefore.toProps().amount} ${props.direction} ` +
          `${money.toProps().amount} ≠ ${balanceAfter.toProps().amount}.`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência; não revalida (contrato §6.0). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  /** `balanceBefore ± money === balanceAfter`, conforme a direção. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}

/** Erro de domínio: lançamento de ledger que viola as regras do contrato §6.4. */
export class InvalidLedgerEntryError extends Error {
  override readonly name = 'InvalidLedgerEntryError';

  constructor(detail: string) {
    super(`Lançamento de ledger inválido: ${detail}`);
  }
}

function assertNonEmpty(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLedgerEntryError(`${name} deve ser uma string não vazia.`);
  }
}

function assertValidDate(value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidLedgerEntryError('createdAt deve ser uma data válida.');
  }
}
