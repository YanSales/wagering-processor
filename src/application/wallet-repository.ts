import { Money } from '../domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/**
 * Resultado de `Wallet.open`, pronto para persistir. `opening` e `openingEntry` existem juntos, só
 * quando o saldo inicial é positivo (contrato §9).
 */
export interface OpenedWallet {
  wallet: Wallet;
  opening: WagerTransaction | null;
  openingEntry: WalletLedgerEntry | null;
  /** Correlação da requisição de abertura, gravada na OPENING e nos eventos dela. */
  correlationId: string;
}

/**
 * Persistência de wallets. A implementação fica na infraestrutura; o domínio não conhece o ORM.
 */
export interface WalletRepository {
  /**
   * Grava a wallet aberta e, se houver, a OPENING, seu lançamento CREDIT e os eventos da abertura na
   * outbox (`WagerTransactionProcessed` e `WalletBalanceChanged`, §11) numa única transação SQL: ou
   * tudo é confirmado, ou nada. Saldo inicial zero não grava evento. Lança `WalletAlreadyExistsError`
   * se já existir wallet para o mesmo `playerId` + `currency`, e `AmountOutOfStorageRangeError`,
   * antes de gravar, se algum valor não couber no armazenamento.
   */
  insertOpened(opened: OpenedWallet): Promise<void>;
}

/**
 * Valor monetário fora da faixa que o armazenamento comporta (ex.: `bigint` do PostgreSQL). É um
 * limite técnico da persistência, não uma regra de negócio: o `Money` não tem limite. Lançado
 * antes de qualquer gravação.
 */
export class AmountOutOfStorageRangeError extends Error {
  override readonly name = 'AmountOutOfStorageRangeError';

  constructor(
    readonly money: Money,
    readonly minCents: bigint,
    readonly maxCents: bigint,
  ) {
    const amount = (cents: bigint) => Money.fromCents(cents, money.currency).toProps().amount;
    super(
      `o valor ${amount(money.cents)} ${money.currency} está fora da faixa armazenável ` +
        `(de ${amount(minCents)} a ${amount(maxCents)}).`,
    );
  }
}

/** Conflito: já existe uma wallet para o mesmo player e moeda (contrato §6.2 e §9). */
export class WalletAlreadyExistsError extends Error {
  override readonly name = 'WalletAlreadyExistsError';

  constructor(
    readonly playerId: string,
    readonly currency: string,
    options?: ErrorOptions,
  ) {
    super(`Já existe uma wallet para o player ${playerId} na moeda ${currency}.`, options);
  }
}
