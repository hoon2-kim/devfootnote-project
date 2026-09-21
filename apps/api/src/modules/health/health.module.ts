import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [DatabaseModule, TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
