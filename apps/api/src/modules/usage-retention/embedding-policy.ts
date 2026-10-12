export type { EmbeddingPolicy, ApprovedEmbeddingPolicy } from '@devfootnote/ai';

export function embeddingMaximumCost(
  chunkCounts: readonly number[],
  maximumPerChunk: string,
): bigint {
  return chunkCounts.reduce((sum, count) => sum + BigInt(count) * BigInt(maximumPerChunk), 0n);
}

export interface EmbeddingConsent {
  epoch: number;
  configFingerprint: string | null;
  granted: boolean;
}

export class UsageError extends Error {
  constructor(
    readonly kind:
      | 'not_configured'
      | 'consent_conflict'
      | 'budget_exhausted'
      | 'policy_conflict'
      | 'unavailable',
  ) {
    super(kind);
  }
}
