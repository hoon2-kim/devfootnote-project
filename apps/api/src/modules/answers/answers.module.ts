import { Module } from '@nestjs/common';
import { MaterialsModule } from '../materials/index.js';
import { SearchModule } from '../search/index.js';
import { UsageRetentionModule } from '../usage-retention/index.js';
import { AnswersController } from './answers.controller.js';
import { AnswersService } from './answers.service.js';
import { AnswersRepository } from './answers.repository.js';

@Module({
  imports: [MaterialsModule, SearchModule, UsageRetentionModule],
  controllers: [AnswersController],
  providers: [AnswersService, AnswersRepository],
  exports: [AnswersService],
})
export class AnswersModule {}
