import { Migration } from '@mikro-orm/migrations';

export class Migration20261026104613_pending_reference_retry extends Migration {
  override name = 'Migration20261026104613_pending_reference_retry';

  override up(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" add "reference_attempts" int not null default 0, add "next_reference_attempt_at" timestamptz null;`,
    );
    this.addSql(
      `create index "wager_transactions_pending_reference_due_index" on "wager_transactions" ("next_reference_attempt_at") where status = 'PENDING_REFERENCE';`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_attempts_check" check (reference_attempts >= 0);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_pending_reference_schedule_check" check ((status = 'PENDING_REFERENCE' and next_reference_attempt_at is not null and reference_external_transaction_id is not null) or (status <> 'PENDING_REFERENCE' and next_reference_attempt_at is null));`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_pending_reference_due_index";`);
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_reference_attempts_check";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_pending_reference_schedule_check";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop column "reference_attempts", drop column "next_reference_attempt_at";`,
    );
  }
}
