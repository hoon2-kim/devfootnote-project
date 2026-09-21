import { Module } from '@nestjs/common';
import { MaterialsModule } from '../materials/index.js';
import { SearchService } from './search.service.js';
import { SearchController } from './search.controller.js';

@Module({ imports: [MaterialsModule], controllers: [SearchController], providers: [SearchService] })
export class SearchModule {}
