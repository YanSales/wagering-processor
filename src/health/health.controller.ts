import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { ObservedDependencies } from '../observability/observed-dependencies';
import type { DependencyState } from '../observability/readiness';

export interface LivenessResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ok' | 'unavailable';
  checks: Record<string, DependencyState>;
}

/** Só o necessário da resposta HTTP: definir o status sem assumir a serialização. */
interface StatusSetter {
  status(code: number): unknown;
}

/**
 * Health endpoints exigidos pelo desafio (§9 e §12). Não exigem autenticação (`@Public()`, §2 e §9).
 *
 * - `GET /health/live`: o processo está vivo. Não consulta dependências: um banco ou SQS fora do ar
 *   não deve levar o orquestrador a reiniciar o processo.
 * - `GET /health/ready`: 200 se as dependências necessárias respondem — PostgreSQL sempre, SQS só com
 *   o publisher ou o consumidor habilitados (`disabled` caso contrário) —, 503 se alguma falhar. O
 *   corpo traz apenas o estado de cada uma, sem mensagens de erro.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(ObservedDependencies) private readonly dependencies: ObservedDependencies) {}

  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusSetter): Promise<ReadinessResponse> {
    const report = await this.dependencies.readiness();
    response.status(report.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: report.ready ? 'ok' : 'unavailable', checks: report.checks };
  }
}
