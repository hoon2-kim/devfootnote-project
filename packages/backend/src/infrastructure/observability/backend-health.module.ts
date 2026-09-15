import { Inject, Injectable, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseModule } from '../database/database.module.js';
import { DATABASE, type Database } from '../database/database.provider.js';
import { logger } from './logging.js';

@Injectable()
export class BackendHealthService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async checkDatabase(): Promise<boolean> {
    try {
      await this.db.execute(sql`select 1`);
      return true;
    } catch {
      logger.warn('PostgreSQL 연결 확인 실패');
      return false;
    }
  }
}

@Module({ imports: [DatabaseModule], providers: [BackendHealthService], exports: [BackendHealthService] })
export class BackendHealthModule {}
