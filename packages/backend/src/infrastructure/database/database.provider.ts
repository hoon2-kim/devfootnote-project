import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { logger } from '../observability/logging.js';

export const DATABASE = Symbol('DATABASE');
export const POSTGRES_POOL = Symbol('POSTGRES_POOL');
export type Database = ReturnType<typeof drizzle>;

export function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL 설정이 필요합니다.');
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    statement_timeout: 3000,
    query_timeout: 4000,
    lock_timeout: 1000,
    application_name: 'devfootnote',
  });
  // idle 연결 오류는 처리하되 DB 오류 객체의 SQL·credential을 로그에 넘기지 않는다.
  pool.on('error', () => logger.error('PostgreSQL idle 연결 오류'));
  return pool;
}

export const databaseProviders = [
  { provide: POSTGRES_POOL, useFactory: createPool },
  { provide: DATABASE, inject: [POSTGRES_POOL], useFactory: (pool: Pool) => drizzle(pool, { logger: false }) },
];
