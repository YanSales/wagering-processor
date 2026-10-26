import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { InvalidIntegrationEventError } from './integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from './wager-transaction-events';
import { WalletBalanceChanged } from './wallet-balance-changed';

/** Qualquer evento de integração produzido por uma transição. */
export type TransactionEvent =
  | WagerTransactionProcessed
  | WagerTransactionRejected
  | WagerTransactionPendingReference
  | WalletBalanceChanged;

/** JSON de qualquer evento de transição, discriminado por `eventType`. */
export type TransactionEventEnvelope = ReturnType<TransactionEvent['toJSON']>;

export interface TransitionEventsInput {
  /** Transação **depois** da decisão. */
  transaction: WagerTransaction;
  /** Estado da transação **antes** da decisão (`PENDING` na submissão, `PENDING_REFERENCE` no worker). */
  previousStatus: WagerTransactionStatus;
  /** Wallet depois da decisão (movimentada, se houve lançamento). */
  wallet: Wallet;
  /** Lançamento da decisão, ou `null` quando o saldo não muda. */
  ledgerEntry: WalletLedgerEntry | null;
  /** Correlação da operação original; no worker, a gravada na submissão. */
  correlationId: string;
  /** Instante da decisão. */
  at: Date;
  /** Gera o `eventId` de cada evento, na ordem em que são produzidos. */
  newId: () => string;
}

/**
 * Eventos de uma transição de transação submetida, na ordem em que devem ser gravados (contrato §11;
 * decisões do projeto para o que o contrato não fixa). Função pura: não grava nem publica nada.
 *
 * | Transição                                   | Eventos                                         |
 * | ------------------------------------------- | ----------------------------------------------- |
 * | → `PROCESSED` com lançamento (BET, WIN, …)  | `WagerTransactionProcessed`, `WalletBalanceChanged` |
 * | → `PROCESSED` sem lançamento (`LOSS`)       | `WagerTransactionProcessed`                      |
 * | → `REJECTED`                                | `WagerTransactionRejected`                       |
 * | `PENDING` → `PENDING_REFERENCE` (entrada)   | `WagerTransactionPendingReference`               |
 * | `PENDING_REFERENCE` → `PENDING_REFERENCE`   | nenhum (reagendamento)                           |
 *
 * O evento de espera é derivado da **transição**, não do estado final: o reagendamento do worker
 * também termina em `PENDING_REFERENCE` e não pode gerar um segundo evento.
 *
 * As entradas precisam ser coerentes com as regras do domínio; o contrário é erro de programação e
 * lança `InvalidIntegrationEventError`:
 * - a transação é da wallet informada; aplicada ou em espera, também do player dela
 *   (`assertMovementPreconditions`). Uma rejeição pode ser justamente por player divergente
 *   (`PLAYER_WALLET_MISMATCH`), então ali o player não é conferido;
 * - só transações com referência externa esperam por ela (`markPendingReference`), e uma reversão
 *   aplicada, ou uma resolução tardia, tem o id interno da referência (`markProcessed`);
 * - há lançamento exatamente quando o saldo muda (`affectsBalance`), e ele é da transação e da
 *   wallet, com o valor da transação e a direção do tipo (`ledgerDirectionFor`).
 */
