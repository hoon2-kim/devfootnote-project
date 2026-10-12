import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, sql } from 'drizzle-orm';
import { embeddingVectors, embeddingWorks } from '@devfootnote/db/schema/indexing';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';

@Injectable()
export class EmbeddingQueryRepository {
  constructor(private readonly transactions: TransactionHost<PostgresTransactionAdapter>) {}

  async published(ownerId: string, configFingerprint: string, consentEpoch: number) {
    return this.transactions.tx
      .selectDistinct({
        materialId: embeddingVectors.materialId,
        revisionId: embeddingVectors.revisionId,
        score: sql<number>`1`.mapWith(Number),
      })
      .from(embeddingVectors)
      .innerJoin(
        embeddingWorks,
        and(
          eq(embeddingWorks.id, embeddingVectors.workId),
          eq(embeddingWorks.ownerId, embeddingVectors.ownerId),
        ),
      )
      .where(
        and(
          eq(embeddingVectors.ownerId, ownerId),
          eq(embeddingWorks.configFingerprint, configFingerprint),
          eq(embeddingWorks.consentEpoch, consentEpoch),
          eq(embeddingWorks.state, 'PUBLISHED'),
        ),
      );
  }

  async rank(ownerId: string, configFingerprint: string, consentEpoch: number, vector: number[]) {
    // 초기 개인 자료함은 정확 검색을 사용한다. 전체 owner 자료에서 계산하고 현재 자료 필터 뒤 LIMIT한다.
    const score =
      sql<number>`max(1 - (${embeddingVectors.embedding} <=> ${JSON.stringify(vector)}::vector))`.mapWith(
        Number,
      );

    return this.transactions.tx
      .select({
        materialId: embeddingVectors.materialId,
        revisionId: embeddingVectors.revisionId,
        score,
      })
      .from(embeddingVectors)
      .innerJoin(
        embeddingWorks,
        and(
          eq(embeddingWorks.ownerId, embeddingVectors.ownerId),
          eq(embeddingWorks.id, embeddingVectors.workId),
        ),
      )
      .where(
        and(
          eq(embeddingVectors.ownerId, ownerId),
          eq(embeddingWorks.configFingerprint, configFingerprint),
          eq(embeddingWorks.consentEpoch, consentEpoch),
          eq(embeddingWorks.state, 'PUBLISHED'),
        ),
      )
      .groupBy(embeddingVectors.materialId, embeddingVectors.revisionId);
  }
}
