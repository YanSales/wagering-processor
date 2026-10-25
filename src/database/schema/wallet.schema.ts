import { BigIntType, EntitySchema } from '@mikro-orm/core';

/**
 * Linha persistida de `wallets`. Modelo de persistência, separado do domínio (`src/domain/wallet.ts`):
 * o domínio não depende do ORM (contrato §6.1). Mapeadores ficam para o incremento de repositórios.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  /** Centavos, sempre `bigint` no JS (nunca `number`). */
  balanceCents!: bigint;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

/**
 * Constraints do contrato aplicadas no schema (§5.9):
 * - uma wallet por `player_id` + `currency` (§6.2);
 * - saldo nunca negativo (§6.2); `version` >= 1 (começa em 1, §6.2);
 * - moeda ISO-4217 com três letras maiúsculas (§6.1).
 * `UNIQUE (id, currency)` existe para ser alvo da FK composta do ledger, que garante que todo
 * lançamento tenha a moeda da sua wallet.
 */
export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'text' },
    currency: { type: 'character', length: 3 },
    balanceCents: { type: new BigIntType('bigint') },
    version: { type: 'integer' },
    createdAt: { type: 'timestamptz' },
    updatedAt: { type: 'timestamptz' },
  },
  uniques: [
    { name: 'wallets_player_id_currency_unique', properties: ['playerId', 'currency'] },
    { name: 'wallets_id_currency_unique', properties: ['id', 'currency'] },
  ],
  checks: [
    { name: 'wallets_balance_cents_check', expression: 'balance_cents >= 0' },
    { name: 'wallets_version_check', expression: 'version >= 1' },
    { name: 'wallets_currency_check', expression: "currency ~ '^[A-Z]{3}$'" },
  ],
});
