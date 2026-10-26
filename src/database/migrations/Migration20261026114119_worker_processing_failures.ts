import { Migration } from '@mikro-orm/migrations';

export class Migration20261026114119_worker_processing_failures extends Migration {
  override name = 'Migration20261026114119_worker_processing_failures';

  override up(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" add "processing_failures" int not null default 0;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_processing_failures_check" check (processing_failures >= 0);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_processing_failures_pending_check" check (status = 'PENDING_REFERENCE' or processing_failures = 0);`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_processing_failures_check";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_processing_failures_pending_check";`,
    );
    this.addSql(`alter table "wager_transactions" drop column "processing_failures";`);
  }
}
