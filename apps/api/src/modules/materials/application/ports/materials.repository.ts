import type { PreparedMaterial } from '../../domain/material.types.js';
import type {
  CurrentEmbeddingIntent,
  EmbeddingTarget,
  MaterialMutationResult,
  AnswerEvidenceChunk,
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
 * 활성화 시점의 current intent 조회·잠금은 같은 저장 경계에 유지한다.
 */
export interface MaterialsRepository {
  lockAnswerEvidence(ownerId: string, targets: EmbeddingTarget[]): Promise<AnswerEvidenceChunk[]>;
  currentEmbeddingIntents(
    ownerId: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<CurrentEmbeddingIntent[]>;
  lockEmbeddingIntents(
    ownerId: string,
    targets: EmbeddingTarget[],
  ): Promise<CurrentEmbeddingIntent[]>;
  create(input: CreateMaterialWrite): Promise<MaterialMutationResult>;
  update(input: UpdateMaterialWrite): Promise<MaterialMutationResult>;
  delete(input: DeleteMaterialWrite): Promise<MaterialMutationResult>;
}
