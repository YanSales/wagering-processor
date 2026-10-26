import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { OpenWallet } from '../application/open-wallet';
import type { WalletRepository } from '../application/wallet-repository';
import { MikroOrmWalletRepository } from '../database/repositories/wallet.repository';
import { WalletsController } from './wallets.controller';

/** Token da porta `WalletRepository` (interface, sem representação em runtime). */
export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

/**
 * Abertura de wallets pela API. O `MikroORM` vem do `DatabaseModule` (o `MikroOrmModule` é global);
 * o caso de uso recebe a porta, o relógio e o gerador de ids, sem depender do ORM.
 */
@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: WALLET_REPOSITORY,
      inject: [MikroORM],
      useFactory: (orm: MikroORM): WalletRepository => new MikroOrmWalletRepository(orm),
    },
    {
      provide: OpenWallet,
      inject: [WALLET_REPOSITORY],
      useFactory: (wallets: WalletRepository): OpenWallet =>
        new OpenWallet(wallets, () => new Date(), randomUUID),
    },
  ],
})
export class WalletsModule {}
