import { Migration } from '@mikro-orm/migrations';

export class Migration20261026012348_bet_result_balance extends Migration {
  override name = 'Migration20261026012348_bet_result_balance';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "result_balance_cents" bigint null;`);
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_result_balance_check" check (result_balance_cents is null or result_balance_cents >= 0);`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_result_balance_required_check" check (kind = 'OPENING' or status not in ('PROCESSED', 'REJECTED') or result_balance_cents is not null);`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_result_balance_check";`,
    );
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_result_balance_required_check";`,
    );
    this.addSql(`alter table "wager_transactions" drop column "result_balance_cents";`);
  }
}
