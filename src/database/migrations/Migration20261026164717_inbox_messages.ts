import { Migration } from '@mikro-orm/migrations';

export class Migration20261026164717_inbox_messages extends Migration {
  override name = 'Migration20261026164717_inbox_messages';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "inbox_messages" ("consumer_name" text not null, "message_id" text not null, "payload_hash" text not null, "transaction_id" uuid not null, "received_at" timestamptz not null, "processed_at" timestamptz not null, primary key ("consumer_name", "message_id"));`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
  }
}
