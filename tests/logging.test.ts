import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// 실제 singleton logger의 출력과 초기 환경 설정을 별도 프로세스에서 검사한다.
function runLogger(script: string, overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...overrides };

  if (!Object.hasOwn(overrides, 'LOG_LEVEL')) {
    delete env.LOG_LEVEL;
  }

  return spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 5000 });
}

describe.each([
  { app: 'api', name: 'devfootnote', entryModule: 'app.module', entryClass: 'AppModule' },
  {
    app: 'worker',
    name: 'devfootnote-worker',
    entryModule: 'worker.module',
    entryClass: 'WorkerModule',
  },
])('$app 로그 경계', ({ app, name, entryModule, entryClass }) => {
  it('실제 기동 중 provider 실패는 원본 오류를 숨기고 정상 시작 로그를 유지한다', () => {
    const result = runLogger(`
      require('reflect-metadata');
      const { Module } = require('@nestjs/common');
      const { ${entryClass}: EntryModule } = require('./apps/${app}/dist/${entryModule}.js');

      // 외부 연결 없이 실제 main의 Nest 생성·오류 처리 경로를 실행한다.
      Module({
        imports: [],
        controllers: [],
        providers: [{
          provide: 'FAILING_PROVIDER',
          useFactory() {
            const error = new Error('PRIVATE_PROVIDER_MESSAGE', {
              cause: new Error('PRIVATE_PROVIDER_CAUSE'),
            });
            error.stack = 'PRIVATE_PROVIDER_STACK';
            throw error;
          },
        }],
      })(EntryModule);

      require('./apps/${app}/dist/main.js');
    `);
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(1);
    expect(output).toContain('Starting Nest application');
    expect(output).toContain('시작하지 못했습니다');
    expect(output).not.toContain('PRIVATE_');
  });

  it('호스트 시간대와 무관하게 한국시간 ISO 문자열로 기록한다', () => {
    for (const TZ of ['UTC', 'America/Los_Angeles']) {
      const result = runLogger(
        `
      Date.now = () => Date.parse('2026-12-31T18:04:05.678Z');
      const { logger } = require('./apps/${app}/dist/infrastructure/logging/logger.js');
      logger.info('시간 확인');
    `,
        { TZ },
      );

      expect(result.status).toBe(0);
      const entry = JSON.parse(result.stdout);

      expect(entry.time).toBe('2027-01-01T03:04:05.678+09:00');
      expect(Date.parse(entry.time)).toBe(Date.parse('2026-12-31T18:04:05.678Z'));
      expect(entry.name).toBe(name);
    }
  });

  it('잘못된 LOG_LEVEL은 입력값을 노출하지 않고 실패한다', () => {
    const result = runLogger(`require('./apps/${app}/dist/infrastructure/logging/logger.js');`, {
      LOG_LEVEL: 'PRIVATE_CONFIG_VALUE',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('LOG_LEVEL');
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_CONFIG_VALUE');
  });

  it('redact에 지정한 원본 객체·민감 필드를 제거하고 안전한 로그는 보존한다', () => {
    const result = runLogger(`
    const { logger } = require('./apps/${app}/dist/infrastructure/logging/logger.js');
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

    expect(entry).toMatchObject({
      status: 500,
      error: 'INTERNAL_SERVER_ERROR',
      msg: '요청 처리 실패',
    });

    for (const field of ['req', 'res', 'err', 'password', 'accessToken', 'refreshToken']) {
      expect(entry).not.toHaveProperty(field);
    }
  });

  it('설정한 로그 레벨보다 낮은 메시지는 출력하지 않는다', () => {
    const result = runLogger(
      `
    const { logger } = require('./apps/${app}/dist/infrastructure/logging/logger.js');
    logger.info('숨길 메시지');
    logger.warn('남길 메시지');
  `,
      { LOG_LEVEL: 'warn' },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ level: 40, msg: '남길 메시지' });
  });
});
