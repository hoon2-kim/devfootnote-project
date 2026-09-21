import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { MaterialsService } from './application/materials.service.js';
import { DrizzleMaterialsRepository } from './infrastructure/drizzle-materials.repository.js';
import { MATERIALS_REPOSITORY } from './application/ports/materials.repository.js';
import { MaterialsController } from './presentation/materials.controller.js';

// 저장 포트와 Drizzle 구현을 연결하는 모듈 조립 지점이다.
// 다른 기능에는 Service만 공개해 Repository·schema에 직접 접근하지 못하게 한다.
@Module({
  imports: [DatabaseModule],
  controllers: [MaterialsController],
  providers: [
    MaterialsService,
    { provide: MATERIALS_REPOSITORY, useClass: DrizzleMaterialsRepository },
  ],
  exports: [MaterialsService],
})
export class MaterialsModule {}
