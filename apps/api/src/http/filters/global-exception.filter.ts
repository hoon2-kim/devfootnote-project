import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { AuthError } from '../../modules/auth/index.js';
import { MaterialsError } from '../../modules/materials/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { Response } from 'express';
import { ValidationException } from '../../common/filters/validation-exception.js';

interface PublicError {
  status: number;
  error: string;
  message: string;
}

// 앱의 HTTP 조립 경계만 업무 오류를 안다. 도메인에는 status/message 정책을 넣지 않는다.
const materialErrors = {
  conflict: {
    status: 409,
    error: 'MATERIAL_REQUEST_CONFLICT',
    message: '같은 요청 ID로 다른 자료를 저장할 수 없습니다.',
  },
  revision_conflict: {
    status: 409,
    error: 'MATERIAL_REVISION_CONFLICT',
    message: '자료가 변경되었습니다. 최신 내용을 확인해 주세요.',
  },
  not_found: {
    status: 404,
    error: 'MATERIAL_NOT_FOUND',
    message: '자료를 찾을 수 없습니다.',
  },
  unavailable: {
    status: 503,
    error: 'SERVICE_UNAVAILABLE',
    message: '잠시 후 다시 시도해 주세요.',
  },
} satisfies Record<MaterialsError['kind'], PublicError>;

const authStatuses = { denied: 401, unavailable: 503 } satisfies Record<AuthError['kind'], number>;

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

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();

    if (response.headersSent) {
      response.end();

      return;
    }

    const materialError =
      exception instanceof MaterialsError ? materialErrors[exception.kind] : undefined;

    const status =
      materialError?.status ??
      (exception instanceof AuthError
        ? authStatuses[exception.kind]
        : exception instanceof HttpException
          ? exception.getStatus()
          : 500);
    const [error, message] = materialError
      ? [materialError.error, materialError.message]
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