export function eventsForTransition(input: TransitionEventsInput): TransactionEvent[] {
  const { transaction, previousStatus, wallet, ledgerEntry } = input;
  if (
    previousStatus !== WagerTransactionStatus.Pending &&
    previousStatus !== WagerTransactionStatus.PendingReference
  ) {
    throw new InvalidIntegrationEventError(
      `A transação ${transaction.id} não pode mudar a partir de ${previousStatus}.`,
    );
  }
  if (transaction.kind === WagerTransactionKind.Opening) {
    throw new InvalidIntegrationEventError(
      'A OPENING não é uma transição de submissão; use eventsForWalletOpening.',
    );
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidIntegrationEventError(
      `A transação ${transaction.id} não é da wallet ${wallet.id}.`,
    );
  }
  if (
    previousStatus === WagerTransactionStatus.PendingReference &&
    transaction.referenceExternalTransactionId === undefined
  ) {
    throw new InvalidIntegrationEventError(
      `A transação ${transaction.id} não referencia outra e não poderia aguardar referência.`,
    );
  }
  if (ledgerEntry !== null && ledgerEntry.transactionId !== transaction.id) {
    throw new InvalidIntegrationEventError(
      `O lançamento ${ledgerEntry.id} não pertence à transação ${transaction.id}.`,
    );
  }
  const context = () => ({ eventId: input.newId(), correlationId: input.correlationId });

  switch (transaction.status) {
    case WagerTransactionStatus.Processed: {
      assertSamePlayer(transaction, wallet);
      const mustResolve =
        transaction.requiresReference() ||
        previousStatus === WagerTransactionStatus.PendingReference;
      if (mustResolve && transaction.referenceTransactionId === undefined) {
        throw new InvalidIntegrationEventError(
          `${transaction.kind} ${transaction.id} aplicada sem o id interno da referência.`,
        );
      }
      // Só o LOSS é aplicado sem mover o saldo (§6.3, `affectsBalance`).
      if (transaction.affectsBalance() !== (ledgerEntry !== null)) {
        throw new InvalidIntegrationEventError(
          `${transaction.kind} ${transaction.id} aplicada ${ledgerEntry === null ? 'sem' : 'com'} lançamento.`,
        );
      }
      if (ledgerEntry === null) return [WagerTransactionProcessed.from(transaction, context())];
      assertMovementOf(transaction, wallet, ledgerEntry);
      return [
        WagerTransactionProcessed.from(transaction, context()),
        WalletBalanceChanged.from(wallet, ledgerEntry, context()),
      ];
    }
    case WagerTransactionStatus.Rejected:
      assertNoLedger(transaction, ledgerEntry);
      return [WagerTransactionRejected.from(transaction, context(), input.at)];
    case WagerTransactionStatus.PendingReference:
      assertSamePlayer(transaction, wallet);
      assertNoLedger(transaction, ledgerEntry);
      return previousStatus === WagerTransactionStatus.Pending
        ? [WagerTransactionPendingReference.from(transaction, context(), input.at)]
        : [];
    default:
      throw new InvalidIntegrationEventError(
        `Nenhum evento definido para a transação ${transaction.id} em ${transaction.status}.`,
      );
  }
}

export interface WalletOpeningEventsInput {
  /** Wallet recém-aberta (versão 1). */
  wallet: Wallet;
  /** `OPENING` aplicada, ou `null` quando o saldo inicial é zero. */
  opening: WagerTransaction | null;
  /** Crédito de abertura, ou `null` quando o saldo inicial é zero. */
  openingEntry: WalletLedgerEntry | null;
  correlationId: string;
  newId: () => string;
}

/**
 * Eventos da abertura de wallet. **Interpretação adotada pelo projeto**, não regra explícita do
 * contrato:
 * - saldo inicial positivo: `WagerTransactionProcessed` da `OPENING` ("qualquer transação aplicada",
 *   §11) e `WalletBalanceChanged` do crédito de 0 até o saldo inicial, com `walletVersion` 1 (a
 *   criação não incrementa a versão, §6.2);
 * - saldo inicial zero: não há `OPENING` nem lançamento (§9), e nenhum evento.
 *
 * As entradas precisam ser as de `Wallet.open` e `WagerTransaction.opening`: wallet na versão 1;
 * sem `OPENING`, saldo zero; com ela, OPENING da wallet e do player dela, e um único `CREDIT` de 0
 * até o saldo inicial, no valor da OPENING. O contrário lança `InvalidIntegrationEventError`.
 */
