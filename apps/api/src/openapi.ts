import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

// 실제 AppModule과 실제 configureApp으로 명세를 만든다. 별도 모듈 그래프를 복제하면
// controller·global prefix가 추가될 때 명세가 조용히 뒤처진다.
// pg.Pool은 첫 질의까지 연결하지 않으므로 이 과정에서 DB 접속은 발생하지 않는다.
process.env.DATABASE_URL ??= 'postgresql://openapi:openapi@127.0.0.1:1/openapi_never_connects';

const output = path.resolve(__dirname, '../../../docs/openapi.json');

async function generate() {
  const app = configureApp(await NestFactory.create(AppModule, { logger: false, abortOnError: false }));
  try {
    await app.init();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('devfootnote API').setVersion('0.0.0').build(),
    );
    await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

generate().catch((error: unknown) => {
  console.error(`OpenAPI 생성 실패: ${error instanceof Error ? error.name : 'Unknown'}`);
  process.exit(1);
});
