import { Migration } from '@mikro-orm/migrations';

/**
 * Transactional Outbox (contrato §6.5 e §11) e correlação persistida das transações.
 *
 * Gerada por `migration:create`, com um ajuste manual: `correlation_id` entra anulável, as transações
 * já existentes recebem uma correlação nova (não há outra informação de origem para elas) e só então
 * a coluna passa a `not null`. Nenhuma linha existente é alterada além disso.
 *
 * O UUID do backfill é sintético: torna consistente a correlação dos eventos gerados a partir desta
 * migration, mas não recupera a correlação original. Transações já em `PENDING_REFERENCE` não
 * recebem retroativamente `WagerTransactionPendingReference`; se forem resolvidas depois, os novos
 * eventos usam a correlação gravada aqui.
 *
 * `seq` é `bigserial`, com `CACHE 1` (padrão do PostgreSQL): não há blocos de valores pré-alocados
 * por sessão. É premissa necessária da ordem por wallet — com cache maior, uma sessão pode obter um
 * valor menor que o de um commit anterior, mesmo sob o lock da wallet — e o teste de integração da
 * outbox a confere. Não garante ordem global de commits nem substitui o protocolo de locks por wallet
 * descrito em `ARCHITECTURE.md`; reiniciar ou redefinir a sequência pode invalidar a monotonicidade.
 */
export class Migration20261026135325_outbox_messages extends Migration {
  override name = 'Migration20261026135325_outbox_messages';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "outbox_messages" ("id" uuid not null, "seq" bigserial, "transaction_id" uuid not null, "aggregate_id" uuid not null, "event_type" text not null, "event_version" int not null, "message_group_id" uuid not null, "correlation_id" uuid not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz not null, "claimed_until" timestamptz null, "claim_token" uuid null, "published_at" timestamptz null, "last_error_code" text null, primary key ("id"));`,
    );
    this.addSql(
      `create index "outbox_messages_unpublished_due_index" on "outbox_messages" ("next_attempt_at", "seq") where published_at is null;`,
    );
    this.addSql(
      `create index "outbox_messages_unpublished_group_index" on "outbox_messages" ("message_group_id", "seq") where published_at is null;`,
    );
    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_messages_transaction_event_type_unique" unique ("transaction_id", "event_type");`,
    );

    // Ajuste manual: preenche as linhas existentes antes de exigir a coluna.
    this.addSql(`alter table "wager_transactions" add "correlation_id" uuid null;`);
    this.addSql(
      `update "wager_transactions" set "correlation_id" = gen_random_uuid() where "correlation_id" is null;`,
    );
    this.addSql(`alter table "wager_transactions" alter column "correlation_id" set not null;`);

    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_messages_transaction_id_fk" foreign key ("transaction_id") references "wager_transactions" ("id");`,
    );
    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_messages_message_group_id_fk" foreign key ("message_group_id") references "wallets" ("id");`,
    );
    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_messages_event_version_check" check (event_version >= 1);`,
    );
    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_messages_attempts_check" check (attempts >= 0);`,
    );
    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_messages_claim_check" check ((claimed_until is null) = (claim_token is null));`,
    );
    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_messages_payload_check" check (payload ->> 'eventId' = id::text and payload ->> 'eventType' = event_type and (payload ->> 'version')::int = event_version and payload ->> 'aggregateId' = aggregate_id::text and payload ->> 'correlationId' = correlation_id::text and payload -> 'data' ->> 'walletId' = message_group_id::text and payload -> 'data' ->> 'transactionId' = transaction_id::text);`,
    );
    this.addSql(
      `alter table "outbox_messages" add constraint "outbox_messages_event_type_check" check ("event_type" in ('WagerTransactionProcessed', 'WagerTransactionRejected', 'WagerTransactionPendingReference', 'WalletBalanceChanged'));`,
    );
    this.addSql(
      `create or replace function "outbox_messages_content_no_update_fn"() returns trigger as $$ begin if (old.id, old.seq, old.transaction_id, old.aggregate_id, old.event_type, old.event_version, old.message_group_id, old.correlation_id, old.payload, old.occurred_at) is distinct from (new.id, new.seq, new.transaction_id, new.aggregate_id, new.event_type, new.event_version, new.message_group_id, new.correlation_id, new.payload, new.occurred_at) then raise exception 'outbox_messages: o conteúdo do evento é imutável'; end if; return new; end; $$ language plpgsql;`,
    );
    this.addSql(
      `create trigger "content_no_update" BEFORE UPDATE on "outbox_messages" for each ROW execute function "outbox_messages_content_no_update_fn"();`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists "content_no_update" on "outbox_messages";`);
    this.addSql(`drop function if exists "outbox_messages_content_no_update_fn"();`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);

    this.addSql(`alter table "wager_transactions" drop column "correlation_id";`);
  }
}
