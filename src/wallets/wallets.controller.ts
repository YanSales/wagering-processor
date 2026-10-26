import { BadRequestException, Body, ConflictException, Controller, Post } from '@nestjs/common';
// biome-ignore lint/style/useImportType: o Nest precisa da classe em runtime para injetar o caso de uso.
import { OpenWallet } from '../application/open-wallet';
import {
  AmountOutOfStorageRangeError,
  WalletAlreadyExistsError,
} from '../application/wallet-repository';
import { InvalidMoneyError } from '../domain/money';
import {
  InvalidOpenWalletRequestError,
  parseOpenWalletRequest,
  toWalletResponse,
  type WalletResponse,
} from './open-wallet.request';

/**
 * `POST /wallets` (contrato §9). O controller só lê a entrada, chama `OpenWallet` e traduz o
 * resultado: payload inválido (inclusive saldo fora da faixa armazenável) → 400, wallet duplicada
 * → 409. Qualquer outro erro segue para o tratamento padrão do Nest (500), sem ser reclassificado.
 */
@Controller('wallets')
export class WalletsController {
  constructor(private readonly openWallet: OpenWallet) {}

  @Post()
  async open(@Body() body: unknown): Promise<WalletResponse> {
    let command: ReturnType<typeof parseOpenWalletRequest>;
    try {
      command = parseOpenWalletRequest(body);
    } catch (error) {
      if (error instanceof InvalidOpenWalletRequestError || error instanceof InvalidMoneyError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    try {
      return toWalletResponse(await this.openWallet.execute(command));
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }
      // Validado pelo repositório antes de gravar: é entrada inválida, não falha de infraestrutura.
      if (error instanceof AmountOutOfStorageRangeError) {
        throw new BadRequestException(`initialBalance: ${error.message}`);
      }
      throw error;
    }
  }
}
