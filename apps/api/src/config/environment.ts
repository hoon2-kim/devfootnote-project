import type { AuthConfig } from '../modules/auth/index.js';
import { environmentSchema } from './environment.schema.js';

// message 에 고정 문구와 키 이름만 담는다 — 기동 실패 로그에 그대로 남겨도 안전하다는 표식이다.
export class EnvironmentError extends Error {}

export function validateEnvironment(env: Record<string, unknown>): {
  port: number;
  auth: AuthConfig;
} {
  const result = environmentSchema.safeParse(env);

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];

    throw new EnvironmentError(`환경 설정을 확인해 주세요: ${fields.join(', ')}`);
  }

  const config = result.data;

  return {
    port: config.PORT,
    auth: {
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      origin: config.APP_ORIGIN.origin,
      callbackUrl: `${config.APP_ORIGIN.origin}/api/v1/auth/google/callback`,
      secureCookies: config.APP_ORIGIN.protocol === 'https:',
      accessSecret: config.JWT_ACCESS_SECRET,
      refreshSecret: config.JWT_REFRESH_SECRET,
      csrfSecret: config.CSRF_SECRET,
    },
  };
}
