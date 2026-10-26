import { describe, expect, test } from 'bun:test';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../../src/auth/auth.guard';
import { IS_PUBLIC_ROUTE } from '../../src/auth/public.decorator';
import { HealthController } from '../../src/health/health.controller';
import { WalletsController } from '../../src/wallets/wallets.controller';

describe('AuthGuard (ponto de extensão, autenticação desativada)', () => {
  test('aceita toda requisição: nenhuma rota está protegida', () => {
    expect(new AuthGuard().canActivate()).toBe(true);
  });
});

describe('@Public()', () => {
  const reflector = new Reflector();

  test('os endpoints de health são marcados como públicos (contrato §2 e §9)', () => {
    expect(reflector.get(IS_PUBLIC_ROUTE, HealthController)).toBe(true);
  });

  test('POST /wallets não é público: ficará sujeito à autenticação real', () => {
    expect(reflector.get(IS_PUBLIC_ROUTE, WalletsController)).toBeUndefined();
    expect(reflector.get(IS_PUBLIC_ROUTE, WalletsController.prototype.open)).toBeUndefined();
  });
});
