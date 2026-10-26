import type { Money } from '../domain/money';
import type {
  FailureCode,
  WagerTransaction,
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
  /** Saldo da wallet observado ao concluir, na moeda da wallet. */
  resultBalance: Money;
}

/** Submissões já gravadas com a mesma chave de idempotência ou o mesmo `(providerId, externalTransactionId)`. */
export interface ExistingSubmissions {
  byIdempotencyKey: StoredSubmission | null;
  byExternalTransaction: StoredSubmission | null;
}

/** Resultado de uma submissão decidido sobre a wallet travada, pronto para gravar. */
export interface SubmissionDecision {
  /** Transação em estado terminal (`PROCESSED` ou `REJECTED`). */
  transaction: WagerTransaction;
  /** A wallet recebida por `decide`, já movimentada se houver lançamento. */
  wallet: Wallet;
  /** Lançamento da movimentação, ou `null` quando a transação não altera o saldo. */
  ledgerEntry: WalletLedgerEntry | null;
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
   * Se outra submissão com as mesmas chaves for confirmada em paralelo (por outra wallet), devolve
   * `EXISTING` sem aplicar efeito. Lança `WalletNotFoundError` se a wallet não existir; outros erros
   * desfazem a transação inteira.
   *
   * Os dois métodos lançam `TransientPersistenceError` em falhas transitórias do banco.
   */
  applyToLockedWallet(
    walletId: string,
    keys: SubmissionKeys,
    decide: (wallet: Wallet) => SubmissionDecision,
  ): Promise<SubmissionOutcome>;
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
