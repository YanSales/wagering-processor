import type { MoneyProps } from '../../domain/money';
import type { Wallet } from '../../domain/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
  InvalidIntegrationEventError,
} from './integration-event';

/** `data` definido pelo contrato (README §11), sem campos adicionais. */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/**
 * Emitido **somente** quando o saldo muda (§11): um por lançamento do ledger. O `aggregateId` é a
 * wallet (raiz de agregado, §6.2); o `occurredAt`, o instante do lançamento.
 */
export class WalletBalanceChanged extends IntegrationEvent<
  'WalletBalanceChanged',
  WalletBalanceChangedData
> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  /**
   * `wallet` é o estado **depois** do movimento: o saldo dela é o `balanceAfter` do lançamento, e a
   * versão dela é a `walletVersion` do evento (na abertura, 1: a criação não incrementa a versão,
   * §6.2).
   */
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError(
        `O lançamento ${entry.id} é da wallet ${entry.walletId}, não da ${wallet.id}.`,
      );
    }
    if (!entry.balanceAfter.equals(wallet.balance)) {
      throw new InvalidIntegrationEventError(
        `A wallet ${wallet.id} não está no estado posterior ao lançamento ${entry.id}.`,
      );
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      occurredAt: entry.createdAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toProps(),
        balanceBefore: entry.balanceBefore.toProps(),
        balanceAfter: entry.balanceAfter.toProps(),
        walletVersion: wallet.version,
      },
    });
  }
}
