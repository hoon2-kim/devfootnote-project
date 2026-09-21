import 'reflect-metadata';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { AppModule } from '../apps/api/dist/app.module.js';
import { configureApp } from '../apps/api/dist/configure-app.js';
import type { Database } from '../apps/api/dist/infrastructure/database/database.provider.js';

// 앱이 읽는 CommonJS 모듈과 같은 인스턴스의 private token을 검증에만 사용한다.
const {
  POSTGRES_POOL,
  DATABASE,
}: typeof import('../apps/api/dist/infrastructure/database/database.provider.js') = createRequire(
  import.meta.url,
)('../apps/api/dist/infrastructure/database/database.provider.js');

const image =
  'pgvector/pgvector:0.8.6-pg17-trixie@sha256:724a4041afdb1750446e3f6b5cfa8f3b0ac5a2cf538ddfa6bfee4f94c2fa85c6';
const migrationsFolder = 'apps/api/drizzle';

describe('격리 PostgreSQL / migration / DB lifecycle', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let pool: Pool;
  let db: Database;
  let closed = true;
  let paused = false;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    container = await new PostgreSqlContainer(image).withDatabase('phase0_test').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    closed = true;
    paused = false;
  });

  async function createApp(outage: boolean, migrated: boolean) {
    if (outage) {
      execFileSync('docker', ['pause', container.getId()], { stdio: 'pipe' });
      paused = true;
    }

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = configureApp(module.createNestApplication({ logger: false }));
    closed = false;
    await app.init();
    pool = app.get<Pool>(POSTGRES_POOL);
    db = app.get<Database>(DATABASE);

    if (migrated) {
      await migrate(db, { migrationsFolder });
    }
  }

  afterEach(async () => {
    try {
      if (paused) {
        execFileSync('docker', ['unpause', container.getId()], { stdio: 'pipe' });
      }
    } finally {
      try {
        if (app && !closed) {
          await app.close();
        }
      } finally {
        try {
          await container?.stop();
        } finally {
          if (previousDatabaseUrl === undefined) {
            delete process.env.DATABASE_URL;
          } else {
            process.env.DATABASE_URL = previousDatabaseUrl;
          }
        }
      }
    }
  });

  describe('기동 장애', () => {
    beforeEach(() => createApp(true, false));

    it('실제 DB가 응답하지 않는 상태에서도 API가 시작하고 DB 복구를 수용한다', async () => {
      try {
        await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
        await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      } finally {
        execFileSync('docker', ['unpause', container.getId()], { stdio: 'pipe' });
        paused = false;
      }

      await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    });
  });

  describe('빈 DB와 migration upgrade', () => {
    beforeEach(() => createApp(false, false));

    it('API bootstrap은 migration을 자동 적용하지 않는다', async () => {
      const result = await pool.query(
        "select count(*)::int as count from pg_extension where extname = 'vector'",
      );

      expect(result.rows[0].count).toBe(0);
    });
    it('다중 사용자 migration은 기존 계정·refresh를 보존하고 추가 계정을 허용한다', async () => {
      const previousFolder = await mkdtemp(path.join(tmpdir(), 'devfootnote-auth-upgrade-'));

      try {
        // 이전 migration을 수정하지 않고 0002까지 적용된 DB에서 실제 upgrade를 검증한다.
        const journal = JSON.parse(
          await readFile(`${migrationsFolder}/meta/_journal.json`, 'utf8'),
        );
        const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 2);

        await mkdir(path.join(previousFolder, 'meta'));
        await writeFile(
          path.join(previousFolder, 'meta/_journal.json'),
          JSON.stringify({ ...journal, entries }),
        );

        for (const entry of entries) {
          await copyFile(
            `${migrationsFolder}/${entry.tag}.sql`,
            path.join(previousFolder, `${entry.tag}.sql`),
          );
        }

        await migrate(drizzle(pool), { migrationsFolder: previousFolder });
        const {
          rows: [account],
        } = await pool.query(
          'insert into accounts (issuer, subject) values ($1, $2) returning id, issuer, subject',
          ['https://accounts.google.com', 'existing-google-user'],
        );
        const {
          rows: [refresh],
        } = await pool.query(
          "insert into auth_refresh_tokens (owner_id, token_hash, created_at, expires_at) values ($1, $2, now(), now() + interval '7 days') returning *",
          [account.id, 'a'.repeat(64)],
        );

        await expect(
          pool.query('insert into accounts (issuer, subject) values ($1, $2)', [
            account.issuer,
            'new-google-user',
          ]),
        ).rejects.toMatchObject({ code: '23505', constraint: 'accounts_singleton_unique' });

        await migrate(drizzle(pool), { migrationsFolder });
        expect(
          (await pool.query('select * from accounts where id = $1', [account.id])).rows,
        ).toEqual([account]);
        expect(
          (await pool.query('select * from auth_refresh_tokens where owner_id = $1', [account.id]))
            .rows,
        ).toEqual([refresh]);
        const {
          rows: [other],
        } = await pool.query(
          'insert into accounts (issuer, subject) values ($1, $2) returning id',
          [account.issuer, 'new-google-user'],
        );

        expect(other.id).not.toBe(account.id);
        await expect(
          pool.query('insert into accounts (issuer, subject) values ($1, $2)', [
            account.issuer,
            account.subject,
          ]),
        ).rejects.toMatchObject({ code: '23505', constraint: 'accounts_issuer_subject_unique' });
      } finally {
        await rm(previousFolder, { recursive: true, force: true });
      }
    });
    it('OAuth state rename은 기존 행과 제약·인덱스를 보존한다', async () => {
      const previousFolder = await mkdtemp(path.join(tmpdir(), 'devfootnote-state-rename-'));

      try {
        const journal = JSON.parse(
          await readFile(`${migrationsFolder}/meta/_journal.json`, 'utf8'),
        );
        const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 7);

        await mkdir(path.join(previousFolder, 'meta'));
        await writeFile(
          path.join(previousFolder, 'meta/_journal.json'),
          JSON.stringify({ ...journal, entries }),
        );

        for (const entry of entries) {
          await copyFile(
            `${migrationsFolder}/${entry.tag}.sql`,
            path.join(previousFolder, `${entry.tag}.sql`),
          );
        }

        await migrate(drizzle(pool), { migrationsFolder: previousFolder });
        const { rows: before } = await pool.query(
          `insert into auth_login_attempts (state_hash, binding_hash, expires_at, return_to)
           values ($1, $2, now() + interval '5 minutes', $3) returning *`,
          ['state-hash', 'binding-hash', '/search?q=oauth&page=2'],
        );

        await migrate(drizzle(pool), { migrationsFolder });
        expect((await pool.query('select * from auth_oauth_states')).rows).toEqual(before);
        expect(
          (await pool.query("select to_regclass('public.auth_login_attempts') as old_table")).rows,
        ).toEqual([{ old_table: null }]);
        const { rows: indexes } = await pool.query(
          "select indexname, indexdef from pg_indexes where tablename = 'auth_oauth_states' order by indexname",
        );

        expect(indexes).toEqual([
          {
            indexname: 'auth_oauth_states_expiry_idx',
            indexdef: expect.stringContaining('USING btree (expires_at)'),
          },
          {
            indexname: 'auth_oauth_states_pkey',
            indexdef: expect.stringContaining('UNIQUE INDEX'),
          },
        ]);
        await expect(
          pool.query(
            `insert into auth_oauth_states (state_hash, binding_hash, expires_at)
             values ($1, $2, now() + interval '5 minutes')`,
            ['state-hash', 'another-binding'],
          ),
        ).rejects.toMatchObject({ code: '23505', constraint: 'auth_oauth_states_pkey' });
      } finally {
        await rm(previousFolder, { recursive: true, force: true });
      }
    });

    it('저장 vector migration은 기존 원문을 보존하고 검색 표현·index를 전환한다', async () => {
      const previousFolder = await mkdtemp(path.join(tmpdir(), 'devfootnote-search-vector-'));

      try {
        const journal = JSON.parse(
          await readFile(`${migrationsFolder}/meta/_journal.json`, 'utf8'),
        );
        const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 8);

        await mkdir(path.join(previousFolder, 'meta'));
        await writeFile(
          path.join(previousFolder, 'meta/_journal.json'),
          JSON.stringify({ ...journal, entries }),
        );

        for (const entry of entries) {
          await copyFile(
            `${migrationsFolder}/${entry.tag}.sql`,
            path.join(previousFolder, `${entry.tag}.sql`),
          );
        }

        await migrate(drizzle(pool), { migrationsFolder: previousFolder });
        const client = await pool.connect();

        try {
          await client.query(`begin;
            insert into accounts (id, issuer, subject)
              values ('00000000-0000-4000-8000-000000000001', 'fixture', 'search-upgrade');
            insert into materials (id, owner_id, current_revision_id)
              values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003');
            insert into material_revisions (id, owner_id, material_id, revision, body, content_fingerprint)
              values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 1, '인증 redis 공통기록', 'fixture');
            insert into material_keywords (revision_id, owner_id, material_id, normalized_text)
              select id, owner_id, material_id, body from material_revisions;
            commit;`);
        } catch (error) {
          await client.query('rollback');

          throw error;
        } finally {
          client.release();
        }

        const before = (await pool.query('select * from material_keywords')).rows;

        await migrate(drizzle(pool), { migrationsFolder });
        expect(
          (
            await pool.query(
              'select revision_id, owner_id, material_id, normalized_text from material_keywords',
            )
          ).rows,
        ).toEqual(before);
        expect(
          (
            await pool.query(`select search_vector = to_tsvector('simple', normalized_text) as equivalent,
          search_vector @@ plainto_tsquery('simple', '인증 redis') as matched from material_keywords`)
          ).rows,
        ).toEqual([{ equivalent: true, matched: true }]);
        const indexes = (
          await pool.query("select indexname from pg_indexes where tablename = 'material_keywords'")
        ).rows.map((row) => row.indexname);

        expect(indexes).toContain('material_keywords_search_vector_idx');
        expect(indexes).toContain('material_keywords_trigram_idx');
        expect(indexes).not.toContain('material_keywords_fulltext_idx');
        expect(
          (
            await pool.query(`select is_generated from information_schema.columns
          where table_name = 'material_keywords' and column_name = 'search_vector'`)
          ).rows,
        ).toEqual([{ is_generated: 'ALWAYS' }]);
      } finally {
        await rm(previousFolder, { recursive: true, force: true });
      }
    });

    it('검토된 migration의 반복 적용은 기존 receipt와 효과를 중복하지 않는다', async () => {
      await migrate(drizzle(pool), { migrationsFolder });
      const before = (
        await pool.query(
          'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
        )
      ).rows;

      expect(before.length).toBeGreaterThan(0);
      await migrate(drizzle(pool), { migrationsFolder });
      expect(
        (await pool.query("select extversion from pg_extension where extname = 'vector'")).rows,
      ).toEqual([{ extversion: '0.8.6' }]);
      expect(
        (
          await pool.query(
            'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
          )
        ).rows,
      ).toEqual(before);
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    });
  });

  describe('준비된 DB의 runtime·잠금·종료', () => {
    beforeEach(() => createApp(false, true));

    it('같은 프로세스의 DB provider가 하나의 Pool을 공유한다', () => {
      expect(app.get(POSTGRES_POOL)).toBe(pool);
      expect(app.get(DATABASE)).toBe(db);

      for (const value of [
        pool.options.max,
        pool.options.connectionTimeoutMillis,
        pool.options.statement_timeout,
        pool.options.lock_timeout,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    });
    it('명시적 migration 실행기는 동시 실행을 거부하고 잠금 해제 후 적용된다', async () => {
      const client = await pool.connect();
      const options = {
        cwd: path.resolve('apps/api'),
        encoding: 'utf8' as const,
        env: process.env,
      };
      const before = (
        await pool.query(
          'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
        )
      ).rows;

      try {
        await client.query('select pg_advisory_lock(731830)');
        const busy = spawnSync(process.execPath, ['scripts/migrate.mjs'], options);

        expect(busy.status).toBe(1);
        expect(busy.stdout + busy.stderr).not.toContain(container.getPassword());
      } finally {
        await client.query('select pg_advisory_unlock(731830)');
        client.release();
      }

      const applied = spawnSync(process.execPath, ['scripts/migrate.mjs'], options);

      expect(applied.status).toBe(0);
      expect(
        (
          await pool.query(
            'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
          )
        ).rows,
      ).toEqual(before);
    });
    it('SQL 실패·rollback 이후 연결을 다시 사용할 수 있다', async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(sql`select 1 / 0`);
        }),
      ).rejects.toThrow();
      expect((await db.execute(sql`select 1 as value`)).rows).toEqual([{ value: 1 }]);
      expect(pool.waitingCount).toBe(0);
    });
    it('migration 실패 출력에 SQL·DB 계정·credential을 노출하지 않는다', async () => {
      const role = 'PRIVATE_MIGRATION_ROLE';
      const password = 'PRIVATE_MIGRATION_PASSWORD';

      await pool.query(
        `CREATE ROLE "PRIVATE_MIGRATION_ROLE" LOGIN PASSWORD 'PRIVATE_MIGRATION_PASSWORD'`,
      );

      try {
        const url = new URL(container.getConnectionUri());

        url.username = role;
        url.password = password;
        const failed = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
          cwd: path.resolve('apps/api'),
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, DATABASE_URL: url.href },
        });

        expect(failed.status).toBe(1);
        expect(failed.stderr).toContain('PERMISSION_DENIED');
        expect(failed.stdout + failed.stderr).not.toMatch(
          /PRIVATE_MIGRATION|Failed query|CREATE|SELECT|params:|postgresql:\/\//i,
        );
      } finally {
        await pool.query('DROP ROLE "PRIVATE_MIGRATION_ROLE"');
      }
    });
    it('migration의 DDL 잠금 대기는 유한하고 실패 뒤 실행 잠금을 반환한다', async () => {
      const blocker = await pool.connect();
      const before = (
        await pool.query(
          'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
        )
      ).rows;
      const options = {
        cwd: path.resolve('apps/api'),
        encoding: 'utf8' as const,
        timeout: 5000,
        env: process.env,
      };

      try {
        await blocker.query('begin');
        // 잠금 획득 완료가 barrier다. 실행기가 metadata를 읽으려면 반드시 기다려야 한다.
        await blocker.query('lock table drizzle.__drizzle_migrations in access exclusive mode');
        const failed = spawnSync(process.execPath, ['scripts/migrate.mjs'], options);

        expect(failed.error).toBeUndefined();
        expect(failed.status).toBe(1);
        expect(failed.stderr).toContain('LOCK_TIMEOUT');
        expect(failed.stdout + failed.stderr).not.toMatch(/select|__drizzle_migrations/i);
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }

      const verifier = await pool.connect();

      try {
        expect(
          (await verifier.query('select pg_try_advisory_lock(731830) as acquired')).rows,
        ).toEqual([{ acquired: true }]);
      } finally {
        await verifier.query('select pg_advisory_unlock(731830)');
        verifier.release();
      }

      expect(spawnSync(process.execPath, ['scripts/migrate.mjs'], options).status).toBe(0);
      expect(
        (
          await pool.query(
            'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
          )
        ).rows,
      ).toEqual(before);
    });
    it('연결 획득 timeout 뒤 client 반환으로 복구한다', async () => {
      const clients = await Promise.all(
        Array.from({ length: pool.options.max ?? 0 }, () => pool.connect()),
      );

      try {
        await expect(pool.connect()).rejects.toThrow();
        await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
        await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
      } finally {
        clients.forEach((client) => client.release());
      }

      expect((await pool.query('select 1 as value')).rows).toEqual([{ value: 1 }]);
      await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    });
    it('실제 잠금·statement timeout 뒤 transaction과 연결을 복구한다', async () => {
      const blocker = await pool.connect();
      const waiter = await pool.connect();

      try {
        await blocker.query('begin');
        await blocker.query('select pg_advisory_xact_lock(73182)');
        await waiter.query('begin');
        await expect(waiter.query('select pg_advisory_xact_lock(73182)')).rejects.toMatchObject({
          code: '55P03',
        });
        await waiter.query('rollback');
        await waiter.query('begin');
        await waiter.query("set local statement_timeout = '30ms'");
        await expect(waiter.query('select pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });
        await waiter.query('rollback');
        expect((await waiter.query('select 1 as value')).rows).toEqual([{ value: 1 }]);
      } finally {
        await blocker.query('rollback');
        blocker.release();
        waiter.release();
      }
    });
    it('idle-client 오류에는 원본 오류 대신 정제된 event만 남긴다', async () => {
      // Pino가 실제 출력하는 내용을 별도 프로세스에서 수집한다.
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          "const { createPool } = require('./apps/api/dist/infrastructure/database/database.provider.js'); const pool = createPool(); pool.emit('error', new Error('PRIVATE_SQL_PARAMETER_TOKEN')); pool.end();",
        ],
        { encoding: 'utf8', env: process.env },
      );

      expect(child.status).toBe(0);
      expect(child.stdout + child.stderr).toContain('PostgreSQL idle 연결 오류');
      expect(child.stdout + child.stderr).not.toContain('PRIVATE_SQL_PARAMETER_TOKEN');
    });
    it('실제 DB 응답 중단·복구에 따라 readiness가 503→200으로 복구된다', async () => {
      // 이 suite가 만든 컨테이너만 일시 중지한다. 포트·volume·DB 설정은 유지한다.
      execFileSync('docker', ['pause', container.getId()], { stdio: 'pipe' });

      try {
        await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
        const failed = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);

        expect(failed.body).toEqual({
          success: false,
          error: 'SERVICE_UNAVAILABLE',
          message: '잠시 후 다시 시도해 주세요.',
        });
      } finally {
        execFileSync('docker', ['unpause', container.getId()], { stdio: 'pipe' });
      }

      await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      expect(
        (await pool.query("select extversion from pg_extension where extname = 'vector'")).rows,
      ).toEqual([{ extversion: '0.8.6' }]);
    });
    it('app close가 Pool을 닫는다', async () => {
      await app.close();
      closed = true;
      expect(pool.totalCount).toBe(0);
      await expect(pool.query('select 1')).rejects.toThrow();
    });
  });
});
