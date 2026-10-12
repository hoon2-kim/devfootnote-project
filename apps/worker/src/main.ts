import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';
import { logger, NestLogger } from './infrastructure/logging/logger.js';
import { EnvironmentError } from './config/environment.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    abortOnError: false,
    logger: new NestLogger(),
  });

  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  // 설정 오류만 키 이름을 안내하고 DB·Redis 원본 오류는 출력하지 않는다.
  logger.fatal(
    error instanceof EnvironmentError
      ? error.message
      : 'Worker를 시작하지 못했습니다. 설정과 연결을 확인해 주세요.',
  );
  process.exitCode = 1;
});
