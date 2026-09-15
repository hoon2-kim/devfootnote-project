import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { BackendHealthModule } from '@devfootnote/backend';
import { HealthController } from './health/health.controller.js';

@Module({ imports: [BackendHealthModule, TerminusModule.forRoot({ logger: false })], controllers: [HealthController] })
export class AppModule {}
