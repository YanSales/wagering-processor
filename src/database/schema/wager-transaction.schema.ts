import { BigIntType, EntitySchema } from '@mikro-orm/core';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { WalletRecord } from './wallet.schema';

/** Linha persistida de `wager_transactions` (modelo de persistência, separado do domínio). */
export class WagerTransactionRecord {
  id!: string;
  wallet!: WalletRecord;
  playerId!: string;
  kind!: WagerTransactionKind;
  status!: WagerTransactionStatus;
  /** Campos de submissão externa (API/fila): `null` somente em `OPENING`, que é interna. */
  providerId!: string | null;
  externalTransactionId!: string | null;
  idempotencyKey!: string | null;
  payloadHash!: string | null;
  roundId!: string | null;
  gameId!: string | null;
  moneyCents!: bigint;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  /** Transação referenciada já resolvida (id interno); preenchida quando a referência é aplicada. */
  referenceTransaction!: WagerTransactionRecord | null;
  failureCode!: string | null;
  /**
   * Saldo da wallet (na moeda da wallet) observado ao concluir a transação: devolvido no replay
   * (contrato §7, regra 7), inclusive de uma rejeição, que não tem lançamento. `null` na `OPENING`.
   */
  resultBalanceCents!: bigint | null;
  /** Tentativas de resolução feitas pelo worker de referências pendentes (§7.1). */
  referenceAttempts!: number;
  /** Próxima tentativa de resolução; preenchida somente em `PENDING_REFERENCE`. */
  nextReferenceAttemptAt!: Date | null;
  /**
   * Falhas operacionais seguidas (nem transitórias nem de negócio) nas tentativas do worker: definem
   * a quarentena com backoff. Não contam como tentativa de resolução (`referenceAttempts`) e voltam a
   * zero quando uma tentativa é concluída.
   */
  processingFailures!: number;
  createdAt!: Date;
  processedAt!: Date | null;
}

const SUBMISSION_COLUMNS = [
  'provider_id',
  'external_transaction_id',
  'idempotency_key',
  'payload_hash',
  'round_id',
  'game_id',
];

/**
 * Constraints aplicadas no schema (§5.9):
 * - `UNIQUE (idempotency_key)`: a chave é a fonte da verdade da idempotência (§9);
 * - `UNIQUE (provider_id, external_transaction_id)`: inferência necessária para a resolução de
 *   referências por esse par (§7, regra 2) e para a consulta por provedor (§9) devolverem uma única
 *   transação;
 * - reversão única por referência e tipo (§7, regra 4): índice único parcial em
 *   `(reference_transaction_id, kind)` para REFUND/ROLLBACK;
 * - `OPENING` única por wallet: inferência do §9 (o crédito de abertura nasce uma vez, na criação);
 * - REFUND/ROLLBACK exigem referência externa (§7, regra 1); valor não negativo (§6.1);
 * - `OPENING` não tem campos de submissão nem referências; os demais tipos exigem os campos de
 *   submissão (§6.3), sem valores sintéticos.
 * A moeda não tem FK composta para a wallet: uma transação em moeda divergente precisa poder ser
 * persistida como REJECTED (auditável). O `failureCode` só tem o formato validado no banco; os
 * códigos usados estão em `src/application/failure-codes.ts`.
 * - submissão concluída (`PROCESSED`/`REJECTED`) guarda o saldo observado, não negativo.
 * - `PENDING_REFERENCE` (§7, regra 8) existe somente com referência externa e próxima tentativa
 *   agendada; nenhum outro estado tem tentativa agendada. O índice parcial atende a busca do worker.
 * - `processing_failures` (quarentena de falhas operacionais do worker) não é negativo e só é
 *   diferente de zero em `PENDING_REFERENCE`.
 */
