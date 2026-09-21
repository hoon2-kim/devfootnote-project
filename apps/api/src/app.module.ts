import { Module } from '@nestjs/common';
import { HealthModule } from './modules/health/index.js';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment.js';
import { AuthModule } from './modules/auth/index.js';
import { MaterialsModule } from './modules/materials/index.js';
import { SearchModule } from './modules/search/index.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      cache: true,
      load: [() => validateEnvironment(process.env)],
    }),
    AuthModule,
    MaterialsModule,
    SearchModule,
    HealthModule,
  ],
})
export class AppModule {}
