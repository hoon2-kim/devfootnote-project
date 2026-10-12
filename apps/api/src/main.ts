import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { logger, NestLogger } from './infrastructure/logging/logger.js';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { EnvironmentError } from './config/environment.js';

async function bootstrap() {
  const app = configureApp(
    await NestFactory.create(AppModule, { abortOnError: false, logger: new NestLogger() }),
  );

  await app.listen(app.get(ConfigService).getOrThrow<number>('port'));
}

bootstrap().catch((error: unknown) => {
  // EnvironmentError 만 message 안전성이 코드로 보장된다.
  logger.error(
    error instanceof EnvironmentError
      ? error.message
      : '서버를 시작하지 못했습니다. 환경 설정과 사용 중인 포트를 확인해 주세요.',
  );
  process.exitCode = 1;
});
