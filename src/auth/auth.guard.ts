import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (contrato §2). A autenticação NÃO está implementada: este
 * guard é registrado globalmente (`AuthModule`) e aceita toda requisição, sem identificar quem
 * chama. Nenhum endpoint está protegido.
 *
 * A implementação real substitui este provider (validação do token emitido pelo Identity Provider
 * externo) e deve liberar sem credenciais as rotas marcadas com `@Public()`. Ver `ARCHITECTURE.md`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
