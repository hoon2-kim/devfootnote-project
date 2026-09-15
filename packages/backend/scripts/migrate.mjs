// 검토된 migration 파일만 명시적으로 적용하는 단일 실행기다(ADR-0003).
// drizzle-kit CLI 대신 drizzle-orm의 programmatic migrator를 사용한다. journal·hash 형식과
// 적용 대상은 `drizzle-kit generate` 결과와 동일하며, 운영 이미지에 devDependency를 요구하지 않는다.
// 같은 세션에서 advisory lock을 잡은 뒤 적용하므로 이 실행기의 동시 실행은 거부된다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const LOCK_KEY = 731830;
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/infrastructure/database/migrations');

// message에는 Drizzle의 SQL·parameter가 포함된다. 원본 값은 출력하지 않고 알려진 code만 분류한다.
const ERROR_CATEGORIES = new Map([
  ['28P01', 'AUTHENTICATION_FAILED'],
  ['28000', 'AUTHENTICATION_FAILED'],
  ['42501', 'PERMISSION_DENIED'],
  ['55P03', 'LOCK_TIMEOUT'],
  ['57014', 'QUERY_CANCELLED'],
  ['ECONNREFUSED', 'CONNECTION_UNAVAILABLE'],
  ['ETIMEDOUT', 'CONNECTION_UNAVAILABLE'],
  ['ENOTFOUND', 'CONNECTION_UNAVAILABLE'],
]);

function describe(error) {
  // Drizzle가 감싼 오류도 분류하되 circular/깊은 cause를 무한히 탐색하지 않는다.
  for (let depth = 0; depth < 3 && error instanceof Error; depth++, error = error.cause) {
    const category = ERROR_CATEGORIES.get(error.code);
    if (category) return category;
  }
  return 'MIGRATION_ERROR';
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL을 명시한 뒤 검토된 migration을 적용하세요.');
  process.exit(1);
}

// 전체 상한은 질의 timeout 후 rollback/end까지 응답하지 않는 연결도 종료한다.
// 종료 시 미확인 결과를 성공이나 rollback 완료로 단정하지 않으며 자동 재시도하지 않는다.
const deadline = setTimeout(() => {
  console.error('Migration 실행 시간 상한을 초과했습니다 (EXECUTION_TIMEOUT). DB 상태와 적용 기록을 확인하세요.');
  process.exit(1);
}, 60000);

let client;
try {
  // URL 파싱 오류도 아래의 정제된 실패 경로로 보낸다.
  client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    lock_timeout: 2000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  client.on('error', () => {
    console.error('Migration 연결이 끊겼습니다 (CONNECTION_UNAVAILABLE). DB 상태와 적용 기록을 확인하세요.');
    process.exit(1);
  });
  await client.connect();
  const lock = await client.query('select pg_try_advisory_lock($1) as acquired', [LOCK_KEY]);
  if (!lock.rows[0]?.acquired) {
    console.error('다른 migration 실행이 같은 DB를 잠그고 있습니다. 완료를 기다린 뒤 다시 실행하세요.');
    process.exitCode = 1;
  } else {
    await migrate(drizzle(client), { migrationsFolder });
    console.log('검토된 migration 적용 완료');
  }
} catch (error) {
  console.error(`Migration 적용에 실패했습니다 (${describe(error)}). 대상 DB와 검토된 SQL을 확인하세요.`);
  process.exitCode = 1;
} finally {
  try { await client?.end(); }
  catch {
    console.error('Migration 연결 종료에 실패했습니다 (CONNECTION_CLOSE_FAILED). DB 상태를 확인하세요.');
    process.exitCode = 1;
  } finally { clearTimeout(deadline); }
}
