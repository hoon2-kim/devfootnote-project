import { Module } from '@nestjs/common';
import { UsageService } from './usage.service.js';
import { UsageRepository } from './usage.repository.js';
import { AnswerUsageService } from './answer-usage.service.js';
import { AnswerUsageRepository } from './answer-usage.repository.js';

@Module({
  providers: [UsageService, UsageRepository, AnswerUsageService, AnswerUsageRepository],
  exports: [UsageService, AnswerUsageService],
})
export class UsageRetentionModule {}
