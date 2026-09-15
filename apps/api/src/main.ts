import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { logger } from '@devfootnote/backend';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule));
  await app.listen(Number(process.env.PORT ?? 8000), '0.0.0.0');
}

bootstrap().catch(() => {
  logger.error('서버를 시작하지 못했습니다. 환경 설정과 사용 중인 포트를 확인해 주세요.');
  process.exitCode = 1;
});
