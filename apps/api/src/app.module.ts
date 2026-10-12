import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/index.js';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment.js';
import { AuthModule } from './modules/auth/index.js';
import { MaterialsModule } from './modules/materials/index.js';
import { SearchModule } from './modules/search/index.js';
import { IndexingModule } from './modules/indexing/index.js';
import { TransactionsModule } from './infrastructure/database/transactions.module.js';
import { AnswersModule } from './modules/answers/index.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      cache: true,
      load: [() => validateEnvironment(process.env)],
    }),
    AuthModule,
    TransactionsModule,
    MaterialsModule,
    SearchModule,
    HealthModule,
    IndexingModule,
    AnswersModule,
  ],
})
export class AppModule {}
