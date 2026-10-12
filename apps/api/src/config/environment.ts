import type { AuthConfig } from '../modules/auth/index.js';
import { environmentSchema } from './environment.schema.js';
import {
  geminiFreePolicy,
  geminiFreeAnswerPolicy,
  type EmbeddingPolicy,
  type AnswerPolicy,
} from '@devfootnote/ai';

// message 에 고정 문구와 키 이름만 담는다 — 기동 실패 로그에 그대로 남겨도 안전하다는 표식이다.
export class EnvironmentError extends Error {}

export function validateEnvironment(env: Record<string, unknown>): {
  port: number;
  databaseUrl: string;
  embeddingPolicy: EmbeddingPolicy | null;
  answerPolicy: AnswerPolicy | null;
  geminiApiKey?: string;
  redisUrl?: string;
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
    databaseUrl: config.DATABASE_URL,
    // 승인된 무료 개발 설정만 사용한다. 실제 호출에는 별도로 owner의 화면 동의가 필요하다.
    embeddingPolicy: config.GEMINI_API_KEY ? geminiFreePolicy() : null,
    // 설정 활성화는 동의를 대신하지 않는다. 답변 전송은 별도 동의·예약 후 worker가 수행한다.
    answerPolicy: config.GEMINI_API_KEY ? geminiFreeAnswerPolicy() : null,
    geminiApiKey: config.GEMINI_API_KEY,
    redisUrl: config.REDIS_URL,
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
