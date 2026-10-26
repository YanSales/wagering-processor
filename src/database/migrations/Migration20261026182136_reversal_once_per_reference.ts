import { Migration } from '@mikro-orm/migrations';

/**
 * Uma operação é revertida no máximo uma vez no total, por REFUND ou por ROLLBACK: o índice único
 * parcial de reversões passa de `(reference_transaction_id, kind)` para `(reference_transaction_id)`.
 * Continua restrito às reversões aplicadas (só elas gravam a referência interna).
 *
 * Gerada por `migration:create`. Se já houver uma operação com REFUND e ROLLBACK aplicados, a criação
 * do índice falha e a migration inteira é desfeita: a duplicidade precisa ser analisada e
 * reconciliada manualmente, não descartada aqui.
 */
export class Migration20261026182136_reversal_once_per_reference extends Migration {
  override name = 'Migration20261026182136_reversal_once_per_reference';

  override up(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_reversal_once_unique";`);
    this.addSql(
      `create unique index "wager_transactions_reversal_once_unique" on "wager_transactions" ("reference_transaction_id") where kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transactions_reversal_once_unique";`);
    this.addSql(
      `create unique index "wager_transactions_reversal_once_unique" on "wager_transactions" ("reference_transaction_id", "kind") where kind in ('REFUND', 'ROLLBACK') and reference_transaction_id is not null;`,
    );
  }
}
