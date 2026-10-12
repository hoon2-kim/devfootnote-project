import { describe, expect, it } from 'vitest';
import {
  classifyEmbeddingProviderError,
  embeddingFailureDecision,
  embeddingFenceFailure,
  holdsLease,
} from '../apps/worker/src/modules/indexing/embedding-execution.policy.js';
import type { LockedEmbeddingWork } from '../apps/worker/src/modules/indexing/embedding-execution.types.js';

function work(overrides: Partial<LockedEmbeddingWork> = {}): LockedEmbeddingWork {
  return {
    id: 'work',
    ownerId: 'owner',
    intentId: 'intent',
    configFingerprint: 'configuration',
    consentEpoch: 2,
    reservationId: 'reservation',
    state: 'CALLING',
    attemptCount: 1,
    leaseToken: 'token',
    leaseActive: true,
    due: true,
    ...overrides,
  };
}

function fenceInput() {
  return {
    configuration: 'configuration',
    work: work(),
    consent: { epoch: 2, configFingerprint: 'configuration', granted: true },
    hasCurrentIntent: true,
    reservation: {
      id: 'reservation',
      configFingerprint: 'configuration',
      consentEpoch: 2,
      state: 'reserved' as const,
      active: true,
      exposed: true,
    },
  };
}

describe('임베딩 실행 판단 — DB 전이와 별개의 순수 정책', () => {
  it('같은 token과 살아 있는 lease여도 요청한 상태가 다르면 소유자로 인정하지 않는다', () => {
    expect(holdsLease(work(), 'token', 'CALLING')).toBe(true);
    expect(holdsLease(work(), 'other-token', 'CALLING')).toBe(false);
    expect(holdsLease(work({ leaseActive: false }), 'token', 'CALLING')).toBe(false);
    expect(holdsLease(work(), 'token', 'LEASED')).toBe(false);
    expect(holdsLease(work({ state: 'LEASED' }), 'token', 'LEASED')).toBe(true);
    expect(holdsLease(work({ state: 'PUBLISHED' }), 'token', 'CALLING')).toBe(false);
  });

  it('현재 설정·동의·자료·예약이 모두 유효해야 fence를 통과한다', () => {
    expect(embeddingFenceFailure(fenceInput())).toBeNull();
  });

  it('worker 설정이나 예약의 설정·epoch가 바뀌면 config_changed다', () => {
    const input = fenceInput();

    expect(embeddingFenceFailure({ ...input, configuration: 'other' })).toBe('config_changed');
    expect(
      embeddingFenceFailure({
        ...input,
        reservation: { ...input.reservation, configFingerprint: 'other' },
      }),
    ).toBe('config_changed');
    expect(
      embeddingFenceFailure({
        ...input,
        reservation: { ...input.reservation, consentEpoch: 3 },
      }),
    ).toBe('config_changed');
  });

  it('동의가 없거나 철회·변경된 경우 예약이 남아 있어도 거부한다', () => {
    const input = fenceInput();

    for (const consent of [
      null,
      { ...input.consent, granted: false },
      { ...input.consent, epoch: 3 },
      { ...input.consent, configFingerprint: 'other' },
    ]) {
      expect(embeddingFenceFailure({ ...input, consent })).toBe('consent_revoked');
    }
  });

  it('현재 자료 부재와 예약 부재·만료를 구분하고 노출된 만료 예약도 거부한다', () => {
    const input = fenceInput();

    expect(embeddingFenceFailure({ ...input, hasCurrentIntent: false })).toBe('material_obsolete');
    expect(embeddingFenceFailure({ ...input, reservation: null })).toBe('reservation_missing');
    expect(
      embeddingFenceFailure({
        ...input,
        reservation: { ...input.reservation, active: false },
      }),
    ).toBe('reservation_expired');
  });

  it.each([
    { kind: 'request_rejected', failure: 'rate_limited', retryable: false },
    { kind: 'provider_error', failure: 'provider_error', retryable: true },
    { kind: 'unknown_outcome', failure: 'unknown_outcome', retryable: true },
    { kind: 'access_denied', failure: 'access_denied', retryable: false },
    { kind: 'not_configured', failure: 'provider_error', retryable: false },
    { kind: 'invalid_input', failure: 'invalid_response', retryable: false },
    { kind: 'invalid_response', failure: 'invalid_response', retryable: false },
  ] as const)(
    '제공자 $kind 오류의 실패 분류와 자동 재시도 여부를 보존한다',
    ({ kind, ...expected }) => {
      expect(classifyEmbeddingProviderError(kind)).toEqual(expected);
    },
  );

  it('일시 실패는 네 번째까지 재시도하고 다섯 번째에 종료한다', () => {
    for (const attemptCount of [1, 2, 3, 4]) {
      expect(
        embeddingFailureDecision({ attemptCount, failure: 'provider_error', retryable: true }),
      ).toEqual({ state: 'RETRY_WAIT', outcome: 'RETRYABLE_FAILED' });
    }

    expect(
      embeddingFailureDecision({ attemptCount: 5, failure: 'provider_error', retryable: true }),
    ).toEqual({ state: 'FINAL_FAILED', outcome: 'FINAL_FAILED' });
  });

  it.each([{ failure: 'invalid_response' }, { failure: 'access_denied' }] as const)(
    '$failure 영구 오류는 호출자가 재시도를 허용해도 첫 시도에 종료한다',
    ({ failure }) => {
      expect(embeddingFailureDecision({ attemptCount: 1, failure, retryable: true })).toEqual({
        state: 'FINAL_FAILED',
        outcome: 'FINAL_FAILED',
      });
    },
  );

  it('무료 한도 거부는 남은 시도 수와 무관하게 종료한다', () => {
    expect(
      embeddingFailureDecision({ attemptCount: 1, failure: 'rate_limited', retryable: false }),
    ).toEqual({ state: 'FINAL_FAILED', outcome: 'FINAL_FAILED' });
  });

  it.each([{ failure: 'lease_expired' }, { failure: 'unknown_outcome' }] as const)(
    '$failure 수신 여부가 불명확한 실패는 재시도·최종 실패 모두 UNKNOWN을 보존한다',
    ({ failure }) => {
      expect(embeddingFailureDecision({ attemptCount: 1, failure, retryable: true })).toEqual({
        state: 'RETRY_WAIT',
        outcome: 'UNKNOWN',
      });
      expect(embeddingFailureDecision({ attemptCount: 5, failure, retryable: true })).toEqual({
        state: 'FINAL_FAILED',
        outcome: 'UNKNOWN',
      });
    },
  );
});
