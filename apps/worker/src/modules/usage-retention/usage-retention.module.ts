import { Module } from '@nestjs/common';
import { UsageRepository } from './usage.repository.js';
import { WorkerUsageService } from './usage.service.js';
import { AnswerUsageService } from './answer-usage.service.js';
import { AnswerUsageRepository } from './answer-usage.repository.js';

@Module({
  providers: [WorkerUsageService, UsageRepository, AnswerUsageService, AnswerUsageRepository],
  exports: [WorkerUsageService, AnswerUsageService],
})
export class UsageRetentionModule {}
