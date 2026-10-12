import type { EmbeddingProviderError } from '@devfootnote/ai';
import { embeddingMaxAttempts } from '@devfootnote/db/indexing-policy';
import type { EmbeddingConsent, EmbeddingReservation } from '../usage-retention/index.js';
import type {
  EmbeddingCallFailure,
  EmbeddingFenceFailure,
  EmbeddingWorkState,
  LockedEmbeddingWork,
} from './embedding-execution.types.js';

export function holdsLease(work: LockedEmbeddingWork, token: string, state: 'LEASED' | 'CALLING') {
  return work.state === state && work.leaseToken === token && work.leaseActive;
}

export function embeddingFenceFailure({
  configuration,
  work,
  consent,
  hasCurrentIntent,
  reservation,
}: {
  configuration: string;
  work: LockedEmbeddingWork;
  consent: EmbeddingConsent | null;
  hasCurrentIntent: boolean;
  reservation: EmbeddingReservation | null;
}): EmbeddingFenceFailure | null {
  if (configuration !== work.configFingerprint) {
    return 'config_changed';
  }

  if (
    !consent?.granted ||
    consent.epoch !== work.consentEpoch ||
    consent.configFingerprint !== work.configFingerprint
  ) {
    return 'consent_revoked';
  }

  if (!hasCurrentIntent) {
    return 'material_obsolete';
  }

  if (!reservation) {
    return 'reservation_missing';
  }

  if (
    reservation.configFingerprint !== work.configFingerprint ||
    reservation.consentEpoch !== work.consentEpoch
  ) {
    return 'config_changed';
  }

  return reservation.active ? null : 'reservation_expired';
}

export function classifyEmbeddingProviderError(kind: EmbeddingProviderError['kind']): {
  failure: EmbeddingCallFailure;
  retryable: boolean;
} {
  switch (kind) {
    case 'request_rejected':
      // 무료 429를 일시 제한으로 추측해 반복하지 않는다.
      return { failure: 'rate_limited', retryable: false };
    case 'provider_error':
      return { failure: 'provider_error', retryable: true };
    case 'unknown_outcome':
      return { failure: 'unknown_outcome', retryable: true };
    case 'access_denied':
      return { failure: 'access_denied', retryable: false };
    case 'not_configured':
      return { failure: 'provider_error', retryable: false };
    case 'invalid_input':
    case 'invalid_response':
      return { failure: 'invalid_response', retryable: false };
  }
}

export function embeddingFailureDecision({
  attemptCount,
  failure,
  retryable,
}: {
  attemptCount: number;
  failure: EmbeddingCallFailure | 'lease_expired';
  retryable: boolean;
}) {
  const final =
    !retryable ||
    failure === 'invalid_response' ||
    failure === 'access_denied' ||
    attemptCount >= embeddingMaxAttempts;
  const unknown = failure === 'unknown_outcome' || failure === 'lease_expired';

  if (final) {
    return { state: 'FINAL_FAILED', outcome: unknown ? 'UNKNOWN' : 'FINAL_FAILED' } as const;
  }

  return { state: 'RETRY_WAIT', outcome: unknown ? 'UNKNOWN' : 'RETRYABLE_FAILED' } as const;
}

export function isTerminalWork(state: EmbeddingWorkState) {
  return state === 'PUBLISHED' || state === 'FINAL_FAILED' || state === 'OBSOLETE';
}

export function embeddingRetryDelay(attemptCount: number) {
  const upperBoundMs = Math.min(5_000 * 2 ** (attemptCount - 1), 60_000);

  return Math.floor(Math.random() * upperBoundMs);
}
