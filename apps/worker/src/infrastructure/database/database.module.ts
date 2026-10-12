import { createDatabase, createPool } from '@devfootnote/db';
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { logger } from '../logging/logger.js';

export const WORKER_DATABASE = Symbol('WORKER_DATABASE');
const WORKER_POOL = Symbol('WORKER_POOL');

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(WORKER_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Module({
  providers: [
    {
      provide: WORKER_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = createPool(config.getOrThrow<string>('databaseUrl'), 'devfootnote-worker');

        pool.on('error', () => logger.error('Worker PostgreSQL idle 연결 오류'));

        return pool;
      },
    },
    {
      provide: WORKER_DATABASE,
      inject: [WORKER_POOL],
      useFactory: (pool: Pool) => createDatabase(pool),
    },
    PoolLifecycle,
  ],
  exports: [WORKER_DATABASE],
})
export class DatabaseModule {}
