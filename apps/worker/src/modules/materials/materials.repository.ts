import {
  embeddingIntents,
  materialChunks,
  materialRevisions,
  materials,
} from '@devfootnote/db/schema/materials';
import { Injectable } from '@nestjs/common';
import {
  InjectTransactionHost,
  Propagation,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import { and, asc, desc, eq, gt, gte, isNull, ne, sql } from 'drizzle-orm';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';

@Injectable()
export class MaterialsRepository {
  constructor(
    @InjectTransactionHost('worker')
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  @Transactional('worker', Propagation.Mandatory)
  async lockAnswerEvidence(
    ownerId: string,
    targets: readonly { materialId: string; revisionId: string }[],
  ) {
    const result: {
      materialId: string;
      revisionId: string;
      chunkId: string;
      text: string;
      startOffset: number;
      endOffset: number;
    }[] = [];

    for (const target of [...targets].sort((a, b) => a.materialId.localeCompare(b.materialId))) {
      const [material] = await this.transactions.tx
        .select({ revisionId: materials.currentRevisionId, deletedAt: materials.deletedAt })
        .from(materials)
        .where(and(eq(materials.ownerId, ownerId), eq(materials.id, target.materialId)))
        .for('update');

      if (!material || material.deletedAt || material.revisionId !== target.revisionId) {
        return null;
      }

      const chunks = await this.transactions.tx
        .select({
          materialId: materialChunks.materialId,
          revisionId: materialChunks.revisionId,
          chunkId: materialChunks.id,
          text: materialChunks.text,
          startOffset: materialChunks.startOffset,
          endOffset: materialChunks.endOffset,
        })
        .from(materialChunks)
        .where(
          and(
            eq(materialChunks.ownerId, ownerId),
            eq(materialChunks.materialId, target.materialId),
            eq(materialChunks.revisionId, target.revisionId),
          ),
        )
        .orderBy(asc(materialChunks.ordinal));

      result.push(...chunks);
    }

    return result;
  }

  @Transactional('worker', Propagation.Mandatory)
  async currentIntents(
    ownerId: string,
    afterId: string | null,
    enabledAt: string | null,
    limit: number,
  ) {
    return this.transactions.tx
      .select({
        intentId: embeddingIntents.id,
        materialId: embeddingIntents.materialId,
        chunkCount: sql<number>`(select count(*)::int from ${materialChunks}
        where ${materialChunks.ownerId} = ${embeddingIntents.ownerId}
          and ${materialChunks.revisionId} = ${embeddingIntents.revisionId})`,
      })
      .from(embeddingIntents)
      .innerJoin(
        materials,
        and(
          eq(materials.ownerId, embeddingIntents.ownerId),
          eq(materials.id, embeddingIntents.materialId),
          eq(materials.currentRevisionId, embeddingIntents.revisionId),
        ),
      )
      .where(
        and(
          eq(embeddingIntents.ownerId, ownerId),
          isNull(materials.deletedAt),
          enabledAt === null ? undefined : gte(materials.updatedAt, sql`${enabledAt}::timestamptz`),
          afterId ? gt(embeddingIntents.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(embeddingIntents.id))
      .limit(limit);
  }

  @Transactional('worker', Propagation.Mandatory)
  async lockReusableChunk(ownerId: string, materialId: string, chunkId: string) {
    const tx = this.transactions.tx;
    const [material] = await tx
      .select({ revisionId: materials.currentRevisionId, deletedAt: materials.deletedAt })
      .from(materials)
      .where(and(eq(materials.ownerId, ownerId), eq(materials.id, materialId)))
      .for('update');

    if (!material || material.deletedAt) {
      return false;
    }

    const [source] = await tx
      .select({ text: materialChunks.text })
      .from(materialChunks)
      .where(
        and(
          eq(materialChunks.ownerId, ownerId),
          eq(materialChunks.materialId, materialId),
          eq(materialChunks.id, chunkId),
        ),
      );

    if (!source) {
      return false;
    }

    const [current] = await tx
      .select({ id: materialChunks.id })
      .from(materialChunks)
      .where(
        and(
          eq(materialChunks.ownerId, ownerId),
          eq(materialChunks.materialId, materialId),
          eq(materialChunks.revisionId, material.revisionId),
          eq(materialChunks.text, source.text),
        ),
      )
      .limit(1);

    return current !== undefined;
  }

  @Transactional('worker', Propagation.Mandatory)
  async lockCurrentIntent(ownerId: string, intentId: string) {
    const [intent] = await this.transactions.tx
      .select({
        materialId: embeddingIntents.materialId,
        revisionId: embeddingIntents.revisionId,
        contentFingerprint: embeddingIntents.contentFingerprint,
      })
      .from(embeddingIntents)
      .innerJoin(
        materials,
        and(
          eq(materials.ownerId, embeddingIntents.ownerId),
          eq(materials.id, embeddingIntents.materialId),
          eq(materials.currentRevisionId, embeddingIntents.revisionId),
        ),
      )
      .innerJoin(
        materialRevisions,
        and(
          eq(materialRevisions.ownerId, embeddingIntents.ownerId),
          eq(materialRevisions.materialId, embeddingIntents.materialId),
          eq(materialRevisions.id, embeddingIntents.revisionId),
          eq(materialRevisions.contentFingerprint, embeddingIntents.contentFingerprint),
        ),
      )
      .where(
        and(
          eq(embeddingIntents.ownerId, ownerId),
          eq(embeddingIntents.id, intentId),
          isNull(materials.deletedAt),
        ),
      )
      // 자료 수정·삭제와 동일한 행을 잠가 검사 뒤 current가 바뀌는 틈을 막는다.
      .for('update', { of: materials });

    return intent ?? null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async reusableChunks(ownerId: string, materialId: string, revisionId: string, text: string) {
    return this.transactions.tx
      .select({ id: materialChunks.id })
      .from(materialChunks)
      .where(
        and(
          eq(materialChunks.ownerId, ownerId),
          eq(materialChunks.materialId, materialId),
          ne(materialChunks.revisionId, revisionId),
          eq(materialChunks.text, text),
        ),
      )
      .orderBy(desc(materialChunks.id))
      .limit(100);
  }

  @Transactional('worker', Propagation.Mandatory)
  async chunks(ownerId: string, materialId: string, revisionId: string) {
    return this.transactions.tx
      .select({ id: materialChunks.id, text: materialChunks.text })
      .from(materialChunks)
      .where(
        and(
          eq(materialChunks.ownerId, ownerId),
          eq(materialChunks.materialId, materialId),
          eq(materialChunks.revisionId, revisionId),
        ),
      )
      .orderBy(asc(materialChunks.ordinal));
  }
}
