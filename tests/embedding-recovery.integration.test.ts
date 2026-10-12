import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  EMBEDDING_CLAIM_QUEUE,
  type EmbeddingClaimJob,
  type EmbeddingClaimResult,
} from '@devfootnote/queue';
import type { EmbeddingPolicy } from '../apps/api/dist/modules/usage-retention/index.js';
import { startAuthHarness } from './auth-harness.js';
import { GOOGLE_SUBJECT_A } from './auth-environment.js';

const requireFixture = createRequire(resolve('tests/embedding-recovery.integration.test.ts'));
const { MaterialsService }: typeof import('../apps/api/dist/modules/materials/index.js') =
  requireFixture('../apps/api/dist/modules/materials/index.js');
const { EmbeddingDeliveryService }: typeof import('../apps/api/dist/modules/indexing/index.js') =
  requireFixture('../apps/api/dist/modules/indexing/index.js');
const { WorkerModule }: typeof import('../apps/worker/dist/worker.module.js') = requireFixture(
  '../apps/worker/dist/worker.module.js',
);
const {
  TransactionsModule,
}: typeof import('../apps/worker/dist/infrastructure/database/transactions.module.js') =
  requireFixture('../apps/worker/dist/infrastructure/database/transactions.module.js');
const {
  DatabaseModule,
}: typeof import('../apps/worker/dist/infrastructure/database/database.module.js') = requireFixture(
  '../apps/worker/dist/infrastructure/database/database.module.js',
);
const {
  MaterialsModule,
}: typeof import('../apps/worker/dist/modules/materials/materials.module.js') = requireFixture(
  '../apps/worker/dist/modules/materials/materials.module.js',
);
const {
  UsageRetentionModule,
}: typeof import('../apps/worker/dist/modules/usage-retention/usage-retention.module.js') =
  requireFixture('../apps/worker/dist/modules/usage-retention/usage-retention.module.js');
