import type { Options } from '@mikro-orm/postgresql';

/**
 * Registro explícito das entidades do MikroORM, compartilhado pela aplicação e pelo CLI.
 *
 * Uma lista explícita (em vez de globs de diretório) mantém a descoberta determinística sob o Bun
 * e torna visível no diff cada entidade que passa a ser mapeada. Vazio de propósito: o schema de
 * carteiras, apostas e ledger será definido nos próximos incrementos, junto com suas migrations.
 */
export const entities: NonNullable<Options['entities']> = [];
