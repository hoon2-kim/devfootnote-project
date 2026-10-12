import type { EmbeddingFailure, EmbeddingWorkState } from '@devfootnote/db/indexing-policy';

export type { EmbeddingFailure, EmbeddingWorkState } from '@devfootnote/db/indexing-policy';

export type EmbeddingCallFailure = Exclude<
  EmbeddingFailure,
  EmbeddingFenceFailure | 'lease_expired'
>;

export type EmbeddingFenceFailure =
  | 'material_obsolete'
  | 'consent_revoked'
  | 'config_changed'
  | 'reservation_expired'
  | 'reservation_missing';

export interface EmbeddingWorkSnapshot {
  id: string;
  ownerId: string;
  intentId: string;
  configFingerprint: string;
  consentEpoch: number;
  reservationId: string | null;
  state: EmbeddingWorkState;
  attemptCount: number;
  leaseToken: string | null;
}

export interface LockedEmbeddingWork extends EmbeddingWorkSnapshot {
  leaseActive: boolean;
  due: boolean;
}

export type EmbeddingFailureResult = 'retry_wait' | 'final_failed' | 'obsolete' | 'ignored';
export type EmbeddingRecoveryResult =
  'pending' | 'waiting' | 'final_failed' | 'obsolete' | 'ignored';
