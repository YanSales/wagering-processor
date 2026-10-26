import type { Money } from '../domain/money';
import type {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/** Identidades de uma submissão que o banco mantém únicas. */
export interface SubmissionKeys {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
}

/** Submissão já persistida, com o resultado original (contrato §7, regra 7). */
export interface StoredSubmission {
  transactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  providerId: string;
  externalTransactionId: string;
  status: WagerTransactionStatus;
  failureCode: FailureCode | undefined;
  /**
   * Saldo da wallet observado ao concluir, na moeda da wallet; em `PENDING_REFERENCE`, o observado ao
   * aceitar, substituído quando o worker conclui a transação.
   */
  resultBalance: Money;
}

/** Submissões já gravadas com a mesma chave de idempotência ou o mesmo `(providerId, externalTransactionId)`. */
export interface ExistingSubmissions {
  byIdempotencyKey: StoredSubmission | null;
  byExternalTransaction: StoredSubmission | null;
}

/** Resultado de uma submissão decidido sobre a wallet travada, pronto para gravar. */
export interface SubmissionDecision {
  /** Transação em `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`. */
  transaction: WagerTransaction;
  /** A wallet recebida por `decide`, já movimentada se houver lançamento. */
  wallet: Wallet;
  /** Lançamento da movimentação, ou `null` quando a transação não altera o saldo. */
  ledgerEntry: WalletLedgerEntry | null;
  /** Próxima tentativa de resolução: obrigatória em `PENDING_REFERENCE`, proibida nos demais. */
  nextReferenceAttemptAt?: Date;
}

/** Referência a resolver sob o lock da wallet (contrato §7, regra 2). */
export interface ReferenceQuery {
  providerId: string;
  /** `referenceExternalTransactionId` da transação que referencia. */
  externalTransactionId: string;
  /** Tipo da reversão, para a regra 4 (`REFUND` ou `ROLLBACK`). */
  reversalKind: WagerTransactionKind;
}

/** Transação referenciada, lida sob o lock da wallet da transação que a referencia. */
export interface ResolvedReference {
  transaction: WagerTransaction;
  /** Já revertida por uma transação `PROCESSED` do tipo da consulta (§7, regra 4). */
  alreadyReversed: boolean;
}

export type SubmissionOutcome =
  | { kind: 'APPLIED'; submission: StoredSubmission }
  | { kind: 'EXISTING'; existing: ExistingSubmissions };

/** Persistência de submissões de transações. A implementação fica na infraestrutura. */
export interface WagerTransactionRepository {
  /** Busca submissões existentes, fora de qualquer transação (caminho rápido de replay). */
  findExisting(keys: SubmissionKeys): Promise<ExistingSubmissions>;

  /**
   * Numa única transação SQL: trava a wallet contra escritas concorrentes de qualquer instância,
   * confere de novo se a submissão já existe (se existir, devolve `EXISTING` sem chamar `decide`),
   * chama `decide` com a wallet travada e grava transação, saldo, versão e lançamento juntos.
   *
   * Com `reference`, a transação referenciada é lida sob o mesmo lock e entregue a `decide` (`null`
   * se ainda não existir); sem ela, `decide` recebe `null`. Uma decisão `PENDING_REFERENCE` é gravada
   * com a próxima tentativa, sem lançamento.
   *
   * Se outra submissão com as mesmas chaves for confirmada em paralelo (por outra wallet), devolve
   * `EXISTING` sem aplicar efeito. Lança `WalletNotFoundError` se a wallet não existir; outros erros
   * desfazem a transação inteira.
   *
   * Os dois métodos lançam `TransientPersistenceError` em falhas transitórias do banco.
   */
  applyToLockedWallet(
    walletId: string,
    keys: SubmissionKeys,
    decide: (wallet: Wallet, reference: ResolvedReference | null) => SubmissionDecision,
    reference?: ReferenceQuery,
  ): Promise<SubmissionOutcome>;
}

/** Transação em `PENDING_REFERENCE` com a tentativa vencida. */
export interface PendingReferenceTask {
  transactionId: string;
  walletId: string;
}

/** Estado lido sob o lock da wallet para uma tentativa de resolução. */
export interface PendingReferenceState {
  /** Transação reidratada em `PENDING_REFERENCE`. */
  transaction: WagerTransaction;
  wallet: Wallet;
  reference: ResolvedReference | null;
  /** Tentativas do worker já feitas antes desta. */
  completedAttempts: number;
}

/** Persistência do reprocessamento de `PENDING_REFERENCE` (contrato §7.1). */
export interface PendingReferenceRepository {
  /** Até `limit` transações pendentes com a tentativa vencida em `now`, as mais antigas primeiro. */
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceTask[]>;

  /**
   * Numa única transação SQL: trava a wallet (mesma ordem de locks da submissão), relê a transação e
   * só segue se ela ainda estiver em `PENDING_REFERENCE` com a tentativa vencida em `now` — outro
   * worker pode tê-la resolvido. Então chama `decide` com a referência lida sob o lock e grava
   * transação (tentativa contada), saldo, versão e lançamento juntos. A decisão pode ser `PROCESSED`,
   * `REJECTED` ou de novo `PENDING_REFERENCE`, com a próxima tentativa.
   *
   * Devolve `false` se não havia nada a fazer. Falhas desfazem tudo, sem consumir a tentativa;
   * transitórias viram `TransientPersistenceError`.
   */
  resolvePendingReference(
    task: PendingReferenceTask,
    now: Date,
    decide: (state: PendingReferenceState) => SubmissionDecision,
  ): Promise<boolean>;
}

/**
 * Falha transitória da persistência (conexão, deadlock, serialização, servidor indisponível). Nada
 * foi confirmado; repetir a mesma submissão é seguro, porque a idempotência é persistente.
 */
export class TransientPersistenceError extends Error {
  override readonly name = 'TransientPersistenceError';

  constructor(options: ErrorOptions) {
    super('Falha transitória da persistência; a operação pode ser repetida.', options);
  }
}

/** A wallet da submissão não existe; nada é gravado. */
export class WalletNotFoundError extends Error {
  override readonly name = 'WalletNotFoundError';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} não encontrada.`);
  }
}
