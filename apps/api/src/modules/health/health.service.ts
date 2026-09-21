import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../infrastructure/database/database.provider.js';
import { logger } from '../../infrastructure/logging/logger.js';

@Injectable()
export class HealthService {
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
