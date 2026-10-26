import { randomUUID } from 'node:crypto';
import type { Money } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import type { WalletRepository } from './wallet-repository';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

/**
 * Abre uma wallet (contrato §9, `POST /wallets`).
 *
 * - Saldo inicial positivo: a wallet nasce com esse saldo e `version` 1, junto com a transação
 *   interna `OPENING` (já `PROCESSED`) e o lançamento `CREDIT` de zero até o saldo inicial, gravados
 *   na mesma transação SQL pelo repositório.
 * - Saldo inicial zero: só a wallet; não há OPENING nem lançamento.
 * - Saldo inicial negativo e demais invariantes: recusados pelo domínio, antes de qualquer gravação.
 * - Wallet duplicada para o mesmo player e moeda: `WalletAlreadyExistsError` (conflito).
 *
 * Ids e relógio são injetáveis para testes; o domínio não os gera.
 */
export class OpenWallet {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  async execute({ playerId, initialBalance }: OpenWalletCommand): Promise<Wallet> {
    const at = this.now();
    const walletId = this.newId();
    const opening =
      initialBalance.isZero() || initialBalance.isNegative()
        ? null
        : WagerTransaction.opening({
            id: this.newId(),
            walletId,
            playerId,
            money: initialBalance,
            at,
          });

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      openedAt: at,
      ...(opening === null
        ? {}
        : { opening: { transactionId: opening.id, ledgerEntryId: this.newId() } }),
    });

    await this.wallets.insertOpened({ wallet, opening, openingEntry });
    return wallet;
  }
}
