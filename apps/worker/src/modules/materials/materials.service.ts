import { Injectable } from '@nestjs/common';
import { MaterialsRepository } from './materials.repository.js';

export interface CurrentEmbeddingIntent {
  materialId: string;
  revisionId: string;
  contentFingerprint: string;
}

@Injectable()
export class MaterialsService {
  constructor(private readonly repository: MaterialsRepository) {}

  lockAnswerEvidence(
    ownerId: string,
    targets: readonly { materialId: string; revisionId: string }[],
  ) {
    return this.repository.lockAnswerEvidence(ownerId, targets);
  }

  currentIntents(ownerId: string, afterId: string | null, enabledAt: string | null, limit: number) {
    return this.repository.currentIntents(ownerId, afterId, enabledAt, limit);
  }

  lockReusableChunk(ownerId: string, materialId: string, chunkId: string): Promise<boolean> {
    return this.repository.lockReusableChunk(ownerId, materialId, chunkId);
  }

  lockCurrentIntent(ownerId: string, intentId: string): Promise<CurrentEmbeddingIntent | null> {
    return this.repository.lockCurrentIntent(ownerId, intentId);
  }

  chunks(
    ownerId: string,
    materialId: string,
    revisionId: string,
  ): Promise<{ id: string; text: string }[]> {
    return this.repository.chunks(ownerId, materialId, revisionId);
  }

  reusableChunks(ownerId: string, materialId: string, revisionId: string, text: string) {
    return this.repository.reusableChunks(ownerId, materialId, revisionId, text);
  }
}
