import type { Options } from '@mikro-orm/postgresql';
import { OutboxMessageSchema } from './schema/outbox-message.schema';
import { WagerTransactionSchema } from './schema/wager-transaction.schema';
import { WalletSchema } from './schema/wallet.schema';
import { WalletLedgerEntrySchema } from './schema/wallet-ledger-entry.schema';

/**
 * Registro explícito das entidades do MikroORM, compartilhado pela aplicação e pelo CLI.
 *
 * Uma lista explícita (em vez de globs de diretório) mantém a descoberta determinística sob o Bun
 * e torna visível no diff cada entidade que passa a ser mapeada. São modelos de persistência,
 * separados do domínio (`src/domain/`), que não depende do ORM.
 */
export const entities: NonNullable<Options['entities']> = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  OutboxMessageSchema,
];
