import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { GlobalExceptionFilter } from './http/filters/global-exception.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { validationException } from './common/filters/validation-exception.js';
import { CsrfService } from './modules/auth/index.js';

export function configureApp(app: INestApplication) {
  app.use(cookieParser());
  // 인증 응답에는 CSRF 토큰과 Set-Cookie 가 실린다 — 뒤로 가기 캐시에 남으면 안 된다.
  app.use('/api/v1/auth', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(app.get(CsrfService).protection);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: validationException,
    }),
  );
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  return app;
}
