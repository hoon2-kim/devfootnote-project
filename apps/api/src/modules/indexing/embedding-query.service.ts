import { Injectable } from '@nestjs/common';
import { MaterialsService } from '../materials/index.js';
import { EmbeddingQueryRepository } from './embedding-query.repository.js';

@Injectable()
export class EmbeddingQueryService {
  constructor(
    private readonly repository: EmbeddingQueryRepository,
    private readonly materials: MaterialsService,
  ) {}

  async ready(ownerId: string, fingerprint: string, epoch: number) {
    const references = await this.repository.published(ownerId, fingerprint, epoch);

    return (await this.materials.rankedCurrentCandidates(ownerId, references, 1)).length > 0;
  }

  publishedReferences(ownerId: string, fingerprint: string, epoch: number) {
    return this.repository.published(ownerId, fingerprint, epoch);
  }

  async candidates(
    ownerId: string,
    configFingerprint: string,
    consentEpoch: number,
    vector: number[],
    limit: number,
  ) {
    const ranked = await this.repository.rank(ownerId, configFingerprint, consentEpoch, vector);

    return this.materials.rankedCurrentCandidates(ownerId, ranked, limit);
  }
}
