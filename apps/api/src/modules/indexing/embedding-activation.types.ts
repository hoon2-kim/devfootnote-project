import type { CurrentEmbeddingIntent, EmbeddingTarget } from '../materials/index.js';
import type { ApprovedEmbeddingPolicy } from '../usage-retention/index.js';

export interface EmbeddingPreviewResult {
  configured: boolean;
  consentEpoch: number;
  policy: ApprovedEmbeddingPolicy | null;
  items: CurrentEmbeddingIntent[];
  nextCursor: string | null;
  reservedMaximum: string;
  consented: boolean;
  automatic: boolean;
  includeExisting: boolean;
  states: {
    materialId: string;
    revisionId: string;
    title: string | null;
    state: string;
    failure: string | null;
  }[];
}

export interface ActivateEmbeddings {
  requestId: string;
  configFingerprint: string;
  policyVersion: string;
  expectedConsentEpoch: number;
  accepted: boolean;
  targets: EmbeddingTarget[];
  retryFailed?: boolean;
  includeExisting?: boolean;
}

export interface EmbeddingActivationResult {
  requestId: string;
  consentEpoch: number;
  workIds: string[];
  reservedMaximum: string;
}

export class IndexingError extends Error {
  constructor(readonly kind: 'request_conflict' | 'consent_required' | 'invalid_targets') {
    super(kind);
  }
}
