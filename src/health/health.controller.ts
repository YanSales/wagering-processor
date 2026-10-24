import { Controller, Get } from '@nestjs/common';

export interface LivenessResponse {
  status: 'ok';
}

/**
 * Health endpoints exigidos pelo desafio. Não exigem autenticação.
 * `GET /health/ready` (PostgreSQL e SQS alcançáveis) será adicionado junto com a infraestrutura.
 */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }
}
