import { Module } from '@nestjs/common';
import { MaterialsRepository } from './materials.repository.js';
import { MaterialsService } from './materials.service.js';

@Module({ providers: [MaterialsService, MaterialsRepository], exports: [MaterialsService] })
export class MaterialsModule {}
