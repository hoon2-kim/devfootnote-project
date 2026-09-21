import { describe, expect, it } from 'vitest';
import { validateEnvironment } from '../apps/api/src/config/environment.js';
import { authEnvironment } from './auth-environment.js';

// 통합 테스트와 같은 합성 설정을 쓴다. 필수 항목이 늘어날 때 한 곳만 고치면 된다.
const valid = {
  ...authEnvironment,
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:55432/test',
};

describe('환경 설정 검증', () => {
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
      expect(String(error)).not.toContain('PRIVATE_PASSWORD');

      return;
    }

    throw new Error('잘못된 설정을 허용했습니다.');
  });
});
