import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { logger } from '../../infrastructure/logging/logger.js';
import type { Response } from 'express';
import { ValidationException } from '../../common/filters/validation-exception.js';
import { toDomainErrorResponse } from './domain-error-response.js';

// fallback 으로 구분되지 않는 상태만 둔다. 409·412·429 는 던지는 쪽이 생길 때 같이 추가한다.
const publicErrors: Record<number, [string, string]> = {
  400: ['VALIDATION_ERROR', '요청을 확인해 주세요.'],
  401: ['AUTHENTICATION_REQUIRED', '로그인이 필요합니다.'],
  403: ['FORBIDDEN', '허용되지 않은 요청입니다.'],
  404: ['NOT_FOUND', '요청한 항목을 찾을 수 없습니다.'],
  503: ['SERVICE_UNAVAILABLE', '잠시 후 다시 시도해 주세요.'],
};
const clientFallback: [string, string] = ['CLIENT_ERROR', '요청을 처리할 수 없습니다.'];
const serverFallback: [string, string] = ['INTERNAL_SERVER_ERROR', '요청을 처리하지 못했습니다.'];

const bodyParserStatuses: Record<string, number> = {
  'entity.too.large': 413,
  'charset.unsupported': 415,
  'encoding.unsupported': 415,
};

function bodyParserStatus(exception: unknown): number | undefined {
  if (
    !(exception instanceof Error) ||
    !('type' in exception) ||
    typeof exception.type !== 'string' ||
    !('status' in exception) ||
    !('statusCode' in exception) ||
    !('expose' in exception) ||
    exception.expose !== true
  ) {
    return undefined;
  }

  // 임의 오류의 status만 믿지 않고 body-parser의 알려진 type/status 조합을 확인한다.
  const status = bodyParserStatuses[exception.type];

  return status !== undefined && exception.status === status && exception.statusCode === status
    ? status
    : undefined;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (response.headersSent) {
      response.end();

      return;
    }

    const publicError = toDomainErrorResponse(exception);
    const status =
      publicError?.status ??
      (exception instanceof HttpException
        ? exception.getStatus()
        : (bodyParserStatus(exception) ?? 500));
    const [error, message] = publicError
      ? [publicError.error, publicError.message]
      : (publicErrors[status] ?? (status < 500 ? clientFallback : serverFallback));

    if (status >= 500) {
      logger.error({ status, error }, 'HTTP 요청 처리 실패');
    } else {
      logger.warn({ status, error }, 'HTTP 요청 거부');
    }

    response.status(status).json({
      success: false,
      error,
      message,
      ...(exception instanceof ValidationException && exception.errors.length
        ? { errors: exception.errors }
        : {}),
    });
  }
}
