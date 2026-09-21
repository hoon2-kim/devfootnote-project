import type { PageResult } from '../../../../common/pagination/page-result.js';
import type { PreparedMaterial } from '../../domain/material.types.js';
import type {
  MaterialDetail,
  MaterialMutationResult,
  MaterialSearchCandidate,
  MaterialSummary,
} from '../materials.types.js';

export const MATERIALS_REPOSITORY = Symbol('MATERIALS_REPOSITORY');

export interface CreateMaterialWrite {
  ownerId: string;
  idempotencyKey: string;
  prepared: PreparedMaterial;
}

export interface UpdateMaterialWrite extends CreateMaterialWrite {
  materialId: string;
  expectedRevisionId: string;
  fingerprint: string;
}

export interface DeleteMaterialWrite {
  ownerId: string;
  materialId: string;
  idempotencyKey: string;
  expectedRevisionId: string;
  fingerprint: string;
}

/**
 * application이 사용하는 자료 저장 계약. Drizzle 타입이나 tx를 호출자에게 노출하지 않는다.
 * 쓰기는 작업 전체를 commit하거나 rollback하고, 같은 요청의 재전송은 확정된 결과를 반환한다.
 * 페이지 결과에는 실제 항목만 담는다. hasNext 판정용 추가 행은 구현체 내부에서 제거한다.
 */
export interface MaterialsRepository {
  create(input: CreateMaterialWrite): Promise<MaterialMutationResult>;
  update(input: UpdateMaterialWrite): Promise<MaterialMutationResult>;
  delete(input: DeleteMaterialWrite): Promise<MaterialMutationResult>;
  list(ownerId: string, page: number, pageSize: number): Promise<PageResult<MaterialSummary>>;
  read(ownerId: string, id: string): Promise<MaterialDetail>;
  keywordCandidates(
    ownerId: string,
    query: string,
    page: number,
    pageSize: number,
  ): Promise<PageResult<MaterialSearchCandidate>>;
}
