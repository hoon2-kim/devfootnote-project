import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { map } from 'rxjs';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      map((data: unknown) => {
        const status = context.switchToHttp().getResponse<Response>().statusCode;

        // HEAD 분기는 두지 않는다 — Express 가 본문을 지우므로 GET 과 Content-Length 가 같아야 한다.
        if (status === 204 || (status >= 300 && status < 400)) {
          return data;
        }

        return { success: true, data: data ?? null };
      }),
    );
  }
}
