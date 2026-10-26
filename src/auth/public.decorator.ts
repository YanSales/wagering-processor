import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE = 'auth:public';

/**
 * Marca rotas que nunca exigem autenticação (contrato §2 e §9: os endpoints de health ficam
 * abertos). O `AuthGuard` atual não autentica nada; a marcação existe para que a implementação real
 * a respeite.
 */
export const Public = () => SetMetadata(IS_PUBLIC_ROUTE, true);
