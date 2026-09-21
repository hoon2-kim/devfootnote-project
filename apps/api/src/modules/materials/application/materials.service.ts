import { Inject, Injectable } from '@nestjs/common';
import type { PageResult } from '../../../common/pagination/page-result.js';
import { mutationFingerprint, prepareMaterial } from '../domain/material-content.js';
import { MATERIALS_REPOSITORY, type MaterialsRepository } from './ports/materials.repository.js';
import type {
  CreateMaterialInput,
  DeleteMaterialInput,
  MaterialDetail,
  MaterialMutationResult,
  MaterialPage,
  MaterialSearchCandidate,
  UpdateMaterialInput,
} from './materials.types.js';

/**
 * 자료의 입력 정규화·요청 식별을 준비하는 application 진입점.
 * HTTP 처리는 Controller, 트랜잭션·receipt 경쟁 처리는 저장 포트 구현체에 맡긴다.
 */
@Injectable()
export class MaterialsService {
  constructor(@Inject(MATERIALS_REPOSITORY) private readonly repository: MaterialsRepository) {}

  async create(ownerId: string, input: CreateMaterialInput): Promise<MaterialMutationResult> {
    const prepared = prepareMaterial(input);

    return this.repository.create({ ownerId, idempotencyKey: input.idempotencyKey, prepared });
  }

  async list(ownerId: string, page: number, pageSize: number): Promise<MaterialPage> {
    const result = await this.repository.list(ownerId, page, pageSize);

    return { ...result, page };
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
    return this.repository.keywordCandidates(ownerId, query, page, pageSize);
  }

  read(ownerId: string, id: string): Promise<MaterialDetail> {
    return this.repository.read(ownerId, id);
  }
}
