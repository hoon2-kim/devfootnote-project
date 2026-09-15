import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { logger } from '@devfootnote/backend';
import type { Response } from 'express';
import { ValidationException } from './validation-exception.js';

// fallback이 표현할 수 없는 의미를 가진 상태만 둔다. 401/409/412/429처럼 아직 만드는 쪽이 없는
// 코드는 인증·저장 slice에서 그 producer와 함께 추가한다(ADR-0007의 error code 계약).
const publicErrors: Record<number, [string, string]> = {
  400: ['VALIDATION_ERROR', '요청을 확인해 주세요.'],
  404: ['NOT_FOUND', '요청한 항목을 찾을 수 없습니다.'],
  503: ['SERVICE_UNAVAILABLE', '잠시 후 다시 시도해 주세요.'],
};
// 매핑하지 않은 상태 코드도 상태 계열과 error 코드가 어긋나지 않게 한다.
const clientFallback: [string, string] = ['CLIENT_ERROR', '요청을 처리할 수 없습니다.'];
const serverFallback: [string, string] = ['INTERNAL_SERVER_ERROR', '요청을 처리하지 못했습니다.'];

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const [error, message] = publicErrors[status] ?? (status < 500 ? clientFallback : serverFallback);
    // 원본 exception·요청·입력값을 넘기지 않고 공개 상태와 오류 코드만 남긴다.
    if (status >= 500) logger.error({ status, error }, 'HTTP 요청 처리 실패');
    else logger.warn({ status, error }, 'HTTP 요청 거부');
    // 이미 응답이 나가기 시작했으면 body를 덧붙이지 않되 연결은 반드시 닫는다.
    if (response.headersSent) { response.end(); return; }
    response.status(status).json({ success: false, error, message, ...(exception instanceof ValidationException && exception.errors.length ? { errors: exception.errors } : {}) });
  }
}
