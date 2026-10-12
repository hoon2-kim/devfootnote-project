import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { EmbeddingClaimConsumer } from './embedding-claim.consumer.js';
import { EmbeddingWorkRepository } from './embedding-work.repository.js';
import { MaterialsModule } from '../materials/index.js';
import { UsageRetentionModule } from '../usage-retention/index.js';
import { EmbeddingExecutionService } from './embedding-execution.service.js';
import { EmbeddingRepairService } from './embedding-repair.service.js';
import { EmbeddingProcessorService } from './embedding-processor.service.js';
import { GeminiEmbedding } from '@devfootnote/ai';
import { ConfigService } from '@nestjs/config';
import { EmbeddingLifecycleService } from './embedding-lifecycle.service.js';

@Module({
  imports: [DatabaseModule, MaterialsModule, UsageRetentionModule],
  providers: [
    EmbeddingWorkRepository,
    EmbeddingExecutionService,
    EmbeddingRepairService,
    EmbeddingLifecycleService,
    EmbeddingClaimConsumer,
    EmbeddingProcessorService,
    {
      provide: GeminiEmbedding,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new GeminiEmbedding(config.get<string>('geminiApiKey') ?? ''),
    },
  ],
})
export class IndexingModule {}
