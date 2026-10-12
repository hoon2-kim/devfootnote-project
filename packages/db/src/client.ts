import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

/** 풀은 프로세스별로 생성한다. 로그 정책과 종료 시점은 소비 앱이 소유한다. */
export function createPool(connectionString: string, applicationName: string) {
  return new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    statement_timeout: 3000,
    query_timeout: 4000,
    lock_timeout: 1000,
    application_name: applicationName,
  });
}

export function createDatabase(pool: Pool) {
  return drizzle(pool, { schema, logger: false });
}

export type Database = ReturnType<typeof createDatabase>;
