import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { TransactionHost, Transactional, Propagation } from '@nestjs-cls/transactional';
import type { PostgresTransactionAdapter } from '../../../infrastructure/database/transactions.module.js';
import { DATABASE, type Database } from '../../../infrastructure/database/database.provider.js';
import {
  embeddingIntents,
  materialChunks,
  materialKeywords,
  materialReceipts,
  materialRevisions,
  materials,
} from '@devfootnote/db/schema/materials';
import {
  type MaterialMutationResult,
  type EmbeddingTarget,
} from '../application/materials.types.js';
import { MaterialsError } from '../domain/materials.error.js';
import type { PreparedMaterial } from '../domain/material.types.js';
import {
  type CreateMaterialWrite,
  type UpdateMaterialWrite,
  type DeleteMaterialWrite,
  type MaterialsRepository,
} from '../application/ports/materials.repository.js';
import { withMaterialsErrorBoundary } from './materials-persistence-error.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

class ReceiptRace extends Error {}

/**
 * 자료 저장 포트의 PostgreSQL 구현. revision·파생 데이터·current pointer·receipt를
 * 하나의 tx로 확정하므로 테이블별 쓰기를 독립 트랜잭션으로 분리하지 않는다.
 */
@Injectable()
export class DrizzleMaterialsRepository implements MaterialsRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  private embeddingIntentQuery() {
    return this.transactions.tx
      .select({
        materialId: materials.id,
        revisionId: materials.currentRevisionId,
        intentId: embeddingIntents.id,
        title: sql<string | null>`(select ${materialRevisions.title} from ${materialRevisions}
          where ${materialRevisions.ownerId} = ${materials.ownerId}
            and ${materialRevisions.id} = ${materials.currentRevisionId})`,
        chunkCount: sql<number>`(select count(*)::int from ${materialChunks}
        where ${materialChunks.ownerId} = ${materials.ownerId}
          and ${materialChunks.revisionId} = ${materials.currentRevisionId})`,
      })
      .from(materials)
      .innerJoin(
        embeddingIntents,
        and(
          eq(embeddingIntents.ownerId, materials.ownerId),
          eq(embeddingIntents.materialId, materials.id),
          eq(embeddingIntents.revisionId, materials.currentRevisionId),
        ),
      )
      .$dynamic();
  }

  async currentEmbeddingIntents(ownerId: string, afterId: string | undefined, limit: number) {
    return this.embeddingIntentQuery()
      .where(
        and(
          eq(materials.ownerId, ownerId),
          isNull(materials.deletedAt),
          afterId ? gt(materials.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(materials.id))
      .limit(limit);
  }

  @Transactional(Propagation.Mandatory)
  async lockAnswerEvidence(ownerId: string, targets: EmbeddingTarget[]) {
    const locked = await this.lockEmbeddingIntents(ownerId, targets);

    if (
      locked.length !== targets.length ||
      locked.some(
        (row) =>
          !targets.some(
            (target) =>
              target.materialId === row.materialId && target.revisionId === row.revisionId,
          ),
      )
    ) {
      throw new MaterialsError('revision_conflict');
    }

    return this.transactions.tx
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
          inArray(
            materialChunks.revisionId,
            targets.map((target) => target.revisionId),
          ),
        ),
      )
      .orderBy(asc(materialChunks.materialId), asc(materialChunks.ordinal));
  }

  @Transactional(Propagation.Mandatory)
  async lockEmbeddingIntents(ownerId: string, targets: EmbeddingTarget[]) {
    // 수정·삭제와 같은 material 행을 잠근다. intent만 잠그면 current revision이 바뀔 수 있다.
    return this.embeddingIntentQuery()
      .where(
        and(
          eq(materials.ownerId, ownerId),
          isNull(materials.deletedAt),
          inArray(
            materials.id,
            targets.map((target) => target.materialId),
          ),
        ),
      )
      .orderBy(asc(materials.id))
      .for('update', { of: materials });
  }

  async create({ ownerId, idempotencyKey: key, prepared }: CreateMaterialWrite) {
    return this.writeWithReceipt(ownerId, key, prepared.fingerprint, () =>
      this.db.transaction(async (tx) => {
        const [receipt] = await tx
          .select()
          .from(materialReceipts)
          .where(
            and(eq(materialReceipts.ownerId, ownerId), eq(materialReceipts.idempotencyKey, key)),
          );

        if (receipt) {
          if (receipt.fingerprint !== prepared.fingerprint) {
            throw new MaterialsError('conflict');
          }

          return { id: receipt.materialId, revisionId: receipt.revisionId };
        }

        const id = randomUUID();
        const revisionId = randomUUID();

        await tx.insert(materials).values({ id, ownerId, currentRevisionId: revisionId });
        await this.insertRevision(tx, ownerId, id, revisionId, 1, prepared);
        await this.insertReceipt(tx, ownerId, key, prepared.fingerprint, id, revisionId);

        return { id, revisionId };
      }),
    );
  }

  async update(input: UpdateMaterialWrite) {
    const { ownerId, materialId: id, prepared, fingerprint } = input;

    return this.writeWithReceipt(ownerId, input.idempotencyKey, fingerprint, () =>
      this.db.transaction(async (tx) => {
        const replay = await this.findReceipt(tx, ownerId, input.idempotencyKey, fingerprint);

        if (replay) {
          return replay;
        }

        const [current] = await tx
          .select()
          .from(materials)
          .where(and(eq(materials.ownerId, ownerId), eq(materials.id, id)))
          .for('update', { of: materials });
        // 같은 자료의 선행 요청이 잠금을 놓으며 receipt를 확정했을 수 있다.
        const committed = await this.findReceipt(tx, ownerId, input.idempotencyKey, fingerprint);

        if (committed) {
          return committed;
        }

        if (!current || current.deletedAt) {
          throw new MaterialsError('not_found');
        }

        if (current.currentRevisionId !== input.expectedRevisionId) {
          throw new MaterialsError('revision_conflict');
        }

        const [previous] = await tx
          .select({
            revision: materialRevisions.revision,
            contentFingerprint: materialRevisions.contentFingerprint,
          })
          .from(materialRevisions)
          .where(
            and(
              eq(materialRevisions.ownerId, ownerId),
              eq(materialRevisions.materialId, id),
              eq(materialRevisions.id, input.expectedRevisionId),
            ),
          );

        if (!previous) {
          throw new Error('현재 원문 버전이 없습니다.');
        }

        // 잠금·기대 버전 검증 뒤에만 변경 없음을 판정한다. 자료의 수정 시각도 유지하고,
        // receipt는 남겨 이후 버전이 바뀌어도 같은 요청의 재전송 결과를 보존한다.
        if (previous.contentFingerprint === prepared.fingerprint) {
          await this.insertReceipt(
            tx,
            ownerId,
            input.idempotencyKey,
            fingerprint,
            id,
            current.currentRevisionId,
          );

          return { id, revisionId: current.currentRevisionId };
        }

        const revisionId = randomUUID();

        await this.insertRevision(tx, ownerId, id, revisionId, previous.revision + 1, prepared);
        const [changed] = await tx
          .update(materials)
          .set({ currentRevisionId: revisionId, updatedAt: sql`now()` })
          .where(
            and(
              eq(materials.ownerId, ownerId),
              eq(materials.id, id),
              eq(materials.currentRevisionId, input.expectedRevisionId),
              isNull(materials.deletedAt),
            ),
          )
          .returning({ id: materials.id });

        if (!changed) {
          throw new MaterialsError('revision_conflict');
        }

        await this.insertReceipt(tx, ownerId, input.idempotencyKey, fingerprint, id, revisionId);

        return { id, revisionId };
      }),
    );
  }

  async delete(input: DeleteMaterialWrite) {
    const { ownerId, materialId: id, fingerprint } = input;

    return this.writeWithReceipt(ownerId, input.idempotencyKey, fingerprint, () =>
      this.db.transaction(async (tx) => {
        const replay = await this.findReceipt(tx, ownerId, input.idempotencyKey, fingerprint);

        if (replay) {
          return replay;
        }

        const [current] = await tx
          .select()
          .from(materials)
          .where(and(eq(materials.ownerId, ownerId), eq(materials.id, id)))
          .for('update');
        const committed = await this.findReceipt(tx, ownerId, input.idempotencyKey, fingerprint);

        if (committed) {
          return committed;
        }

        if (!current || current.deletedAt) {
          throw new MaterialsError('not_found');
        }

        if (current.currentRevisionId !== input.expectedRevisionId) {
          throw new MaterialsError('revision_conflict');
        }

        const [changed] = await tx
          .update(materials)
          .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
          .where(
            and(
              eq(materials.ownerId, ownerId),
              eq(materials.id, id),
              eq(materials.currentRevisionId, input.expectedRevisionId),
              isNull(materials.deletedAt),
            ),
          )
          .returning({ id: materials.id });

        if (!changed) {
          throw new MaterialsError('revision_conflict');
        }

        await this.insertReceipt(
          tx,
          ownerId,
          input.idempotencyKey,
          fingerprint,
          id,
          current.currentRevisionId,
        );

        return { id, revisionId: current.currentRevisionId };
      }),
    );
  }

  private async findReceipt(tx: Transaction, ownerId: string, key: string, fingerprint: string) {
    const [receipt] = await tx
      .select()
      .from(materialReceipts)
      .where(and(eq(materialReceipts.ownerId, ownerId), eq(materialReceipts.idempotencyKey, key)));

    if (!receipt) {
      return undefined;
    }

    if (receipt.fingerprint !== fingerprint) {
      throw new MaterialsError('conflict');
    }

    return { id: receipt.materialId, revisionId: receipt.revisionId };
  }

  private async insertReceipt(
    tx: Transaction,
    ownerId: string,
    key: string,
    fingerprint: string,
    materialId: string,
    revisionId: string,
  ) {
    const [created] = await tx
      .insert(materialReceipts)
      .values({ ownerId, idempotencyKey: key, fingerprint, materialId, revisionId })
      .onConflictDoNothing({ target: [materialReceipts.ownerId, materialReceipts.idempotencyKey] })
      .returning();

    if (!created) {
      // 이미 기록한 revision·chunk까지 되돌린 뒤 승자의 receipt를 읽어야 한다.
      throw new ReceiptRace();
    }
  }

  private async insertRevision(
    tx: Transaction,
    ownerId: string,
    materialId: string,
    revisionId: string,
    revision: number,
    prepared: PreparedMaterial,
  ) {
    await tx.insert(materialRevisions).values({
      id: revisionId,
      ownerId,
      materialId,
      revision,
      ...prepared.content,
      contentFingerprint: prepared.fingerprint,
    });
    await tx.insert(materialChunks).values(
      prepared.chunks.map((chunk) => ({
        ...chunk,
        id: randomUUID(),
        ownerId,
        materialId,
        revisionId,
      })),
    );
    await tx
      .insert(materialKeywords)
      .values({ ownerId, materialId, revisionId, normalizedText: prepared.normalizedText });
    // 향후 색인의 대상만 남긴다. 저장 성공을 큐 enqueue나 AI 호출에 의존시키지 않는다.
    await tx.insert(embeddingIntents).values({
      id: randomUUID(),
      ownerId,
      materialId,
      revisionId,
      contentFingerprint: prepared.fingerprint,
    });
  }

  private writeWithReceipt(
    ownerId: string,
    key: string,
    fingerprint: string,
    operation: () => Promise<MaterialMutationResult>,
  ): Promise<MaterialMutationResult> {
    return withMaterialsErrorBoundary(async () => {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof ReceiptRace)) {
          throw error;
        }
      }

      // UNIQUE 충돌 검사는 선행 transaction의 확정을 기다린다. 패자의 rollback이
      // 끝난 뒤 새 Read Committed 조회로 승자의 receipt를 읽으며 재시도하지 않는다.
      const [receipt] = await this.db
        .select()
        .from(materialReceipts)
        .where(
          and(eq(materialReceipts.ownerId, ownerId), eq(materialReceipts.idempotencyKey, key)),
        );

      if (!receipt) {
        throw new Error('저장 결과를 확인하지 못했습니다.');
      }

      if (receipt.fingerprint !== fingerprint) {
        throw new MaterialsError('conflict');
      }

      return { id: receipt.materialId, revisionId: receipt.revisionId };
    });
  }
}
