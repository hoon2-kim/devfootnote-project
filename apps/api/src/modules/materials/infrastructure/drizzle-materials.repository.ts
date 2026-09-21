import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PageResult } from '../../../common/pagination/page-result.js';
import { isDatabaseUnavailable } from '../../../infrastructure/database/database-error.js';
import { DATABASE, type Database } from '../../../infrastructure/database/database.provider.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  embeddingIntents,
  materialChunks,
  materialKeywords,
  materialReceipts,
  materialRevisions,
  materials,
} from './materials.schema.js';
import {
  type MaterialDetail,
  type MaterialSummary,
  type MaterialMutationResult,
} from '../application/materials.types.js';
import { MaterialsError } from '../domain/materials.error.js';
import type { PreparedMaterial } from '../domain/material.types.js';
import {
  type CreateMaterialWrite,
  type UpdateMaterialWrite,
  type DeleteMaterialWrite,
  type MaterialsRepository,
} from '../application/ports/materials.repository.js';

const summaryColumns = {
  id: materials.id,
  revisionId: materialRevisions.id,
  revision: materialRevisions.revision,
  title: materialRevisions.title,
  createdAt: materials.createdAt,
  updatedAt: materials.updatedAt,
};
const currentRevision = and(
  eq(materials.ownerId, materialRevisions.ownerId),
  eq(materials.id, materialRevisions.materialId),
  eq(materials.currentRevisionId, materialRevisions.id),
);

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

class ReceiptRace extends Error {}

/**
 * 자료 저장 포트의 PostgreSQL 구현. revision·파생 데이터·current pointer·receipt를
 * 하나의 tx로 확정하므로 테이블별 쓰기를 독립 트랜잭션으로 분리하지 않는다.
 */
@Injectable()
export class DrizzleMaterialsRepository implements MaterialsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
    return this.persist(async () => {
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

  async list(
    ownerId: string,
    page: number,
    pageSize: number,
  ): Promise<PageResult<MaterialSummary>> {
    return this.persist(async () => {
      const rows = await this.db
        .select(summaryColumns)
        .from(materials)
        .innerJoin(materialRevisions, currentRevision)
        .where(and(eq(materials.ownerId, ownerId), isNull(materials.deletedAt)))
        .orderBy(desc(materials.updatedAt), desc(materials.id))
        .limit(pageSize + 1)
        .offset((page - 1) * pageSize);

      return { items: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
    });
  }

  async read(ownerId: string, id: string): Promise<MaterialDetail> {
    return this.persist(async () => {
      const [material] = await this.db
        .select({
          ...summaryColumns,
          body: materialRevisions.body,
          note: materialRevisions.note,
          context: materialRevisions.context,
          sourceUrl: materialRevisions.sourceUrl,
        })
        .from(materials)
        .innerJoin(materialRevisions, currentRevision)
        .where(
          and(eq(materials.ownerId, ownerId), eq(materials.id, id), isNull(materials.deletedAt)),
        );

      if (!material) {
        throw new MaterialsError('not_found');
      }

      return material;
    });
  }

  async keywordCandidates(ownerId: string, query: string, page: number, pageSize: number) {
    const tokens = query.split(/\s+/u);
    // %와 _도 검색어 자체로 취급한다. LIKE pattern도 반드시 parameter로 바인딩한다.
    const contains = (token: string) => `%${token.replace(/[\\%_]/g, '\\$&')}%`;
    // 저장된 vector를 사용해 스캔 중 본문을 매번 다시 토큰화하지 않는다.
    const vector = materialKeywords.searchVector;
    const tsquery = sql`plainto_tsquery('simple', ${query})`;
    const fullText = sql`${vector} @@ ${tsquery}`;
    // FTS가 놓치는 한글 부분 문자열도 찾는다. 모든 토큰 일치이며 짧은 질의도 제외하지 않는다.
    const substrings: SQL[] = tokens.map(
      (token) => sql`${materialKeywords.normalizedText} like ${contains(token)}`,
    );
    const score =
      sql<number>`ts_rank_cd(${vector}, ${tsquery}) + similarity(${materialKeywords.normalizedText}, ${query})`.mapWith(
        Number,
      );

    return this.persist(async () => {
      const rows = await this.db
        .select({
          ...summaryColumns,
          body: materialRevisions.body,
          note: materialRevisions.note,
          context: materialRevisions.context,
          sourceUrl: materialRevisions.sourceUrl,
        })
        .from(materials)
        .innerJoin(materialRevisions, currentRevision)
        .innerJoin(
          materialKeywords,
          and(
            eq(materialKeywords.ownerId, materials.ownerId),
            eq(materialKeywords.materialId, materials.id),
            eq(materialKeywords.revisionId, materials.currentRevisionId),
          ),
        )
        .where(
          and(
            eq(materials.ownerId, ownerId),
            isNull(materials.deletedAt),
            sql`(${fullText} or (${and(...substrings)}))`,
          ),
        )
        .orderBy(desc(score), desc(materials.updatedAt), desc(materials.id))
        .limit(pageSize + 1)
        .offset((page - 1) * pageSize);

      return { items: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
    });
  }

  private async persist<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MaterialsError) {
        throw error;
      }

      if (isDatabaseUnavailable(error)) {
        logger.error('자료 저장소에 일시적으로 접근할 수 없습니다.');

        throw new MaterialsError('unavailable');
      }

      logger.error('자료 저장소 작업에 실패했습니다.');

      throw new Error('자료 저장소 내부 오류');
    }
  }
}
