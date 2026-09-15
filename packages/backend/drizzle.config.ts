import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/**/*.schema.ts',
  out: './src/infrastructure/database/migrations',
  // generate는 연결이 필요 없고 migrate는 실행 스크립트에서 URL 존재를 확인한다.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: false,
});
