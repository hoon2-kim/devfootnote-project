import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DrizzleMaterialsQueryRepository } from '../../apps/api/dist/modules/materials/infrastructure/drizzle-materials-query.repository.js';

const image =
  'pgvector/pgvector:0.8.6-pg17-trixie@sha256:724a4041afdb1750446e3f6b5cfa8f3b0ac5a2cf538ddfa6bfee4f94c2fa85c6';
const ownerId = '00000000-0000-4000-8000-000000000001';
const container = await new PostgreSqlContainer(image).withDatabase('search_benchmark').start();
const pool = new Pool({ connectionString: container.getConnectionUri(), max: 5 });
let captured;
const db = drizzle(pool, {
  logger: {
    logQuery(query, params) {
      captured = { query, params };
    },
  },
});
const repository = new DrizzleMaterialsQueryRepository(db);
const results = [];

// 운영·개발 연결을 받지 않는다. 아래 DDL/fixture는 이 실행의 컨테이너에서만 수행한다.
async function seed(size) {
  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query(
      'truncate accounts, auth_refresh_tokens, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_attempts, indexing_embedding_works, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations',
    );
    await client.query(
      `insert into accounts (id, issuer, subject) values
      ($1, 'benchmark', 'owner'), ('00000000-0000-4000-8000-000000000002', 'benchmark', 'other')`,
      [ownerId],
    );
    await client.query(
      `create temporary table corpus on commit drop as
      select n, md5('material-' || n)::uuid as id, md5('current-' || n)::uuid as revision_id,
        md5('history-' || n)::uuid as history_id,
        case when n % 5 = 0 then '00000000-0000-4000-8000-000000000002'::uuid else $1::uuid end as owner_id,
        repeat(md5(n::text) || ' 개발 메모 ', 8 + n % 16)
          || case when n % 200 = 2 then ' bullmq 재시도 인증 큐 백오프 ' else '' end
          || case when n % 2 = 0 then ' 공통기록 ' else '' end as body
      from generate_series(1, $2::int) n`,
      [ownerId, size],
    );
    await client.query(`insert into materials (id, owner_id, current_revision_id, updated_at, deleted_at)
      select id, owner_id, revision_id, '2026-01-01'::timestamptz + n * interval '1 second',
        case when n % 20 = 19 then '2026-01-02'::timestamptz end from corpus`);
    await client.query(`insert into material_revisions (id, owner_id, material_id, revision, body, content_fingerprint)
      select revision_id, owner_id, id, 2, body, md5(body) from corpus
      union all select history_id, owner_id, id, 1, '과거전용 oldrevision', md5('history') from corpus`);
    await client.query(`insert into material_keywords (revision_id, owner_id, material_id, normalized_text)
      select id, owner_id, material_id, lower(body) from material_revisions`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');

    throw error;
  } finally {
    client.release();
  }

  await pool.query('vacuum analyze materials');
  await pool.query('vacuum analyze material_revisions');
  await pool.query('vacuum analyze material_keywords');
}

function percentile(samples, fraction) {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
}

async function measure(size, query, page, concurrency) {
  // 한 번 예열한 실제 Repository SQL을 그대로 EXPLAIN한다. 별도 검색 SQL을 복제하지 않는다.
  const first = await repository.keywordCandidates(ownerId, query, page, 20);
  const statement = captured;

  assert.ok(statement);

  // 같은 JOIN·owner/current/deleted·점수·pagination에서 vector 표현만 바꿔 결과 순서를 대조한다.
  // 비교 쿼리는 표본 시간 밖에서 실행하며 제품 쿼리를 따로 복제하지 않는다.
  const legacyQuery = statement.query.replaceAll(
    '"material_keywords"."search_vector"',
    'to_tsvector(\'simple\', "material_keywords"."normalized_text")',
  );

  assert.notEqual(legacyQuery, statement.query);
  const current = await pool.query(statement.query, statement.params);
  const legacy = await pool.query(legacyQuery, statement.params);

  assert.deepEqual(current.rows, legacy.rows);

  if (query === '과거전용') {
    assert.deepEqual(first, { items: [], hasNext: false });
  } else {
    assert.ok(first.items.length > 0, '측정 페이지에 실제 결과가 있어야 한다');
  }

  const samples = [];

  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const started = performance.now();

        await repository.keywordCandidates(ownerId, query, page, 20);
        samples.push(performance.now() - started);
      }),
    );
  }

  const plan = await pool.query(
    `explain (analyze, buffers, format json) ${statement.query}`,
    statement.params,
  );
  const result = {
    size,
    query,
    page,
    concurrency,
    legacyExpressionEquivalent: true,
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    samplesMs: samples,
    plan: plan.rows[0]['QUERY PLAN'][0],
  };

  results.push(result);
  console.log(
    JSON.stringify({
      size,
      query,
      page,
      concurrency,
      p50Ms: result.p50Ms.toFixed(2),
      p95Ms: result.p95Ms.toFixed(2),
    }),
  );
}

try {
  await migrate(db, { migrationsFolder: 'packages/db/migrations' });
  const settings = await pool.query(`select name, setting, unit from pg_settings where name in
    ('server_version', 'shared_buffers', 'work_mem', 'effective_cache_size', 'random_page_cost', 'max_parallel_workers_per_gather')`);
  const docker = JSON.parse(
    execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8' }),
  );
  const limits = JSON.parse(
    execFileSync('docker', ['inspect', container.getId(), '--format', '{{json .HostConfig}}'], {
      encoding: 'utf8',
    }),
  );

  for (const size of [1000, 10000, 20000]) {
    await seed(size);

    for (const query of [
      'bullmq',
      '재시도',
      '인증',
      '큐',
      'bullmq 백오프',
      '공통기록',
      '과거전용',
    ]) {
      await measure(size, query, 1, 1);
    }

    await measure(size, '공통기록', Math.floor((size * 0.4) / 20), 1);
    await measure(size, '인증', 1, 4);
  }

  const indexes = await pool.query(
    "select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('materials', 'material_keywords', 'material_revisions') order by tablename, indexname",
  );

  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/keyword-search.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        image,
        host: {
          os: os.platform(),
          release: os.release(),
          arch: os.arch(),
          cpu: os.cpus()[0]?.model,
          cpus: os.cpus().length,
          memory: os.totalmem(),
        },
        docker: {
          version: docker.ServerVersion,
          cpus: docker.NCPU,
          memory: docker.MemTotal,
          containerMemory: limits.Memory,
          containerNanoCpus: limits.NanoCpus,
        },
        settings: settings.rows,
        indexes: indexes.rows,
        poolMax: 5,
        cache: 'warm; one warmup per case; no cold-cache claim',
        fixture: {
          seed: 'generate_series/MD5 v1',
          materials: '1k/10k/20k; 80% target owner; 5% tombstoned',
          revisions: 'two per material (current + historical); no chunks/AI',
          rare: '0.5% current rows',
          frequent: '50% current rows',
          normalizedCharacters: 'approximately 300–950',
        },
        scope:
          'Repository SQL including joins, owner/current/deleted predicates, ranking and pagination; excludes HTTP/snippet/network clients; synthetic, not production SLO',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
  await container.stop();
}
