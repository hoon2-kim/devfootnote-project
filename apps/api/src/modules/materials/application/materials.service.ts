import { Inject, Injectable } from '@nestjs/common';
import type { PageResult } from '../../../common/pagination/page-result.js';
import { mutationFingerprint, prepareMaterial } from '../domain/material-content.js';
import { MaterialsError } from '../domain/materials.error.js';
import { MATERIALS_REPOSITORY, type MaterialsRepository } from './ports/materials.repository.js';
import {
  MATERIALS_QUERY_REPOSITORY,
  type MaterialsQueryRepository,
} from './ports/materials-query.repository.js';
import type {
  EmbeddingTarget,
  CreateMaterialInput,
  DeleteMaterialInput,
  MaterialDetail,
  MaterialMutationResult,
  MaterialPage,
  MaterialSearchCandidate,
  RankedMaterialReference,
  UpdateMaterialInput,
} from './materials.types.js';

/**
 * 자료의 입력 정규화·요청 식별을 준비하는 application 진입점.
 * HTTP 처리는 Controller, 트랜잭션·receipt 경쟁 처리는 저장 포트 구현체에 맡긴다.
 */
@Injectable()
export class MaterialsService {
  constructor(
    @Inject(MATERIALS_REPOSITORY) private readonly repository: MaterialsRepository,
    @Inject(MATERIALS_QUERY_REPOSITORY) private readonly queries: MaterialsQueryRepository,
  ) {}

  currentEmbeddingIntents(ownerId: string, afterId: string | undefined, limit: number) {
    return this.repository.currentEmbeddingIntents(ownerId, afterId, limit);
  }

  lockAnswerEvidence(ownerId: string, targets: EmbeddingTarget[]) {
    return this.repository.lockAnswerEvidence(ownerId, targets);
  }

  async lockCurrentEmbeddingIntents(ownerId: string, targets: EmbeddingTarget[]) {
    const rows = await this.repository.lockEmbeddingIntents(ownerId, targets);

    if (rows.length !== targets.length) {
      throw new MaterialsError('not_found');
    }

    if (
      rows.some(
        (row) =>
          !targets.some(
            (target) =>
              target.materialId === row.materialId && target.revisionId === row.revisionId,
          ),
      )
    ) {
      throw new MaterialsError('revision_conflict');
    }

    return rows;
  }

  async create(ownerId: string, input: CreateMaterialInput): Promise<MaterialMutationResult> {
    const prepared = prepareMaterial(input);

    return this.repository.create({ ownerId, idempotencyKey: input.idempotencyKey, prepared });
  }

  async list(ownerId: string, page: number, pageSize: number): Promise<MaterialPage> {
    const result = await this.queries.list(ownerId, page, pageSize);

    return { ...result, page, pageSize };
  }

  async update(
    ownerId: string,
    id: string,
    input: UpdateMaterialInput,
  ): Promise<MaterialMutationResult> {
    const prepared = prepareMaterial(input);
    const fingerprint = mutationFingerprint(
      'update',
      id,
      input.expectedRevisionId,
      prepared.fingerprint,
    );

    return this.repository.update({
      ownerId,
      materialId: id,
      idempotencyKey: input.idempotencyKey,
      expectedRevisionId: input.expectedRevisionId,
      prepared,
      fingerprint,
    });
  }

  async delete(
    ownerId: string,
    id: string,
    input: DeleteMaterialInput,
  ): Promise<MaterialMutationResult> {
    const fingerprint = mutationFingerprint('delete', id, input.expectedRevisionId);

    return this.repository.delete({ ownerId, materialId: id, ...input, fingerprint });
  }

  findKeywordCandidates(
    ownerId: string,
    query: string,
    page: number,
    pageSize: number,
  ): Promise<PageResult<MaterialSearchCandidate>> {
    return this.queries.keywordCandidates(ownerId, query, page, pageSize);
  }

  read(ownerId: string, id: string): Promise<MaterialDetail> {
    return this.queries.read(ownerId, id);
  }

  rankedCurrentCandidates(
    ownerId: string,
    references: readonly RankedMaterialReference[],
    limit: number,
  ) {
    return this.queries.rankedCurrentCandidates(ownerId, references, limit);
  }
}
