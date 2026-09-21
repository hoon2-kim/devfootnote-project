import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { EnvironmentError } from './config/environment.js';

// 실제 AppModule로 만든다 — 모듈 그래프를 복제하면 controller 가 늘 때 명세가 조용히 뒤처진다.
// pg.Pool 은 첫 질의까지 연결하지 않아 여기서 DB 접속은 없다.
process.env.DATABASE_URL ??= 'postgresql://openapi:openapi@127.0.0.1:1/openapi_never_connects';
// 필수 환경 변수가 늘면 여기도 채운다 — 빠뜨리면 아래 catch 가 누락 키를 알려 준다.
Object.assign(process.env, {
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://127.0.0.1:3000',
  GOOGLE_CLIENT_ID: 'openapi-fixture',
  GOOGLE_CLIENT_SECRET: 'openapi-fixture',
  JWT_ACCESS_SECRET: '0123456789abcdef'.repeat(4),
  JWT_REFRESH_SECRET: 'fedcba9876543210'.repeat(4),
  CSRF_SECRET: 'csrf-openapi-fixture-not-a-secret'.repeat(2),
});

const output = path.resolve(__dirname, '../openapi.json');

async function generate() {
  const app = configureApp(
    await NestFactory.create(AppModule, { logger: false, abortOnError: false }),
  );

  try {
    await app.init();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('devfootnote API')
        .setVersion('0.0.0')
        .addCookieAuth('devfootnote_access', { type: 'apiKey', in: 'cookie' }, 'access')
        .addCookieAuth('devfootnote_refresh', { type: 'apiKey', in: 'cookie' }, 'refresh')
        .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
        .build(),
    );

    await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

generate().catch((error: unknown) => {
  console.error(
    error instanceof EnvironmentError
      ? `OpenAPI 생성 실패: ${error.message}`
      : `OpenAPI 생성 실패: ${error instanceof Error ? error.name : 'Unknown'}`,
  );
  process.exit(1);
});
