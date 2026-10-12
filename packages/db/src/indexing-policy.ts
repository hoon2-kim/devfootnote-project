// API·worker·DB CHECK가 공유하는 상태 계약이다. 테이블이나 연결은 노출하지 않는다.
export const embeddingMaxAttempts = 5;

export const embeddingWorkStates = [
  'PENDING',
  'LEASED',
  'CALLING',
  'RETRY_WAIT',
  'PUBLISHED',
  'FINAL_FAILED',
  'OBSOLETE',
] as const;

export const embeddingFailureClasses = [
  'timeout',
  'rate_limited',
  'provider_error',
  'access_denied',
  'invalid_response',
  'unknown_outcome',
  'lease_expired',
  'material_obsolete',
  'consent_revoked',
  'config_changed',
  'reservation_expired',
  'reservation_missing',
] as const;

export type EmbeddingWorkState = (typeof embeddingWorkStates)[number];
export type EmbeddingFailure = (typeof embeddingFailureClasses)[number];
