import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { validateEnvironment } from '../apps/api/src/config/environment.js';
import { validateEnvironment as validateWorkerEnvironment } from '../apps/worker/src/config/environment.js';
import { authEnvironment } from './auth-environment.js';

// 통합 테스트와 같은 합성 설정을 쓴다. 필수 항목이 늘어날 때 한 곳만 고치면 된다.
const valid = {
  ...authEnvironment,
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:55432/test',
};

describe('환경 설정 검증', () => {
  it('키가 있으면 API와 worker에 같은 승인 답변 정책을 구성한다', () => {
    const environment = {
      ...valid,
      REDIS_URL: 'redis://127.0.0.1:56379',
      GEMINI_API_KEY: 'fixture-not-a-real-key',
    };
    const api = validateEnvironment(environment);
    const worker = validateWorkerEnvironment(environment);

    expect(api).toMatchObject({
      answerPolicy: {
        model: 'gemini-3.5-flash-lite',
        answerRetentionSeconds: 7 * 24 * 3600,
        receiptRetentionDays: 90,
        budgetLimit: '900000000',
        purposeBudgetLimit: '450000000',
      },
    });
    expect(worker.answerPolicy).toEqual(api.answerPolicy);
    expect(worker.answerPolicy?.fingerprint).toEqual(expect.any(String));
  });
  it.each([
    { label: '누락', key: undefined },
    { label: '빈 문자열', key: '' },
    { label: '공백', key: '   ' },
  ])('키가 $label 상태이면 두 앱 모두 답변을 비활성화한다', ({ key }) => {
    const environment = {
      ...valid,
      REDIS_URL: 'redis://127.0.0.1:56379',
      GEMINI_API_KEY: key,
    };

    expect(validateEnvironment(environment)).toMatchObject({ answerPolicy: null });
    expect(validateWorkerEnvironment(environment)).toMatchObject({ answerPolicy: null });
  });

  it('운영 HTTPS origin으로 callback과 Secure 쿠키를 함께 구성한다', () => {
    const result = validateEnvironment({
      ...valid,
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://example.com',
    });

    expect(result.auth.callbackUrl).toBe('https://example.com/api/v1/auth/google/callback');
    expect(result.auth.secureCookies).toBe(true);
  });
  it.each([
    { JWT_REFRESH_SECRET: valid.JWT_ACCESS_SECRET },
    { CSRF_SECRET: valid.JWT_ACCESS_SECRET },
    { NODE_ENV: 'production', APP_ORIGIN: 'http://example.com' },
    { NODE_ENV: 'production', APP_ORIGIN: 'https://localhost' },
  ])('잘못된 설정을 fail closed한다: %j', (patch) => {
    expect(() => validateEnvironment({ ...valid, ...patch })).toThrow();
  });
  it('실패에 입력값을 노출하지 않는다', () => {
    try {
      validateEnvironment({ ...valid, DATABASE_URL: 'PRIVATE_PASSWORD' });
    } catch (error) {
      expect(String(error)).toContain('환경 설정을 확인해 주세요: DATABASE_URL');
      expect(String(error)).not.toContain('PRIVATE_PASSWORD');

      return;
    }

    throw new Error('잘못된 설정을 허용했습니다.');
  });
});

it.each(['DATABASE_URL', 'REDIS_URL'].map((field) => ({ field })))(
  '워커 기동 실패 시 $field 설정 이름만 안내하고 입력값은 숨긴다',
  ({ field }) => {
    const result = spawnSync(process.execPath, ['apps/worker/dist/main.js'], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://fixture:PRIVATE_PASSWORD@127.0.0.1:1/fixture',
        REDIS_URL: 'redis://:PRIVATE_REDIS_PASSWORD@127.0.0.1:1',
        [field]: 'PRIVATE_INVALID_VALUE',
      },
    });
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(1);
    expect(output).toContain(`환경 설정을 확인해 주세요: ${field}`);
    expect(output).not.toContain('PRIVATE_');
  },
);
