import { z } from 'zod';
import { geminiFreePolicy, geminiFreeAnswerPolicy } from '@devfootnote/ai';

const schema = z.object({
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .pipe(z.string().refine((value) => new URL(value).pathname.length > 1)),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  GEMINI_API_KEY: z.string().trim().optional(),
});

// 입력값 없이 고정 문구와 설정 키만 담아 기동 실패 로그에서 안전하게 구분한다.
export class EnvironmentError extends Error {}

export function validateEnvironment(env: Record<string, unknown>) {
  const result = schema.safeParse(env);

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];

    throw new EnvironmentError(`환경 설정을 확인해 주세요: ${fields.join(', ')}`);
  }

  return {
    databaseUrl: result.data.DATABASE_URL,
    redisUrl: result.data.REDIS_URL,
    geminiApiKey: result.data.GEMINI_API_KEY,
    embeddingPolicy: result.data.GEMINI_API_KEY ? geminiFreePolicy() : null,
    answerPolicy: result.data.GEMINI_API_KEY ? geminiFreeAnswerPolicy() : null,
    embeddingConfigFingerprint: result.data.GEMINI_API_KEY ? geminiFreePolicy().fingerprint : null,
  };
}
