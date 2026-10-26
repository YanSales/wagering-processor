import {
  Body,
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Res,
} from '@nestjs/common';
import {
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  type SubmissionResult,
  SubmitWagerTransaction,
  UnsupportedSubmissionError,
} from '../application/submit-wager-transaction';
import {
  TransientPersistenceError,
  WalletNotFoundError,
} from '../application/wager-transaction-repository';
import { AmountOutOfStorageRangeError } from '../application/wallet-repository';
import { InvalidMoneyError } from '../domain/money';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { metrics } from '../observability/metrics';
import {
  InvalidSubmissionRequestError,
  parseSubmissionRequest,
  type SubmissionResponse,
  toSubmissionResponse,
} from './submit-transaction.request';

/** Códigos de erro de requisição, legíveis por máquina (§9: não interpretar mensagens). */
export const RequestErrorCodes = {
  InvalidRequest: 'INVALID_REQUEST',
  IdempotencyKeyConflict: 'IDEMPOTENCY_KEY_CONFLICT',
  DuplicateExternalTransaction: 'DUPLICATE_EXTERNAL_TRANSACTION',
  WalletNotFound: 'WALLET_NOT_FOUND',
  TransactionNotFound: 'TRANSACTION_NOT_FOUND',
  UnsupportedSubmission: 'UNSUPPORTED_SUBMISSION',
  TransientFailure: 'TRANSIENT_FAILURE',
} as const;

/** Só o necessário da resposta HTTP: definir o status sem assumir o controle da serialização. */
interface StatusSetter {
  status(code: number): unknown;
}

/**
 * `POST /wagering/transactions` (contrato §9). Lê `Idempotency-Key` e o corpo, chama
 * `SubmitWagerTransaction` e traduz o resultado. Não acessa o banco nem aplica regras: a decisão
 * financeira e a idempotência são do caso de uso e do PostgreSQL.
 *
 * Resultado de negócio gravado (corpo `SubmissionResponse`): `PROCESSED` → 200, `REJECTED` → 422,
 * `PENDING_REFERENCE` → 202, inclusive em replay. Erros de requisição (corpo `{ statusCode, error, message, code }`): 400
 * payload inválido, 404 wallet inexistente, 409 conflito de idempotência ou operação externa
 * duplicada, 501 submissão ainda não suportada, 503 falha transitória. Outros erros: 500 genérico.
 * Sujeito ao `AuthGuard` global (autenticação ainda não implementada, ver `ARCHITECTURE.md`).
 */
@Controller('wagering/transactions')
export class WageringTransactionsController {
  // `@Inject` explícito: a injeção não depende do metadado de tipos do import.
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submitTransaction: SubmitWagerTransaction,
  ) {}

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<SubmissionResponse> {
    let command: ReturnType<typeof parseSubmissionRequest>;
    try {
      command = parseSubmissionRequest(idempotencyKey, body);
    } catch (error) {
      if (error instanceof InvalidSubmissionRequestError || error instanceof InvalidMoneyError) {
        throw requestError(HttpStatus.BAD_REQUEST, RequestErrorCodes.InvalidRequest, error.message);
      }
      throw error;
    }

    let result: SubmissionResult;
    try {
      result = await metrics.processingDuration.time({ channel: 'http' }, () =>
        this.submitTransaction.execute(command),
      );
    } catch (error) {
      throw toRequestError(error);
    }
    if (result.idempotentReplay) {
      metrics.duplicates.inc({ channel: 'http', type: 'idempotency_replay' });
    }
    response.status(statusFor(result.status));
    return toSubmissionResponse(result);
  }
}

/**
 * Rejeição de negócio é um resultado gravado, não erro de requisição: corpo do resultado, 422. A
 * transação aguardando a referência foi aceita e gravada, mas ainda não aplicada: 202 (§9, "aceite
 * com processamento pendente"); o reenvio devolve o estado atual.
 */
function statusFor(status: WagerTransactionStatus): HttpStatus {
  if (status === WagerTransactionStatus.Rejected) return HttpStatus.UNPROCESSABLE_ENTITY;
  if (status === WagerTransactionStatus.PendingReference) return HttpStatus.ACCEPTED;
  return HttpStatus.OK;
}

/** Erros conhecidos do caso de uso → HTTP; os demais seguem para o 500 genérico do Nest. */
function toRequestError(error: unknown): unknown {
  if (error instanceof IdempotencyConflictError) {
    return requestError(
      HttpStatus.CONFLICT,
      RequestErrorCodes.IdempotencyKeyConflict,
      error.message,
    );
  }
  if (error instanceof DuplicateExternalTransactionError) {
    return requestError(
      HttpStatus.CONFLICT,
      RequestErrorCodes.DuplicateExternalTransaction,
      `A transação ${error.keys.externalTransactionId} do provedor ${error.keys.providerId} já foi ` +
        'submetida com outra chave de idempotência.',
    );
  }
  if (error instanceof WalletNotFoundError) {
    return requestError(HttpStatus.NOT_FOUND, RequestErrorCodes.WalletNotFound, error.message);
  }
  if (error instanceof UnsupportedSubmissionError) {
    return requestError(
      HttpStatus.NOT_IMPLEMENTED,
      RequestErrorCodes.UnsupportedSubmission,
      error.message,
    );
  }
  if (error instanceof AmountOutOfStorageRangeError) {
    return requestError(
      HttpStatus.BAD_REQUEST,
      RequestErrorCodes.InvalidRequest,
      `money: ${error.message}`,
    );
  }
  if (error instanceof TransientPersistenceError) {
    // Mensagem fixa: a causa (driver, SQL) não vai para o cliente.
    return requestError(
      HttpStatus.SERVICE_UNAVAILABLE,
      RequestErrorCodes.TransientFailure,
      'Falha transitória; a mesma requisição pode ser repetida.',
    );
  }
  return error;
}

/** Erro de requisição no formato comum da API: `{ statusCode, error, message, code }`. */
export function requestError(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException(
    { statusCode: status, error: HttpStatusText[status] ?? 'Error', message, code },
    status,
  );
}

const HttpStatusText: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.NOT_IMPLEMENTED]: 'Not Implemented',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};
