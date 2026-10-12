import { Module } from '@nestjs/common';
import { MaterialsModule } from '../materials/index.js';
import { SearchService } from './search.service.js';
import { SearchController } from './search.controller.js';
import { IndexingModule } from '../indexing/index.js';
import { UsageRetentionModule } from '../usage-retention/index.js';

@Module({
  imports: [MaterialsModule, IndexingModule, UsageRetentionModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
