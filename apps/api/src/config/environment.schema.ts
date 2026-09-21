import { z } from 'zod';

const requiredString = z.string().trim().min(1);
// 길이만 확인한다. 암호학적 난수 생성 여부를 문자열 모양으로 추측하지 않는다.
const signingKey = z.string().min(32);
const originSchema = z
  .url({ protocol: /^https?$/ })
  .transform((value) => new URL(value))
  .refine(
    (url) => url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password,
  );

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8000),
    DATABASE_URL: z
      .url({ protocol: /^postgres(ql)?$/ })
      .refine((value) => new URL(value).pathname.length > 1),
    APP_ORIGIN: originSchema,
    GOOGLE_CLIENT_ID: requiredString,
    GOOGLE_CLIENT_SECRET: requiredString,
    JWT_ACCESS_SECRET: signingKey,
    JWT_REFRESH_SECRET: signingKey,
    CSRF_SECRET: signingKey,
  })
  .superRefine((env, ctx) => {
    // origin 이 cookie Secure 와 callback URL 을 결정한다 — 운영에서 http 면 토큰이 평문으로 오간다.
    const local =
      ['localhost', '127.0.0.1', '[::1]'].includes(env.APP_ORIGIN.hostname) ||
      env.APP_ORIGIN.hostname.endsWith('.localhost');

    if (
      (env.NODE_ENV === 'production' && (local || env.APP_ORIGIN.protocol !== 'https:')) ||
      (env.APP_ORIGIN.protocol === 'http:' && !local)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ORIGIN'],
        message: 'HTTPS origin을 확인해 주세요.',
      });
    }

    // 키를 공유하면 access 를 refresh 로 제출해도 서명 검증을 통과한다.
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: '서로 다른 signing key가 필요합니다.',
      });
    }

    if (env.CSRF_SECRET === env.JWT_ACCESS_SECRET || env.CSRF_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['CSRF_SECRET'],
        message: 'JWT와 다른 CSRF key가 필요합니다.',
      });
    }
  });