export function eventsForWalletOpening(input: WalletOpeningEventsInput): TransactionEvent[] {
  const { wallet, opening, openingEntry } = input;
  if (wallet.version !== 1) {
    throw new InvalidIntegrationEventError(
      `A wallet ${wallet.id} está na versão ${wallet.version}; uma abertura está na versão 1.`,
    );
  }
  if (opening === null || openingEntry === null) {
    if (opening !== null || openingEntry !== null) {
      throw new InvalidIntegrationEventError(
        `A abertura da wallet ${wallet.id} precisa de OPENING e lançamento juntos, ou de nenhum.`,
      );
    }
    if (!wallet.balance.isZero()) {
      throw new InvalidIntegrationEventError(
        `A wallet ${wallet.id} tem saldo inicial positivo e nenhuma OPENING.`,
      );
    }
    return [];
  }
  if (opening.kind !== WagerTransactionKind.Opening) {
    throw new InvalidIntegrationEventError(
      `A abertura da wallet ${wallet.id} recebeu ${opening.kind} ${opening.id}, não uma OPENING.`,
    );
  }
  if (opening.walletId !== wallet.id) {
    throw new InvalidIntegrationEventError(`A OPENING ${opening.id} não é da wallet ${wallet.id}.`);
  }
  assertSamePlayer(opening, wallet);
  if (!openingEntry.balanceBefore.isZero()) {
    throw new InvalidIntegrationEventError(
      `O crédito de abertura ${openingEntry.id} não parte de saldo zero.`,
    );
  }
  if (openingEntry.transactionId !== opening.id) {
    throw new InvalidIntegrationEventError(
      `O lançamento ${openingEntry.id} não pertence à OPENING ${opening.id}.`,
    );
  }
  assertMovementOf(opening, wallet, openingEntry);
  const context = () => ({ eventId: input.newId(), correlationId: input.correlationId });
  return [
    WagerTransactionProcessed.from(opening, context()),
    WalletBalanceChanged.from(wallet, openingEntry, context()),
  ];
}

/** A wallet pertence ao player da transação (`assertMovementPreconditions`). */
function assertSamePlayer(transaction: WagerTransaction, wallet: Wallet): void {
  if (transaction.playerId !== wallet.playerId) {
    throw new InvalidIntegrationEventError(
      `A transação ${transaction.id} é do player ${transaction.playerId}; a wallet ${wallet.id}, do ${wallet.playerId}.`,
    );
  }
}

/**
 * O lançamento é a movimentação da transação na wallet: toda movimentação usa o valor da transação
 * (`applyBet`, `applyWin`, `applyReversal`, `Wallet.open`) e a direção do tipo. A direção de um
 * `ROLLBACK` depende da transação revertida (`ledgerDirectionFor(reference)`), que não está nesta
 * entrada; ela não é conferida aqui.
 */
function assertMovementOf(
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry,
): void {
  if (entry.walletId !== wallet.id) {
    throw new InvalidIntegrationEventError(
      `O lançamento ${entry.id} é da wallet ${entry.walletId}, não da ${wallet.id}.`,
    );
  }
  if (!entry.money.equals(transaction.money)) {
    throw new InvalidIntegrationEventError(
      `O lançamento ${entry.id} tem valor ${entry.money.toProps().amount} ${entry.money.currency}; ` +
        `a transação ${transaction.id}, ${transaction.money.toProps().amount} ${transaction.money.currency}.`,
    );
  }
  if (transaction.kind !== WagerTransactionKind.Rollback) {
    const expected = transaction.ledgerDirectionFor();
    if (entry.direction !== expected) {
      throw new InvalidIntegrationEventError(
        `O lançamento ${entry.id} é ${entry.direction}; ${transaction.kind} exige ${expected}.`,
      );
    }
  }
}

function assertNoLedger(
  transaction: WagerTransaction,
  ledgerEntry: WalletLedgerEntry | null,
): void {
  if (ledgerEntry !== null) {
    throw new InvalidIntegrationEventError(
      `A transação ${transaction.id} em ${transaction.status} não pode ter lançamento.`,
    );
  }
}
