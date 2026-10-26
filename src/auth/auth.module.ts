import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';

/**
 * Registra o `AuthGuard` como guard global. `useExisting` permite trocar a implementação
 * substituindo apenas o provider `AuthGuard`.
 */
@Module({
  providers: [AuthGuard, { provide: APP_GUARD, useExisting: AuthGuard }],
})
export class AuthModule implements OnApplicationBootstrap {
  onApplicationBootstrap(): void {
    // Explícito no log: a API não deve parecer protegida.
    new Logger('Auth').warn(
      'Autenticação desativada: o AuthGuard global aceita todas as requisições (ver ARCHITECTURE.md).',
    );
  }
}
