import 'reflect-metadata';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import type { Database } from '../packages/backend/dist/infrastructure/database/database.provider.js';

// 앱이 읽는 CommonJS 모듈과 같은 인스턴스의 private token을 검증에만 사용한다.
const { POSTGRES_POOL, DATABASE }: typeof import('../packages/backend/dist/infrastructure/database/database.provider.js') = createRequire(import.meta.url)('../packages/backend/dist/infrastructure/database/database.provider.js');

const image = 'pgvector/pgvector:0.8.6-pg17-trixie@sha256:724a4041afdb1750446e3f6b5cfa8f3b0ac5a2cf538ddfa6bfee4f94c2fa85c6';
const migrationsFolder = 'packages/backend/src/infrastructure/database/migrations';

describe('격리 PostgreSQL / migration / DB lifecycle', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let pool: Pool;
  let db: Database;
  let closed = false;
  let paused = false;
  beforeAll(async () => {
    container = await new PostgreSqlContainer(image).withDatabase('phase0_test').start();
    process.env.DATABASE_URL = container.getConnectionUri();
    execFileSync('docker', ['pause', container.getId()], { stdio: 'pipe' });
    paused = true;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(module.createNestApplication({ logger: false }));
    await app.init();
    pool = app.get<Pool>(POSTGRES_POOL);
    db = app.get<Database>(DATABASE);
  });
  afterAll(async () => {
    try { if (app && !closed) await app.close(); }
    finally {
      if (paused) execFileSync('docker', ['unpause', container.getId()], { stdio: 'pipe' });
      await container?.stop();
      delete process.env.DATABASE_URL;
    }
  });

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
  it('API bootstrap은 migration을 자동 적용하지 않는다', async () => {
    const result = await pool.query("select count(*)::int as count from pg_extension where extname = 'vector'");
    expect(result.rows[0].count).toBe(0);
  });
  it('검토된 migration의 반복 적용은 기존 receipt와 효과를 중복하지 않는다', async () => {
    await migrate(drizzle(pool), { migrationsFolder });
    const before = (await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows;
    expect(before.length).toBeGreaterThan(0);
    await migrate(drizzle(pool), { migrationsFolder });
    expect((await pool.query("select extversion from pg_extension where extname = 'vector'")).rows).toEqual([{ extversion: '0.8.6' }]);
    expect((await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows).toEqual(before);
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
  });
  it('같은 프로세스의 DB provider가 하나의 Pool을 공유한다', () => {
    expect(app.get(POSTGRES_POOL)).toBe(pool);
    expect(app.get(DATABASE)).toBe(db);
    for (const value of [pool.options.max, pool.options.connectionTimeoutMillis, pool.options.statement_timeout, pool.options.lock_timeout]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
  it('명시적 migration 실행기는 동시 실행을 거부하고 잠금 해제 후 적용된다', async () => {
    const client = await pool.connect();
    const options = { cwd: path.resolve('packages/backend'), encoding: 'utf8' as const, env: process.env };
    const before = (await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows;
    try {
      await client.query('select pg_advisory_lock(731830)');
      const busy = spawnSync(process.execPath, ['scripts/migrate.mjs'], options);
      expect(busy.status).toBe(1);
      expect(busy.stdout + busy.stderr).not.toContain(container.getPassword());
    } finally { await client.query('select pg_advisory_unlock(731830)'); client.release(); }
    const applied = spawnSync(process.execPath, ['scripts/migrate.mjs'], options);
    expect(applied.status).toBe(0);
    expect((await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows).toEqual(before);
  });
  it('SQL 실패·rollback 이후 연결을 다시 사용할 수 있다', async () => {
    await expect(db.transaction(async tx => { await tx.execute(sql`select 1 / 0`); })).rejects.toThrow();
    expect((await db.execute(sql`select 1 as value`)).rows).toEqual([{ value: 1 }]);
    expect(pool.waitingCount).toBe(0);
  });
  it('migration 실패 출력에 SQL·DB 계정·credential을 노출하지 않는다', async () => {
    const role = 'PRIVATE_MIGRATION_ROLE';
    const password = 'PRIVATE_MIGRATION_PASSWORD';
    await pool.query(`CREATE ROLE "PRIVATE_MIGRATION_ROLE" LOGIN PASSWORD 'PRIVATE_MIGRATION_PASSWORD'`);
    try {
      const url = new URL(container.getConnectionUri());
      url.username = role;
      url.password = password;
      const failed = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
        cwd: path.resolve('packages/backend'), encoding: 'utf8', timeout: 5000,
        env: { ...process.env, DATABASE_URL: url.href },
      });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('PERMISSION_DENIED');
      expect(failed.stdout + failed.stderr).not.toMatch(/PRIVATE_MIGRATION|Failed query|CREATE|SELECT|params:|postgresql:\/\//i);
    } finally { await pool.query('DROP ROLE "PRIVATE_MIGRATION_ROLE"'); }
  });
  it('migration의 DDL 잠금 대기는 유한하고 실패 뒤 실행 잠금을 반환한다', async () => {
    const blocker = await pool.connect();
    const before = (await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows;
    const options = { cwd: path.resolve('packages/backend'), encoding: 'utf8' as const, timeout: 5000, env: process.env };
    try {
      await blocker.query('begin');
      // 잠금 획득 완료가 barrier다. 실행기가 metadata를 읽으려면 반드시 기다려야 한다.
      await blocker.query('lock table drizzle.__drizzle_migrations in access exclusive mode');
      const failed = spawnSync(process.execPath, ['scripts/migrate.mjs'], options);
      expect(failed.error).toBeUndefined();
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('LOCK_TIMEOUT');
      expect(failed.stdout + failed.stderr).not.toMatch(/select|__drizzle_migrations/i);
    } finally { await blocker.query('rollback'); blocker.release(); }
    const verifier = await pool.connect();
    try {
      expect((await verifier.query('select pg_try_advisory_lock(731830) as acquired')).rows).toEqual([{ acquired: true }]);
    } finally { await verifier.query('select pg_advisory_unlock(731830)'); verifier.release(); }
    expect(spawnSync(process.execPath, ['scripts/migrate.mjs'], options).status).toBe(0);
    expect((await pool.query('select hash, created_at from drizzle.__drizzle_migrations order by created_at')).rows).toEqual(before);
  });
  it('연결 획득 timeout 뒤 client 반환으로 복구한다', async () => {
    const clients = await Promise.all(Array.from({ length: pool.options.max ?? 0 }, () => pool.connect()));
    try {
      await expect(pool.connect()).rejects.toThrow();
      await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
      await request(app.getHttpServer()).get('/api/v1/health/live').expect(200);
    }
    finally { clients.forEach(client => client.release()); }
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
      await expect(waiter.query('select pg_advisory_xact_lock(73182)')).rejects.toMatchObject({ code: '55P03' });
      await waiter.query('rollback');
      await waiter.query('begin');
      await waiter.query("set local statement_timeout = '30ms'");
      await expect(waiter.query('select pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });
      await waiter.query('rollback');
      expect((await waiter.query('select 1 as value')).rows).toEqual([{ value: 1 }]);
    } finally {
      await blocker.query('rollback');
      blocker.release(); waiter.release();
    }
  });
  it('idle-client 오류에는 원본 오류 대신 정제된 event만 남긴다', async () => {
    // Pino가 실제 출력하는 내용을 별도 프로세스에서 수집한다.
    const child = spawnSync(process.execPath, ['-e', "const { createPool } = require('./packages/backend/dist/infrastructure/database/database.provider.js'); const pool = createPool(); pool.emit('error', new Error('PRIVATE_SQL_PARAMETER_TOKEN')); pool.end();"], { encoding: 'utf8', env: process.env });
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
      expect(failed.body).toEqual({ success: false, error: 'SERVICE_UNAVAILABLE', message: '잠시 후 다시 시도해 주세요.' });
    } finally { execFileSync('docker', ['unpause', container.getId()], { stdio: 'pipe' }); }
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    expect((await pool.query("select extversion from pg_extension where extname = 'vector'")).rows).toEqual([{ extversion: '0.8.6' }]);
  });
  it('app close가 Pool을 닫는다', async () => {
    await app.close();
    closed = true;
    expect(pool.totalCount).toBe(0);
    await expect(pool.query('select 1')).rejects.toThrow();
  });
});
