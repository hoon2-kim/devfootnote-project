import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { EmbeddingWorkRepository } from './embedding-work.repository.js';
import { EmbeddingDeliveryService } from './embedding-delivery.service.js';
import { MaterialsModule } from '../materials/index.js';
import { UsageRetentionModule } from '../usage-retention/index.js';
import { EmbeddingActivationService } from './embedding-activation.service.js';
import { EmbeddingActivationController } from './embedding-activation.controller.js';
import { EmbeddingQueryService } from './embedding-query.service.js';
import { EmbeddingQueryRepository } from './embedding-query.repository.js';

// producer만 등록한다. 모듈 import는 Redis 연결·consumer·timer를 시작하지 않는다.
@Module({
  imports: [DatabaseModule, MaterialsModule, UsageRetentionModule],
  controllers: [EmbeddingActivationController],
  providers: [
    EmbeddingWorkRepository,
    EmbeddingDeliveryService,
    EmbeddingActivationService,
    EmbeddingQueryService,
    EmbeddingQueryRepository,
  ],
  exports: [EmbeddingDeliveryService, EmbeddingActivationService, EmbeddingQueryService],
})
export class IndexingModule {}