const {
  EmbeddingWorkRepository,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-work.repository.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-work.repository.js');
const {
  EmbeddingExecutionService,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-execution.service.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-execution.service.js');
const {
  EmbeddingRepairService,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-repair.service.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-repair.service.js');
const {
  EmbeddingLifecycleService,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-lifecycle.service.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-lifecycle.service.js');
const { logger }: typeof import('../apps/worker/dist/infrastructure/logging/logger.js') =
  requireFixture('../apps/worker/dist/infrastructure/logging/logger.js');

// 실제 전송·가격 승인이 아니다. 이 suite의 격리 DB에만 사용한다.
const policy: EmbeddingPolicy = {
  provider: 'fixture-no-network',
  model: 'fixture',
  modelVersion: '1',
  dimensions: 3,
  inputVersion: 'fixture-body-v1',
  policyVersion: 'fixture-consent-v1',
  retentionNotice: 'fixture only',
  pricingVersion: 'fixture-price-v1',
  currency: 'USD',
  unitScale: 1000000,
  maximumPerChunk: '10',
  budgetId: '00000000-0000-4000-8000-000000000300',
  budgetLimit: '10000',
  periodStart: '2020-01-01T00:00:00.000Z',
  periodEnd: '2100-01-01T00:00:00.000Z',
  reservationSeconds: 600,
};

describe('embedding repair / 실제 PostgreSQL·Redis·BullMQ, provider 호출 없음', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let redis: StartedTestContainer;
  let redisUrl: string;
  let connection: Redis;
  let queue: Queue<EmbeddingClaimJob, EmbeddingClaimResult>;
  let events: QueueEvents;
  let ownerId: string;
  let access: string;
  let csrf: Awaited<ReturnType<typeof harness.issueCsrf>>;
  let fingerprint: string;
  let redisStopped = false;
  let observersClosed = false;
  const modules = new Set<TestingModule>();

  async function closeModules() {
    const results = await Promise.allSettled([...modules].map((module) => module.close()));

    modules.clear();
    const failures = results.filter((result) => result.status === 'rejected');

    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        '복구 테스트 worker 정리에 실패했습니다.',
      );
    }
  }

  function workerConfig() {
    return new ConfigService({
      databaseUrl: harness.app.get(ConfigService).getOrThrow<string>('databaseUrl'),
      redisUrl,
      embeddingConfigFingerprint: null,
    });
  }

  async function repairWorker() {
    const config = workerConfig();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TransactionsModule,
        DatabaseModule,
        MaterialsModule,
        UsageRetentionModule,
      ],
      providers: [
        EmbeddingWorkRepository,
        EmbeddingExecutionService,
        EmbeddingRepairService,
        EmbeddingLifecycleService,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();

    modules.add(module);
    vi.spyOn(module.get(EmbeddingRepairService), 'onApplicationBootstrap').mockImplementation(
      () => {},
    );
    await module.init();
    // 자동 timer·consumer 없이 같은 제품 Service를 수동 회차로 검증한다.
    config.set('embeddingConfigFingerprint', fingerprint);

    return {
      repository: module.get(EmbeddingWorkRepository),
      execution: module.get(EmbeddingExecutionService),
      repair: module.get(EmbeddingRepairService),
    };
  }

  async function claimThroughConsumer(workId: string) {
    const module = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ConfigService)
      .useValue(workerConfig())
      .compile();

    modules.add(module);

    try {
      const job = await queue.getJob(workId);

      expect(job).toBeDefined();
      await module.init();
      expect(await job?.waitUntilFinished(events, 10000)).toBe('claimed');
    } finally {
      await module.close();
      modules.delete(module);
    }

    return (
      await harness.pool.query<{ state: string; lease_token: string; attempt_count: number }>(
        'select state, lease_token, attempt_count from indexing_embedding_works where id = $1',
        [workId],
      )
    ).rows[0];
  }

  async function activate(count = 1, deliver = true) {
    const saved = [];

    for (let i = 0; i < count; i++) {
      saved.push(
        await harness.app.get(MaterialsService).create(ownerId, {
          idempotencyKey: randomUUID(),
          body: '복구할 PostgreSQL 근거 본문',
        }),
      );
    }

    const preview = await request(harness.app.getHttpServer())
      .get('/api/v1/indexing/embedding/preview')
      .set('Cookie', access)
      .expect(200);

    fingerprint = preview.body.data.policy.configFingerprint;
    const delivery = deliver
      ? undefined
      : vi.spyOn(harness.app.get(EmbeddingDeliveryService), 'deliver').mockResolvedValue(false);

    try {
      const response = await request(harness.app.getHttpServer())
        .post('/api/v1/indexing/embedding/activations')
        .set(csrf.headers)
        .set('Cookie', [...csrf.cookies, access])
        .send({
          requestId: randomUUID(),
          configFingerprint: fingerprint,
          policyVersion: policy.policyVersion,
          expectedConsentEpoch: preview.body.data.consentEpoch,
          accepted: true,
          targets: saved.map((material) => ({
            materialId: material.id,
            revisionId: material.revisionId,
          })),
        })
        .expect(202);
      const workIds: string[] = response.body.data.workIds;

      expect(workIds).toHaveLength(count);
      const workId = workIds[0];
      const material = saved[0];

      if (!workId || !material) {
        throw new Error('활성화 fixture에 첫 work와 자료가 없습니다.');
      }

      return { workIds, workId, material };
    } finally {
      delivery?.mockRestore();
    }
  }

  async function expireClaim(workId: string) {
    await harness.pool.query(
      `update indexing_embedding_works
       set lease_expires_at = clock_timestamp() - interval '1 second',
           delivery_after = clock_timestamp() - interval '1 second'
       where id = $1`,
      [workId],
    );
  }

  beforeAll(async () => {
    redis = await new GenericContainer(
      'redis:7.4.7-alpine@sha256:02f2cc4882f8bf87c79a220ac958f58c700bdec0dfb9b9ea61b62fb0e8f1bfcf',
    )
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    harness = await startAuthHarness(undefined, 0, redisUrl);
    connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    connection.on('error', () => {});
    queue = new Queue(EMBEDDING_CLAIM_QUEUE, { connection });
    events = new QueueEvents(EMBEDDING_CLAIM_QUEUE, { connection });
    await events.waitUntilReady();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await harness.pool.query(
      'truncate answer_call_attempts, answer_requests, usage_answer_consents, indexing_embedding_vectors, usage_embedding_call_receipts, auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_works, indexing_embedding_attempts, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations',
    );
    harness.app.get(ConfigService).set('embeddingPolicy', policy);
    access = `devfootnote_access=${(await harness.auth.completeLogin(GOOGLE_SUBJECT_A)).access}`;
    const owner = (await harness.pool.query<{ id: string }>('select id from accounts')).rows[0];

    if (!owner) {
      throw new Error('로그인 fixture의 owner가 없습니다.');
    }

    ownerId = owner.id;
    csrf = await harness.issueCsrf();
  });

  afterEach(closeModules);

  afterAll(async () => {
    const failures: unknown[] = [];

    for (const close of [
      closeModules,
      async () => {
        if (!observersClosed) {
          try {
            await events?.close();
          } finally {
            try {
              await queue?.close();
            } finally {
              connection?.disconnect();
            }
          }
        }
      },
      async () => harness?.close(),
      async () => {
        if (!redisStopped) {
          await redis?.stop();
        }
      },
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, '복구 테스트 자원 정리에 실패했습니다.');
    }
  });

  it('commit 뒤 enqueue가 누락되어도 DB work를 재전달하고 실제 consumer가 claim한다', async () => {
    const { workId } = await activate(1, false);

    expect(await queue.getJob(workId)).toBeUndefined();
    const { repair } = await repairWorker();

    await repair.runOnce();
    const job = await queue.getJob(workId);

    expect(job?.data).toEqual({ workId });
    expect(await job?.getState()).toBe('waiting');
    expect(await claimThroughConsumer(workId)).toEqual({
      state: 'LEASED',
      lease_token: expect.any(String),
      attempt_count: 0,
    });
    expect(
      (await harness.pool.query('select count(*)::int as n from indexing_embedding_attempts')).rows,
    ).toEqual([{ n: 0 }]);
  });

  it('보존된 completed job도 만료 lease 복구 뒤 다시 claim하며 API 재전달도 같은 ID를 재사용한다', async () => {
    const { workId } = await activate();
    const first = await claimThroughConsumer(workId);

    expect(await (await queue.getJob(workId))?.getState()).toBe('completed');
    await expireClaim(workId);
    const { repair, execution } = await repairWorker();

    await repair.runOnce();
    expect(await (await queue.getJob(workId))?.getState()).toBe('waiting');
    const second = await claimThroughConsumer(workId);

    expect(second?.lease_token).not.toBe(first?.lease_token);
    expect(second?.attempt_count).toBe(0);
    await expireClaim(workId);
    expect(await execution.recover(workId)).toBe('pending');
    expect(await harness.app.get(EmbeddingDeliveryService).deliver(ownerId, workId)).toBe(true);
    expect(await (await queue.getJob(workId))?.getState()).toBe('waiting');
    const third = await claimThroughConsumer(workId);

    expect(third?.lease_token).not.toBe(second?.lease_token);
  });

  it('보존된 failed 전달 메시지를 삭제하지 않고 재대기열화한다', async () => {
    const { workId } = await activate();
    const failing = new Worker(
      EMBEDDING_CLAIM_QUEUE,
      async () => {
        throw new Error('fixture delivery failure');
      },
      { connection },
    );

    try {
      const job = await queue.getJob(workId);

      await expect(job?.waitUntilFinished(events, 10000)).rejects.toThrow(
        'fixture delivery failure',
      );
    } finally {
      await failing.close();
    }

    expect(await (await queue.getJob(workId))?.getState()).toBe('failed');
    const { repair } = await repairWorker();

    await repair.runOnce();
    expect(await (await queue.getJob(workId))?.getState()).toBe('waiting');
    expect((await claimThroughConsumer(workId))?.state).toBe('LEASED');
  });

  it('테스트 큐가 유실되어도 nonterminal만 재전달하고 terminal 상태는 보존한다', async () => {
    const { workIds } = await activate(3);
    const terminalId = workIds[2];

    if (!terminalId) {
      throw new Error('terminal fixture의 work가 없습니다.');
    }

    await harness.pool.query(
      "update indexing_embedding_works set state = 'FINAL_FAILED', last_failure = 'invalid_response' where id = $1",
      [terminalId],
    );
    // 이 suite만 소유한 Redis 큐를 지운다. PostgreSQL work는 유지한다.
    await queue.obliterate({ force: true });
    const { repair } = await repairWorker();

    await repair.runOnce();

    for (const workId of workIds.slice(0, 2)) {
      expect(await (await queue.getJob(workId))?.getState()).toBe('waiting');
    }

    expect(await queue.getJob(terminalId)).toBeUndefined();
    expect(
      (
        await harness.pool.query(
          'select state, last_failure from indexing_embedding_works where id = $1',
          [terminalId],
        )
      ).rows,
    ).toEqual([{ state: 'FINAL_FAILED', last_failure: 'invalid_response' }]);
  });

  it('첫 work의 복구 SQL이 실패해도 같은 회차의 정상 work는 전달하고 실패 원문은 숨긴다', async () => {
    const { workIds, workId: failingId } = await activate(2, false);
    const healthyId = workIds[1];

    if (!healthyId) {
      throw new Error('정상 복구 fixture의 work가 없습니다.');
    }

    const { repository, repair } = await repairWorker();

    expect(await repository.claim(failingId)).toBe(true);
    await expireClaim(failingId);
    // ID·삽입 순서에 의존하지 않고 실패할 work가 반드시 이번 배치의 첫 항목이게 한다.
    await harness.pool.query(
      `update indexing_embedding_works set delivery_after = clock_timestamp() -
       case when id = $1 then interval '2 minutes' else interval '1 minute' end`,
      [failingId],
    );
    const before = await harness.pool.query(
      'select state, lease_token, lease_expires_at, attempt_count, last_failure from indexing_embedding_works where id = $1',
      [failingId],
    );
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    let triggerCreated = false;

    try {
      // scanner의 delivery_after UPDATE는 통과시키고 recover의 상태 전이만 실패시킨다.
      await harness.pool
        .query(`create function fail_one_recovery_fixture() returns trigger language plpgsql as $$
        begin raise exception 'PRIVATE_RECOVERY_SQL_BODY'; end $$;
        create trigger fail_one_recovery_fixture before update of state on indexing_embedding_works
        for each row when (old.state = 'LEASED' and new.state = 'PENDING')
        execute function fail_one_recovery_fixture()`);
      triggerCreated = true;
      await repair.runOnce();

      expect(await queue.getJob(failingId)).toBeUndefined();
      const healthyJob = await queue.getJob(healthyId);

      expect(healthyJob?.data).toEqual({ workId: healthyId });
      expect(await healthyJob?.getState()).toBe('waiting');
      expect(
        (
          await harness.pool.query(
            'select state, lease_token, lease_expires_at, attempt_count, last_failure from indexing_embedding_works where id = $1',
            [failingId],
          )
        ).rows,
      ).toEqual(before.rows);
      expect(
        (await harness.pool.query('select count(*)::int as n from indexing_embedding_attempts'))
          .rows,
      ).toEqual([{ n: 0 }]);
      expect(errorLog).toHaveBeenCalledWith('임베딩 작업 복구 저장 오류');
      expect(warning).toHaveBeenCalled();
      const logs = JSON.stringify([warning.mock.calls, errorLog.mock.calls]);

      expect(logs).not.toContain('PRIVATE_RECOVERY_SQL_BODY');
      expect(logs).not.toContain('update "indexing_embedding_works"');
      expect(logs).not.toContain(failingId);
    } finally {
      try {
        if (triggerCreated) {
          await harness.pool.query(
            'drop trigger fail_one_recovery_fixture on indexing_embedding_works; drop function fail_one_recovery_fixture()',
          );
        }
      } finally {
        warning.mockRestore();
        errorLog.mockRestore();
      }
    }
  });

  it('독립 scanner 두 개가 실제 잠금 중에도 SKIP LOCKED로 20건씩 서로 다른 work를 선점한다', async () => {
    await activate(20, false);
    await activate(20, false);
    await activate(1, false);
    const first = await repairWorker();
    const second = await repairWorker();
    const blocker = await harness.pool.connect();
    const pending: Promise<string[]>[] = [];
    const failures: unknown[] = [];
    let barrierCreated = false;

    try {
      await harness.pool
        .query(`create function block_repair_fixture() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(731903); return new; end $$;
      create trigger block_repair_fixture before update of delivery_after on indexing_embedding_works
      for each row execute function block_repair_fixture()`);
      barrierCreated = true;
      await blocker.query('select pg_advisory_lock(731903)');
      pending.push(first.repository.reserveRepairBatch(20));
      await vi.waitFor(
        async () => {
          expect(
            (
              await harness.pool.query(`select count(*)::int as n from pg_stat_activity
          where application_name = 'devfootnote-worker' and wait_event_type = 'Lock'
          and wait_event = 'advisory'`)
            ).rows[0].n,
          ).toBe(1);
        },
        { timeout: 600, interval: 10 },
      );
      pending.push(second.repository.reserveRepairBatch(20));
      await vi.waitFor(
        async () => {
          expect(
            (
              await harness.pool.query(`select count(*)::int as n from pg_stat_activity
          where application_name = 'devfootnote-worker' and wait_event_type = 'Lock'
          and wait_event = 'advisory'`)
            ).rows[0].n,
          ).toBe(2);
        },
        { timeout: 600, interval: 10 },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await blocker.query('select pg_advisory_unlock(731903)');
      } catch (error) {
        failures.push(error);
      } finally {
        blocker.release();
        await Promise.allSettled(pending);

        try {
          if (barrierCreated) {
            await harness.pool.query(
              'drop trigger block_repair_fixture on indexing_embedding_works; drop function block_repair_fixture()',
            );
          }
        } catch (error) {
          failures.push(error);
        }
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, '복구 scanner 경쟁 관찰에 실패했습니다.');
    }

    const batches = await Promise.all(pending);

    expect(batches.map((batch) => batch.length)).toEqual([20, 20]);
    expect(new Set(batches.flat()).size).toBe(40);
    expect(
      (
        await harness.pool.query(`select count(*)::int as n from indexing_embedding_works
      where delivery_after <= clock_timestamp()`)
      ).rows,
    ).toEqual([{ n: 1 }]);
    expect(await first.repository.reserveRepairBatch(20)).toHaveLength(1);
  });

  it('Redis 중단은 복구 회차만 실패시키며 durable work·저장·keyword·원문을 유지한다', async () => {
    const { workId, material } = await activate(1, false);
    const { repair } = await repairWorker();

    await events.close();
    await queue.close();
    connection.disconnect();
    observersClosed = true;
    await redis.stop();
    redisStopped = true;
    await expect(repair.runOnce()).resolves.toBeUndefined();
    expect(
      (
        await harness.pool.query(
          `select state, attempt_count from indexing_embedding_works where id = $1`,
          [workId],
        )
      ).rows,
    ).toEqual([{ state: 'PENDING', attempt_count: 0 }]);
    await harness.app.get(MaterialsService).create(ownerId, {
      idempotencyKey: randomUUID(),
      body: 'Redis 장애 중에도 PostgreSQL 저장',
    });
    await request(harness.app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    await request(harness.app.getHttpServer())
      .get(`/api/v1/materials/${material.id}`)
      .set('Cookie', access)
      .expect(200);
    const search = await request(harness.app.getHttpServer())
      .get('/api/v1/search')
      .query({ q: 'PostgreSQL' })
      .set('Cookie', access)
      .expect(200);

    expect(search.body.data.items.length).toBeGreaterThan(0);
  });
});
