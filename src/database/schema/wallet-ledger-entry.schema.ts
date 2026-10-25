import { BigIntType, EntitySchema } from '@mikro-orm/core';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';
import { WagerTransactionRecord } from './wager-transaction.schema';
import { WalletRecord } from './wallet.schema';

/** Linha persistida de `wallet_ledger_entries` (modelo de persistência, separado do domínio). */
export class WalletLedgerEntryRecord {
  id!: string;
  /** FK composta `(wallet_id, currency)`: a moeda do lançamento é sempre a da wallet. */
  wallet!: WalletRecord;
  transaction!: WagerTransactionRecord;
  direction!: LedgerDirection;
  moneyCents!: bigint;
  balanceBeforeCents!: bigint;
  balanceAfterCents!: bigint;
  createdAt!: Date;
}

const IMMUTABLE_MESSAGE =
  "raise exception 'wallet_ledger_entries é imutável: % não é permitido', tg_op;";

/**
 * Constraints aplicadas no schema (§5.9):
 * - no máximo um lançamento por transação e wallet (§6.4);
 * - valor positivo e saldos não negativos (§6.2 e §6.4);
 * - equação contábil `balanceBefore ± money === balanceAfter` conforme a direção (§6.4);
 * - moeda igual à da wallet, pela FK composta para `wallets (id, currency)`;
 * - imutabilidade (§5, item 5, e §6.4): trigger recusa UPDATE e DELETE de qualquer lançamento.
 *
 * TRUNCATE e DROP são DDL e não são cobertos por trigger de linha; o MikroORM também não introspecta
 * triggers de TRUNCATE (ausentes de `information_schema.triggers`). Protegê-los é papel das
 * permissões da role da aplicação, a definir na implantação.
 */
export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    wallet: {
      kind: 'm:1',
      entity: () => WalletRecord,
      joinColumns: ['wallet_id', 'currency'],
      columnTypes: ['uuid', 'char(3)'],
      referencedColumnNames: ['id', 'currency'],
      foreignKeyName: 'wallet_ledger_entries_wallet_currency_fk',
    },
    transaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      joinColumn: 'transaction_id',
      foreignKeyName: 'wallet_ledger_entries_transaction_id_fk',
    },
    direction: { enum: true, items: Object.values(LedgerDirection), type: 'text' },
    moneyCents: { type: new BigIntType('bigint') },
    balanceBeforeCents: { type: new BigIntType('bigint') },
    balanceAfterCents: { type: new BigIntType('bigint') },
    createdAt: { type: 'timestamptz' },
  },
  uniques: [
    {
      // DDL explícito: `properties: ['wallet', ...]` incluiria `currency` (a FK é composta), e
      // `columns` nunca coincide com a introspecção do MikroORM 7. Comparado pelo nome.
      name: 'wallet_ledger_entries_wallet_transaction_unique',
      expression:
        'alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_transaction_unique" ' +
        'unique ("wallet_id", "transaction_id")',
    },
  ],
  checks: [
    { name: 'wallet_ledger_entries_money_cents_check', expression: 'money_cents > 0' },
    {
      name: 'wallet_ledger_entries_balances_check',
      expression: 'balance_before_cents >= 0 and balance_after_cents >= 0',
    },
    {
      name: 'wallet_ledger_entries_arithmetic_check',
      expression:
        "(direction = 'CREDIT' and balance_after_cents = balance_before_cents + money_cents) or " +
        "(direction = 'DEBIT' and balance_after_cents = balance_before_cents - money_cents)",
    },
  ],
  triggers: [
    {
      name: 'ledger_no_update_delete',
      timing: 'before',
      events: ['update', 'delete'],
      forEach: 'row',
      body: IMMUTABLE_MESSAGE,
    },
  ],
});
