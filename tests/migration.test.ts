import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('migration은 DB 설정 누락 시 명시적으로 실패한다', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: path.resolve('packages/backend'), encoding: 'utf8', timeout: 5000, env,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('DATABASE_URL을 명시');
});

it('migration은 연결 URL 파싱 실패에도 입력과 stack을 노출하지 않는다', () => {
  // 실제 연결 없이 URL parser에서 거부되는 합성 입력이다.
  const result = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: path.resolve('packages/backend'), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, DATABASE_URL: 'postgresql://PRIVATE_USER:PRIVATE_PASSWORD@localhost:INVALID_PORT/private_database' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('MIGRATION_ERROR');
  expect(result.stdout + result.stderr).not.toMatch(/PRIVATE_|INVALID_PORT|private_database|postgresql:\/\/|\n\s+at /);
});
