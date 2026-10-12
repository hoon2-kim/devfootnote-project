import { describe, expect, it } from 'vitest';
import { approveEmbeddingPolicy, geminiFreePolicy } from '@devfootnote/ai';

describe('임베딩 설정과 예산 기간의 분리', () => {
  it('UTC 월과 예산만 바뀌어도 기존 동의와 벡터 설정은 유지한다', () => {
    const previous = geminiFreePolicy(new Date('2026-09-30T23:59:59Z'));
    const next = geminiFreePolicy(new Date('2026-10-01T00:00:00Z'));

    expect(next.budgetId).not.toBe(previous.budgetId);
    expect(next.fingerprint).toBe(previous.fingerprint);
    expect(approveEmbeddingPolicy({ ...next, budgetLimit: '450000000' }).fingerprint).toBe(
      next.fingerprint,
    );
    expect(approveEmbeddingPolicy({ ...next, pricePerToken: '300' }).fingerprint).toBe(
      next.fingerprint,
    );
  });

  it('모델·입력 처리 또는 전송 동의 조건이 바뀌면 설정을 구분한다', () => {
    const policy = geminiFreePolicy(new Date('2026-10-01T00:00:00Z'));

    for (const change of [
      { modelVersion: '다른 모델 버전' },
      { inputVersion: '다른 입력 처리' },
      { policyVersion: '다른 동의 정책' },
      { retentionNotice: '다른 전송·보존 조건' },
    ]) {
      expect(approveEmbeddingPolicy({ ...policy, ...change }).fingerprint).not.toBe(
        policy.fingerprint,
      );
    }
  });
});