export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    wallet: {
      kind: 'm:1',
      entity: () => WalletRecord,
      joinColumn: 'wallet_id',
      foreignKeyName: 'wager_transactions_wallet_id_fk',
    },
    playerId: { type: 'text' },
    kind: { enum: true, items: Object.values(WagerTransactionKind), type: 'text' },
    status: { enum: true, items: Object.values(WagerTransactionStatus), type: 'text' },
    providerId: { type: 'text', nullable: true },
    externalTransactionId: { type: 'text', nullable: true },
    idempotencyKey: { type: 'text', nullable: true },
    payloadHash: { type: 'text', nullable: true },
    roundId: { type: 'text', nullable: true },
    gameId: { type: 'text', nullable: true },
    moneyCents: { type: new BigIntType('bigint') },
    currency: { type: 'character', length: 3 },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      joinColumn: 'reference_transaction_id',
      nullable: true,
      // Sem `set null` (padrão do ORM para relação anulável): transações não são excluídas.
      deleteRule: 'no action',
      foreignKeyName: 'wager_transactions_reference_transaction_id_fk',
    },
    failureCode: { type: 'text', nullable: true },
    resultBalanceCents: { type: new BigIntType('bigint'), nullable: true },
    referenceAttempts: { type: 'integer', default: 0 },
    nextReferenceAttemptAt: { type: 'timestamptz', nullable: true },
    processingFailures: { type: 'integer', default: 0 },
    createdAt: { type: 'timestamptz' },
    processedAt: { type: 'timestamptz', nullable: true },
  },
  uniques: [
    { name: 'wager_transactions_idempotency_key_unique', properties: ['idempotencyKey'] },
    {
      name: 'wager_transactions_provider_external_unique',
      properties: ['providerId', 'externalTransactionId'],
    },
    {
      name: 'wager_transactions_reversal_once_unique',
      properties: ['referenceTransaction', 'kind'],
      where: "kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null",
    },
    {
      name: 'wager_transactions_opening_once_unique',
      properties: ['wallet'],
      where: "kind = 'OPENING'",
    },
  ],
  checks: [
    { name: 'wager_transactions_money_cents_check', expression: 'money_cents >= 0' },
    { name: 'wager_transactions_currency_check', expression: "currency ~ '^[A-Z]{3}$'" },
    {
      name: 'wager_transactions_failure_code_check',
      expression: "failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]*$'",
    },
    {
      name: 'wager_transactions_reference_required_check',
      expression:
        "kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null",
    },
    {
      name: 'wager_transactions_submission_fields_check',
      expression:
        `(kind = 'OPENING' and ${SUBMISSION_COLUMNS.map((c) => `${c} is null`).join(' and ')} ` +
        'and reference_external_transaction_id is null and reference_transaction_id is null) or ' +
        `(kind <> 'OPENING' and ${SUBMISSION_COLUMNS.map((c) => `${c} is not null`).join(' and ')})`,
    },
    {
      name: 'wager_transactions_result_balance_check',
      expression: 'result_balance_cents is null or result_balance_cents >= 0',
    },
    {
      // O replay de uma submissão concluída precisa do saldo observado (§7, regra 7).
      name: 'wager_transactions_result_balance_required_check',
      expression:
        "kind = 'OPENING' or status not in ('PROCESSED', 'REJECTED') or result_balance_cents is not null",
    },
    {
      name: 'wager_transactions_reference_attempts_check',
      expression: 'reference_attempts >= 0',
    },
    {
      // Aguardar a referência (§6.3) exige uma referência e uma próxima tentativa (§7.1).
      name: 'wager_transactions_pending_reference_schedule_check',
      expression:
        "(status = 'PENDING_REFERENCE' and next_reference_attempt_at is not null " +
        'and reference_external_transaction_id is not null) or ' +
        "(status <> 'PENDING_REFERENCE' and next_reference_attempt_at is null)",
    },
    {
      name: 'wager_transactions_processing_failures_check',
      expression: 'processing_failures >= 0',
    },
    {
      // A quarentena só existe enquanto se aguarda a referência; a transição a zera.
      name: 'wager_transactions_processing_failures_pending_check',
      expression: "status = 'PENDING_REFERENCE' or processing_failures = 0",
    },
  ],
  indexes: [
    {
      name: 'wager_transactions_pending_reference_due_index',
      properties: ['nextReferenceAttemptAt'],
      where: "status = 'PENDING_REFERENCE'",
    },
  ],
});
