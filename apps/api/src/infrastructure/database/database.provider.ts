import { createDatabase, createPool as createDatabasePool } from '@devfootnote/db';
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { logger } from '../logging/logger.js';

export const DATABASE = Symbol('DATABASE');
export const POSTGRES_POOL = Symbol('POSTGRES_POOL');
export type { Database } from '@devfootnote/db';

export function createPool(config: ConfigService) {
  const pool = createDatabasePool(config.getOrThrow<string>('databaseUrl'), 'devfootnote');

  // idle 연결 오류는 처리하되 DB 오류 객체의 SQL·credential을 로그에 넘기지 않는다.
  pool.on('error', () => logger.error('PostgreSQL idle 연결 오류'));

  return pool;
}

export const databaseProviders: Provider[] = [
  { provide: POSTGRES_POOL, inject: [ConfigService], useFactory: createPool },
  {
    provide: DATABASE,
    inject: [POSTGRES_POOL],
    useFactory: (pool: Pool) => createDatabase(pool),
  },
];
