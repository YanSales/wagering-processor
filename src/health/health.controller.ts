import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

export interface LivenessResponse {
  status: 'ok';
}

/**
 * Health endpoints exigidos pelo desafio. Não exigem autenticação (`@Public()`, contrato §2 e §9).
 * `GET /health/ready` (PostgreSQL e SQS alcançáveis) será adicionado junto com a infraestrutura.
 */
@Public()
@Controller('health')
export class HealthController {
  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }
}
