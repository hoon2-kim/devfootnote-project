// 원문·owner·lease token을 Redis payload/result에 싣지 않는다. DB가 작업의 권위다.
export const EMBEDDING_CLAIM_QUEUE = 'devfootnote-embedding-claims';
export const CLAIM_EMBEDDING_WORK = 'claim-embedding-work';

export interface EmbeddingClaimJob {
  workId: string;
}

export type EmbeddingClaimResult = 'claimed' | 'not-claimable';
