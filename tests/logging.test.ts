import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// 실제 singleton logger의 출력과 초기 환경 설정을 별도 프로세스에서 검사한다.
function runLogger(script: string, overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...overrides };
  if (!Object.hasOwn(overrides, 'LOG_LEVEL')) delete env.LOG_LEVEL;
  return spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 5000 });
}

it('호스트 시간대와 무관하게 한국시간 ISO 문자열로 기록한다', () => {
  for (const TZ of ['UTC', 'America/Los_Angeles']) {
    const result = runLogger(`
      Date.now = () => Date.parse('2026-12-31T18:04:05.678Z');
      const { logger } = require('./packages/backend/dist/infrastructure/observability/logging.js');
      logger.info('시간 확인');
    `, { TZ });
    expect(result.status).toBe(0);
    const entry = JSON.parse(result.stdout);
    expect(entry.time).toBe('2027-01-01T03:04:05.678+09:00');
    expect(Date.parse(entry.time)).toBe(Date.parse('2026-12-31T18:04:05.678Z'));
    expect(entry.name).toBe('devfootnote');
  }
});

it('기본 info 레벨과 LOG_LEVEL 설정을 적용한다', () => {
  const script = `
    const { logger } = require('./packages/backend/dist/infrastructure/observability/logging.js');
    logger.debug('debug_fixture');
    logger.info('info_fixture');
    logger.error('error_fixture');
  `;
  const standard = runLogger(script);
  expect(standard.status).toBe(0);
  expect(standard.stdout).not.toContain('debug_fixture');
  expect(standard.stdout).toContain('info_fixture');
  const debug = runLogger(script, { LOG_LEVEL: 'debug' });
  expect(debug.status).toBe(0);
  expect(debug.stdout).toContain('debug_fixture');
  const silent = runLogger(script, { LOG_LEVEL: 'silent' });
  expect(silent.status).toBe(0);
  expect(silent.stdout).toBe('');
});

it('잘못된 LOG_LEVEL은 입력값을 노출하지 않고 실패한다', () => {
  const result = runLogger("require('./packages/backend/dist/infrastructure/observability/logging.js');", { LOG_LEVEL: 'PRIVATE_CONFIG_VALUE' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('LOG_LEVEL');
  expect(result.stdout + result.stderr).not.toContain('PRIVATE_CONFIG_VALUE');
});

it('redact에 지정한 원본 객체·민감 필드를 제거하고 안전한 로그는 보존한다', () => {
  const result = runLogger(`
    const { logger } = require('./packages/backend/dist/infrastructure/observability/logging.js');
    logger.error({
      status: 500, error: 'INTERNAL_SERVER_ERROR',
      req: { url: '/?token=PRIVATE_REQUEST', body: 'PRIVATE_BODY' },
      res: { headers: { 'set-cookie': 'PRIVATE_COOKIE' } },
      err: new Error('PRIVATE_EXCEPTION'),
      password: 'PRIVATE_PASSWORD', accessToken: 'PRIVATE_ACCESS', refreshToken: 'PRIVATE_REFRESH',
    }, '요청 처리 실패');
  `);
  expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).not.toContain('PRIVATE_');
  const entry = JSON.parse(result.stdout);
  expect(entry).toMatchObject({ status: 500, error: 'INTERNAL_SERVER_ERROR', msg: '요청 처리 실패' });
  for (const field of ['req', 'res', 'err', 'password', 'accessToken', 'refreshToken']) expect(entry).not.toHaveProperty(field);
});
