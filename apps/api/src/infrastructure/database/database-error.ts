import { DrizzleQueryError } from 'drizzle-orm';

// 분류만 공유한다. 업무별 constraint 해석과 사용자 응답은 각 기능/API가 소유한다.
const unavailableCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  '08001',
  '08003',
  '08006',
  '53300',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
]);

export function isDatabaseUnavailable(error: unknown): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;

  return (
    cause instanceof Error &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    unavailableCodes.has(cause.code)
  );
}
