import { Migration } from '@mikro-orm/migrations';

export class Migration20261025213000_financial_schema extends Migration {
  override name = 'Migration20261025213000_financial_schema';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "wallets" ("id" uuid not null, "player_id" text not null, "currency" char(3) not null, "balance_cents" bigint not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "wallets" add constraint "wallets_player_id_currency_unique" unique ("player_id", "currency");`,
    );
    this.addSql(
      `alter table "wallets" add constraint "wallets_id_currency_unique" unique ("id", "currency");`,
    );

    this.addSql(
      `create table "wager_transactions" ("id" uuid not null, "wallet_id" uuid not null, "player_id" text not null, "kind" text not null, "status" text not null, "provider_id" text null, "external_transaction_id" text null, "idempotency_key" text null, "payload_hash" text null, "round_id" text null, "game_id" text null, "money_cents" bigint not null, "currency" char(3) not null, "reference_external_transaction_id" text null, "reference_transaction_id" uuid null, "failure_code" text null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id");`,
    );
    this.addSql(
      `create unique index "wager_transactions_reversal_once_unique" on "wager_transactions" ("reference_transaction_id", "kind") where kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null;`,
    );
    this.addSql(
      `create unique index "wager_transactions_opening_once_unique" on "wager_transactions" ("wallet_id") where kind = 'OPENING';`,
    );

    this.addSql(
      `create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "currency" char(3) not null, "transaction_id" uuid not null, "direction" text not null, "money_cents" bigint not null, "balance_before_cents" bigint not null, "balance_after_cents" bigint not null, "created_at" timestamptz not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_transaction_unique" unique ("wallet_id", "transaction_id");`,
    );

    this.addSql(
      `alter table "wallets" add constraint "wallets_balance_cents_check" check (balance_cents >= 0);`,
    );
    this.addSql(
      `alter table "wallets" add constraint "wallets_version_check" check (version >= 1);`,
    );
    this.addSql(
      `alter table "wallets" add constraint "wallets_currency_check" check (currency ~ '^[A-Z]{3}$');`,
    );

    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_wallet_id_fk" foreign key ("wallet_id") references "wallets" ("id");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_fk" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete no action;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_money_cents_check" check (money_cents >= 0);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_currency_check" check (currency ~ '^[A-Z]{3}$');`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_failure_code_check" check (failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]*$');`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_required_check" check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_submission_fields_check" check ((kind = 'OPENING' and provider_id is null and external_transaction_id is null and idempotency_key is null and payload_hash is null and round_id is null and game_id is null and reference_external_transaction_id is null and reference_transaction_id is null) or (kind <> 'OPENING' and provider_id is not null and external_transaction_id is not null and idempotency_key is not null and payload_hash is not null and round_id is not null and game_id is not null));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`,
    );

    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_currency_fk" foreign key ("wallet_id", "currency") references "wallets" ("id", "currency");`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_fk" foreign key ("transaction_id") references "wager_transactions" ("id");`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_money_cents_check" check (money_cents > 0);`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balances_check" check (balance_before_cents >= 0 and balance_after_cents >= 0);`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_arithmetic_check" check ((direction = 'CREDIT' and balance_after_cents = balance_before_cents + money_cents) or (direction = 'DEBIT' and balance_after_cents = balance_before_cents - money_cents));`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`,
    );
    this.addSql(
      `create or replace function "wallet_ledger_entries_ledger_no_update_delete_fn"() returns trigger as $$ begin raise exception 'wallet_ledger_entries é imutável: % não é permitido', tg_op; end; $$ language plpgsql;`,
    );
    this.addSql(
      `create trigger "ledger_no_update_delete" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_ledger_no_update_delete_fn"();`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_wallet_id_fk";`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_wallet_currency_fk";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_fk";`,
    );
    this.addSql(
      `alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_transaction_id_fk";`,
    );

    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop trigger if exists "ledger_no_update_delete" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_ledger_no_update_delete_fn"();`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }
}
