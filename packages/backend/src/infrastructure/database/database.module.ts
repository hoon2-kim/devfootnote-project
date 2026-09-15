import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE, POSTGRES_POOL, databaseProviders } from './database.provider.js';

@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Module({ providers: [...databaseProviders, PoolLifecycle], exports: [DATABASE] })
export class DatabaseModule {}
