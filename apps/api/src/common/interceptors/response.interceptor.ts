import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map((data: unknown) => {
      const status = context.switchToHttp().getResponse<Response>().statusCode;
      // 본문이 없는 응답과 redirect는 HTTP 의미를 유지한다. HEAD 본문은 Express가 제거한다.
      if (status === 204 || (status >= 300 && status < 400)) return data;
      return { success: true, data: data ?? null };
    }));
  }
}
