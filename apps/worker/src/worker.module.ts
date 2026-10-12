import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment.js';
import { IndexingModule } from './modules/indexing/index.js';
import { TransactionsModule } from './infrastructure/database/transactions.module.js';
import { AnswersModule } from './modules/answers/index.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => validateEnvironment(process.env)],
    }),
    TransactionsModule,
    IndexingModule,
    AnswersModule,
  ],
})
export class WorkerModule {}
