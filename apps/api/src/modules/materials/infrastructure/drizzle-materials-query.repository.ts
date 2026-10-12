import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PostgresTransactionAdapter } from '../../../infrastructure/database/transactions.module.js';
import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { materialKeywords, materialRevisions, materials } from '@devfootnote/db/schema/materials';
import { DATABASE, type Database } from '../../../infrastructure/database/database.provider.js';
import type {
  MaterialDetail,
  MaterialPage,
  RankedMaterialReference,
} from '../application/materials.types.js';
import type { MaterialsQueryRepository } from '../application/ports/materials-query.repository.js';
import { MaterialsError } from '../domain/materials.error.js';
import { withMaterialsErrorBoundary } from './materials-persistence-error.js';

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

/** 현재 소유자·revision·미삭제 조건을 적용하는 화면 조회와 검색 projection이다. */
@Injectable()
export class DrizzleMaterialsQueryRepository implements MaterialsQueryRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly transactions?: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  async rankedCurrentCandidates(
    ownerId: string,
    references: readonly RankedMaterialReference[],
    limit: number,
  ) {
    if (references.length === 0) {
      return [];
    }

    // 벡터 후보에 먼저 LIMIT을 걸면 과거 revision이 현재 자료를 밀어낼 수 있다.
    // 자료 소유 경계에서 current·미삭제를 확인한 뒤에만 결과 수를 제한한다.
    const candidates = sql`jsonb_to_recordset(${JSON.stringify(references)}::jsonb)
      as candidate("materialId" uuid, "revisionId" uuid, score double precision)`;

    return withMaterialsErrorBoundary(() =>
      (this.transactions?.tx ?? this.db)
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
          candidates,
          and(
            sql`candidate."materialId" = ${materials.id}`,
            sql`candidate."revisionId" = ${materials.currentRevisionId}`,
          ),
        )
        .where(and(eq(materials.ownerId, ownerId), isNull(materials.deletedAt)))
        .orderBy(sql`candidate.score desc`, desc(materials.updatedAt), desc(materials.id))
        .limit(limit),
    );
  }

  async list(
    ownerId: string,
    page: number,
    pageSize: number,
  ): Promise<Omit<MaterialPage, 'page' | 'pageSize'>> {
    return withMaterialsErrorBoundary(async () => {
      const current = this.db.$with('current_materials').as(
        this.db
          .select({
            ...summaryColumns,
            revisionId: sql<string>`${materialRevisions.id}`.as('revision_id'),
          })
          .from(materials)
          .innerJoin(materialRevisions, currentRevision)
          .where(and(eq(materials.ownerId, ownerId), isNull(materials.deletedAt))),
      );
      const pageRows = this.db.$with('page_materials').as(
        this.db
          .select()
          .from(current)
          .orderBy(desc(current.updatedAt), desc(current.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
      );
      const total = this.db
        .$with('material_total')
        .as(this.db.select({ totalCount: count().as('total_count') }).from(current));
      // 한 SQL의 스냅샷으로 목록과 개수를 맞춘다. 빈 페이지도 LEFT JOIN으로 총개수를 반환한다.
      const rows = await this.db
        .with(current, pageRows, total)
        .select({
          totalCount: total.totalCount,
          item: {
            id: pageRows.id,
            revisionId: pageRows.revisionId,
            revision: pageRows.revision,
            title: pageRows.title,
            createdAt: pageRows.createdAt,
            updatedAt: pageRows.updatedAt,
          },
        })
        .from(total)
        .leftJoin(pageRows, sql`true`)
        .orderBy(desc(pageRows.updatedAt), desc(pageRows.id));
      const totalCount = rows[0]?.totalCount ?? 0;

      return {
        items: rows.flatMap((row) => (row.item ? [row.item] : [])),
        totalCount,
        hasNext: page * pageSize < totalCount,
      };
    });
  }

  async read(ownerId: string, id: string): Promise<MaterialDetail> {
    return withMaterialsErrorBoundary(async () => {
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

    return withMaterialsErrorBoundary(async () => {
      const rows = await (this.transactions?.tx ?? this.db)
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
}
