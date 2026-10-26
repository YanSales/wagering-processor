import { BigIntType, EntitySchema } from '@mikro-orm/core';
import { OUTBOX_EVENT_TYPES } from '../../application/outbox/outbox-message';
import { WagerTransactionRecord } from './wager-transaction.schema';
import { WalletRecord } from './wallet.schema';

/** Linha persistida de `outbox_messages` (modelo de persistência, separado do domínio). */
export class OutboxMessageRecord {
  /** O `eventId` do envelope: o mesmo em toda (re)publicação. */
  id!: string;
  /**
   * Sequência auxiliar, não uma garantia global da ordem dos commits. Por wallet, acompanha a ordem
   * de commit condicionalmente, porque a exclusividade da wallet dura até o commit: em wallet
   * existente, os eventos são gravados sob `FOR UPDATE`; na abertura, na mesma transação que cria a
   * wallet, antes de ela ficar visível. Premissas (ver `ARCHITECTURE.md`): todo caminho de gravação
   * obtém a exclusividade antes do `INSERT`, sem perdê-la por rollback para savepoint; `seq` nunca é
   * fornecido explicitamente; a sequência mantém `CACHE 1` e não é reiniciada nem redefinida. Entre
   * wallets, não indica nada, e não define sozinho a ordem de publicação no SQS FIFO.
   */
  seq!: bigint;
  /** Transação de negócio de origem (inclusive a de `WalletBalanceChanged`, cujo agregado é a wallet). */
  transaction!: WagerTransactionRecord;
  /** `aggregateId` do envelope: a transação ou, em `WalletBalanceChanged`, a wallet. */
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  /** Grupo FIFO da publicação: a wallet (unidade de ordenação, §8). */
  messageGroup!: WalletRecord;
  correlationId!: string;
  /** Envelope completo (`IntegrationEvent.toJSON()`), imutável depois de gravado. */
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  /** Metadados operacionais da publicação (incremento seguinte); os únicos campos que mudam. */
  attempts!: number;
  nextAttemptAt!: Date;
  claimedUntil!: Date | null;
  claimToken!: string | null;
  publishedAt!: Date | null;
  lastErrorCode!: string | null;
}

/** Colunas do conteúdo do evento: o trigger recusa qualquer UPDATE que as altere. */
const IMMUTABLE_COLUMNS: readonly string[] = [
  'id',
  'seq',
  'transaction_id',
  'aggregate_id',
  'event_type',
  'event_version',
  'message_group_id',
  'correlation_id',
  'payload',
  'occurred_at',
];

const row = (alias: 'old' | 'new') =>
  `(${IMMUTABLE_COLUMNS.map((c) => `${alias}.${c}`).join(', ')})`;

/**
 * Corpo do trigger. A comparação fica no corpo, não num `WHEN`: o PostgreSQL guarda o corpo da função
 * como escrito, mas reescreve a expressão do `WHEN`, que então nunca coincidiria com o schema.
 */
const IMMUTABLE_CONTENT_BODY =
  `if ${row('old')} is distinct from ${row('new')} then ` +
  "raise exception 'outbox_messages: o conteúdo do evento é imutável'; end if; return new;";

/**
 * Transactional Outbox (contrato §6.5 e §11): cada linha é um evento gravado na mesma transação SQL
 * da alteração financeira que o originou. A publicação ainda não existe.
 *
 * Constraints:
 * - `UNIQUE (transaction_id, event_type)`: cada tipo sai no máximo uma vez por transação — os estados
 *   `PROCESSED` e `REJECTED` são terminais, há no máximo um lançamento por transação (§6.4) e
 *   `PENDING_REFERENCE` só gera evento na entrada, vinda de `PENDING`. É uma defesa adicional: quem
 *   garante a transição certa é a leitura do estado sob o lock da wallet;
 * - o envelope gravado coincide com as colunas (`eventId`, `eventType`, `version`, `aggregateId`,
 *   `correlationId`, e `walletId`/`transactionId` do `data`);
 * - contadores e lease coerentes (`attempts` não negativo; `claimed_until` e `claim_token` juntos);
 * - imutabilidade: trigger recusa UPDATE das colunas de conteúdo; os metadados operacionais
 *   (`attempts`, `next_attempt_at`, `claimed_until`, `claim_token`, `published_at`,
 *   `last_error_code`) continuam atualizáveis. DELETE não é bloqueado; as linhas publicadas são
 *   mantidas por decisão de projeto, e nada no código as exclui.
 */
export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    seq: { type: new BigIntType('bigint'), autoincrement: true },
    transaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      joinColumn: 'transaction_id',
      foreignKeyName: 'outbox_messages_transaction_id_fk',
    },
    aggregateId: { type: 'uuid' },
    eventType: { enum: true, items: [...OUTBOX_EVENT_TYPES], type: 'text' },
    eventVersion: { type: 'integer' },
    messageGroup: {
      kind: 'm:1',
      entity: () => WalletRecord,
      joinColumn: 'message_group_id',
      foreignKeyName: 'outbox_messages_message_group_id_fk',
    },
    correlationId: { type: 'uuid' },
    payload: { type: 'jsonb' },
    occurredAt: { type: 'timestamptz' },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { type: 'timestamptz' },
    claimedUntil: { type: 'timestamptz', nullable: true },
    claimToken: { type: 'uuid', nullable: true },
    publishedAt: { type: 'timestamptz', nullable: true },
    lastErrorCode: { type: 'text', nullable: true },
  },
  uniques: [
    {
      name: 'outbox_messages_transaction_event_type_unique',
      properties: ['transaction', 'eventType'],
    },
  ],
  checks: [
    { name: 'outbox_messages_event_version_check', expression: 'event_version >= 1' },
    { name: 'outbox_messages_attempts_check', expression: 'attempts >= 0' },
    {
      name: 'outbox_messages_claim_check',
      expression: '(claimed_until is null) = (claim_token is null)',
    },
    {
      // O envelope é a fonte publicada; as colunas existem para consulta e ordenação.
      name: 'outbox_messages_payload_check',
      expression:
        "payload ->> 'eventId' = id::text and payload ->> 'eventType' = event_type " +
        "and (payload ->> 'version')::int = event_version " +
        "and payload ->> 'aggregateId' = aggregate_id::text " +
        "and payload ->> 'correlationId' = correlation_id::text " +
        "and payload -> 'data' ->> 'walletId' = message_group_id::text " +
        "and payload -> 'data' ->> 'transactionId' = transaction_id::text",
    },
  ],
  indexes: [
    {
      // Eventos ainda não publicados, por vencimento (busca do publisher).
      name: 'outbox_messages_unpublished_due_index',
      properties: ['nextAttemptAt', 'seq'],
      where: 'published_at is null',
    },
    {
      // Eventos ainda não publicados de uma wallet, em ordem (ordenação por grupo FIFO).
      name: 'outbox_messages_unpublished_group_index',
      properties: ['messageGroup', 'seq'],
      where: 'published_at is null',
    },
  ],
  triggers: [
    {
      name: 'content_no_update',
      timing: 'before',
      events: ['update'],
      forEach: 'row',
      body: IMMUTABLE_CONTENT_BODY,
    },
  ],
});
