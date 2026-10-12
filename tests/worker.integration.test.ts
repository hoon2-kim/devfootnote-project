import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { approveEmbeddingPolicy, geminiFreePolicy } from '@devfootnote/ai';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  CLAIM_EMBEDDING_WORK,
  EMBEDDING_CLAIM_QUEUE,
  type EmbeddingClaimJob,
  type EmbeddingClaimResult,
} from '@devfootnote/queue';
import { startAuthHarness } from './auth-harness.js';
import { GOOGLE_SUBJECT_A } from './auth-environment.js';

const requireFixture = createRequire(resolve('tests/worker.integration.test.ts'));
const { WorkerModule }: typeof import('../apps/worker/dist/worker.module.js') = requireFixture(
  '../apps/worker/dist/worker.module.js',
);
const { EmbeddingDeliveryService }: typeof import('../apps/api/dist/modules/indexing/index.js') =
  requireFixture('../apps/api/dist/modules/indexing/index.js');
const { MaterialsService }: typeof import('../apps/api/dist/modules/materials/index.js') =
  requireFixture('../apps/api/dist/modules/materials/index.js');
const { EmbeddingActivationService }: typeof import('../apps/api/dist/modules/indexing/index.js') =
  requireFixture('../apps/api/dist/modules/indexing/index.js');
const { GeminiEmbedding }: typeof import('@devfootnote/ai') = requireFixture('@devfootnote/ai');
const { logger }: typeof import('../apps/api/dist/infrastructure/logging/logger.js') =
  requireFixture('../apps/api/dist/infrastructure/logging/logger.js');
const {
  logger: workerLogger,
}: typeof import('../apps/worker/dist/infrastructure/logging/logger.js') = requireFixture(
  '../apps/worker/dist/infrastructure/logging/logger.js',
);

describe('실제 Redis 전달과 PostgreSQL claim / AI 호출 없음', () => {
  let redis: StartedTestContainer;
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let connection: Redis;
  let queue: Queue<EmbeddingClaimJob, EmbeddingClaimResult>;
  let events: QueueEvents;
  let ownerId: string;
  let access: string;
  const workers: TestingModule[] = [];

  async function startWorker() {
    const worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();

    workers.push(worker);
    await worker.init();
  }

  async function closeWorkers() {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
  }

  // claim-only 검사는 실행 설정 없이 저장 intent에 합성 work를 결합한다.
  async function seedWork() {
    const material = await harness.app.get(MaterialsService).create(ownerId, {
      idempotencyKey: randomUUID(),
      title: '큐 전달 근거',
      body: 'PostgreSQL 트랜잭션 원문',
    });
    const intent = await harness.pool.query<{ id: string }>(
      'select id from embedding_intents where revision_id = $1',
      [material.revisionId],
    );
    const id = randomUUID();
    const intentId = intent.rows[0]?.id;

    expect(
      (
        await harness.pool.query(
          'select count(*)::int as n from indexing_embedding_works where intent_id = $1',
          [intentId],
        )
      ).rows[0].n,
    ).toBe(0);

    if (!intentId) {
      throw new Error('저장된 자료의 intent가 없습니다.');
    }

    await harness.pool.query(
      `insert into indexing_embedding_works (id, owner_id, intent_id, config_fingerprint, consent_epoch, generation, activation_id)
       values ($1, $2, $3, 'fixture-only-no-provider', 1, 1, $4)`,
      [id, ownerId, intentId, randomUUID()],
    );

    return { id, material };
  }

  beforeAll(async () => {
    redis = await new GenericContainer(
      'redis:7.4.7-alpine@sha256:02f2cc4882f8bf87c79a220ac958f58c700bdec0dfb9b9ea61b62fb0e8f1bfcf',
    )
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const url = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

    harness = await startAuthHarness(undefined, 0, url);
    connection = new Redis(url, { maxRetriesPerRequest: null });
    connection.on('error', () => {});
    queue = new Queue(EMBEDDING_CLAIM_QUEUE, { connection });
    events = new QueueEvents(EMBEDDING_CLAIM_QUEUE, { connection });
    await events.waitUntilReady();
    access = `devfootnote_access=${(await harness.auth.completeLogin(GOOGLE_SUBJECT_A)).access}`;
    const account = (await harness.pool.query<{ id: string }>('select id from accounts')).rows[0];

    if (!account) {
      throw new Error('로그인 계정이 없습니다.');
    }

    ownerId = account.id;
  });

  afterAll(async () => {
    try {
      await closeWorkers();
    } finally {
      try {
        await events?.close();
        await queue?.close();
      } finally {
        connection?.disconnect();

        try {
          await harness?.close();
        } finally {
          await redis?.stop();
        }
      }
    }
  });

  it('API는 consumer를 시작하지 않고 owner가 맞는 commit된 work ID만 중복 없이 전달한다', async () => {
    const { id } = await seedWork();
    const delivery = harness.app.get(EmbeddingDeliveryService);

    expect(await delivery.deliver(randomUUID(), id)).toBe(false);
    expect(await delivery.deliver(ownerId, id)).toBe(true);
    expect(await delivery.deliver(ownerId, id)).toBe(true);
    const job = await queue.getJob(id);

    expect(job?.data).toEqual({ workId: id });
    expect(await job?.getState()).toBe('waiting');
    expect(
      (await harness.pool.query('select state from indexing_embedding_works where id = $1', [id]))
        .rows,
    ).toEqual([{ state: 'PENDING' }]);
    await startWorker();
    expect(await job?.waitUntilFinished(events, 10000)).toBe('claimed');
    const first = (
      await harness.pool.query(
        'select state, lease_token, lease_expires_at > now() as live from indexing_embedding_works where id = $1',
        [id],
      )
    ).rows[0];

    expect(first).toEqual({ state: 'LEASED', lease_token: expect.any(String), live: true });
    const duplicate = await queue.add(CLAIM_EMBEDDING_WORK, { workId: id });

    expect(await duplicate.waitUntilFinished(events, 10000)).toBe('not-claimable');
    expect(
      (
        await harness.pool.query('select lease_token from indexing_embedding_works where id = $1', [
          id,
        ])
      ).rows[0].lease_token,
    ).toBe(first.lease_token);
    await closeWorkers();
  });

  it('worker 둘을 실행하고 두 DB 연결을 row lock에서 경쟁시켜도 한 번만 claim한다', async () => {
    const { id } = await seedWork();
    const blocker = await harness.pool.connect();
    const pending: Promise<string>[] = [];

    try {
      await blocker.query('begin');
      await blocker.query('select id from indexing_embedding_works where id = $1 for update', [id]);
      // 첫 claim의 잠금 대기를 관찰한 뒤 두 번째 consumer와 job을 추가한다.
      await startWorker();
      const first = await queue.add(CLAIM_EMBEDDING_WORK, { workId: id });

      pending.push(first.waitUntilFinished(events, 10000));
      await vi.waitFor(
        async () => {
          expect(
            (
              await harness.pool.query(
                "select count(*)::int as n from pg_stat_activity where application_name = 'devfootnote-worker' and wait_event_type = 'Lock'",
              )
            ).rows[0].n,
          ).toBe(1);
        },
        { timeout: 600, interval: 10 },
      );
      // worker의 concurrency가 2이므로 두 번째 consumer 대신 같은 consumer가 받을 수도 있다.
      // DB claim의 실제 동시 경쟁은 아래 두 DB connection의 lock 대기로 직접 확인한다.
      await startWorker();
      const second = await queue.add(CLAIM_EMBEDDING_WORK, { workId: id });

      pending.push(second.waitUntilFinished(events, 10000));
      await vi.waitFor(
        async () => {
          expect(
            (
              await harness.pool.query(
                "select count(*)::int as n from pg_stat_activity where application_name = 'devfootnote-worker' and wait_event_type = 'Lock'",
              )
            ).rows[0].n,
          ).toBe(2);
        },
        { timeout: 600, interval: 10 },
      );
    } finally {
      try {
        await blocker.query('rollback');
      } finally {
        blocker.release();
        await Promise.allSettled(pending);
        await closeWorkers();
      }
    }

    expect((await Promise.all(pending)).sort()).toEqual(['claimed', 'not-claimable']);
  });

  it('미래 예약·terminal·만료 lease·없는 work는 자동 활성화하지 않는다', async () => {
    const future = await seedWork();
    const terminal = await seedWork();
    const expired = await seedWork();

    await harness.pool.query(
      "update indexing_embedding_works set next_attempt_at = now() + interval '1 hour' where id = $1",
      [future.id],
    );
    await harness.pool.query(
      "update indexing_embedding_works set state = 'FINAL_FAILED' where id = $1",
      [terminal.id],
    );
    await harness.pool.query(
      "update indexing_embedding_works set state = 'LEASED', lease_token = $2, lease_expires_at = now() - interval '1 hour' where id = $1",
      [expired.id, randomUUID()],
    );
    await startWorker();

    for (const id of [future.id, terminal.id, expired.id, randomUUID()]) {
      const job = await queue.add(CLAIM_EMBEDDING_WORK, { workId: id });

      expect(await job.waitUntilFinished(events, 10000)).toBe('not-claimable');
    }

    expect(
      (
        await harness.pool.query('select state from indexing_embedding_works where id = $1', [
          expired.id,
        ])
      ).rows[0].state,
    ).toBe('LEASED');
    await closeWorkers();
  });

  it('활성화 commit부터 실제 큐·consumer·게시·정산까지 연결되고 재전달은 추가 호출하지 않는다', async () => {
    const apiConfig = harness.app.get(ConfigService);
    const configured = approveEmbeddingPolicy({
      ...geminiFreePolicy(),
      provider: 'fixture-no-network',
      policyVersion: 'fixture-consent',
    });
    const previous = apiConfig.get('embeddingPolicy');
    const provider = vi.fn(async (texts: string[]) => {
      const { rows } = await harness.pool.query(
        "select count(*)::int as n from indexing_embedding_works where state = 'CALLING' and config_fingerprint = $1",
        [configured.fingerprint],
      );

      expect(rows[0].n).toBe(1);

      return { vectors: texts.map(() => Array.from({ length: 1536 }, () => 0.5)), tokens: 2 };
    });
    const config = new ConfigService({
      databaseUrl: apiConfig.getOrThrow<string>('databaseUrl'),
      redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      geminiApiKey: 'fixture-no-network',
      embeddingPolicy: configured,
      embeddingConfigFingerprint: configured.fingerprint,
    });

    apiConfig.set('embeddingPolicy', configured);

    try {
      const material = await harness.app.get(MaterialsService).create(ownerId, {
        idempotencyKey: randomUUID(),
        body: '큐부터 벡터까지 연결하는 공개 합성 자료',
      });
      const activation = harness.app.get(EmbeddingActivationService);
      const preview = await activation.preview(ownerId);
      const receipt = await activation.activate(ownerId, {
        requestId: randomUUID(),
        configFingerprint: configured.fingerprint,
        policyVersion: configured.policyVersion,
        expectedConsentEpoch: preview.consentEpoch,
        accepted: true,
        targets: [{ materialId: material.id, revisionId: material.revisionId }],
      });
      const workId = receipt.workIds[0];

      if (!workId) {
        throw new Error('게시할 합성 work가 없습니다.');
      }

      const job = await queue.getJob(workId);

      expect(job?.data).toEqual({ workId });
      expect(await job?.getState()).toBe('waiting');
      const activeWorker = await Test.createTestingModule({ imports: [WorkerModule] })
        .overrideProvider(ConfigService)
        .useValue(config)
        .overrideProvider(GeminiEmbedding)
        .useValue({ embed: provider })
        .compile();

      workers.push(activeWorker);
      await activeWorker.init();
      expect(await job?.waitUntilFinished(events, 10000)).toBe('claimed');
      expect(
        (
          await harness.pool.query(
            `select w.state, r.state as reservation_state, r.settled_amount::text as amount,
         (select count(*)::int from indexing_embedding_vectors v where v.work_id = w.id) as vectors
         from indexing_embedding_works w join usage_embedding_reservations r on r.id = w.reservation_id
         where w.id = $1`,
            [workId],
          )
        ).rows[0],
      ).toEqual({ state: 'PUBLISHED', reservation_state: 'settled', amount: '400', vectors: 1 });
      const duplicate = await queue.add(CLAIM_EMBEDDING_WORK, { workId });

      expect(await duplicate.waitUntilFinished(events, 10000)).toBe('not-claimable');
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      await closeWorkers();
      apiConfig.set('embeddingPolicy', previous ?? null);
    }
  });

  it('DB 제약은 다른 owner의 intent 결합과 활성 generation 중복을 막는다', async () => {
    const { id } = await seedWork();

    await expect(
      harness.pool.query('update indexing_embedding_works set owner_id = $2 where id = $1', [
        id,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      harness.pool.query(
        'insert into indexing_embedding_works (id, owner_id, intent_id, config_fingerprint, consent_epoch, generation, activation_id) select $2, owner_id, intent_id, config_fingerprint, consent_epoch, generation + 1, activation_id from indexing_embedding_works where id = $1',
        [id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('DB 실패 원문은 BullMQ failedReason과 stacktrace에 저장하지 않는다', async () => {
    const { id } = await seedWork();

    await harness.pool
      .query(`create function fail_claim_fixture() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_SQL_BODY'; end $$;
      create trigger fail_claim_fixture before update on indexing_embedding_works for each row execute function fail_claim_fixture()`);

    try {
      await startWorker();
      const job = await queue.add(CLAIM_EMBEDDING_WORK, { workId: id });

      await expect(job.waitUntilFinished(events, 10000)).rejects.toThrow(
        '작업 claim을 저장하지 못했습니다.',
      );
      const failed = await queue.getJob(job.id ?? '');

      expect(JSON.stringify([failed?.failedReason, failed?.stacktrace])).not.toContain(
        'PRIVATE_SQL_BODY',
      );
      expect(
        (await harness.pool.query('select state from indexing_embedding_works where id = $1', [id]))
          .rows[0].state,
      ).toBe('PENDING');
    } finally {
      await closeWorkers();
      await harness.pool.query(
        'drop trigger fail_claim_fixture on indexing_embedding_works; drop function fail_claim_fixture()',
      );
    }
  });

  it('DB 조회 실패를 큐 실패와 구분하고 원본 오류 없이 work를 보존한다', async () => {
    const { id } = await seedWork();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      await harness.pool.query(
        'alter table indexing_embedding_works rename to unavailable_works_fixture',
      );

      try {
        expect(await harness.app.get(EmbeddingDeliveryService).deliver(ownerId, id)).toBe(false);
        expect(warning.mock.calls).toEqual([['작업 전달 가능 여부를 DB에서 확인하지 못했습니다.']]);
        expect(await queue.getJob(id)).toBeUndefined();
      } finally {
        await harness.pool.query(
          'alter table unavailable_works_fixture rename to indexing_embedding_works',
        );
      }

      expect(
        (await harness.pool.query('select state from indexing_embedding_works where id = $1', [id]))
          .rows[0].state,
      ).toBe('PENDING');
    } finally {
      warning.mockRestore();
    }
  });

  it('DB claim 뒤 Redis ack가 중단되어도 종료 유예 후 worker가 닫히고 lease는 보존된다', async () => {
    const { id } = await seedWork();
    const blocker = await harness.pool.connect();
    const admin = connection.duplicate({
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
    });
    const warning = vi.spyOn(workerLogger, 'warn').mockImplementation(() => {});
    const failures: unknown[] = [];
    let closing: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    admin.on('error', () => {});

    try {
      // pause 뒤 새 연결을 열면 handshake도 대기하므로 관리 연결을 미리 준비한다.
      await admin.connect();
      const blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]?.pid;

      expect(blockerPid).toBeTypeOf('number');
      await blocker.query('begin');
      await blocker.query('select id from indexing_embedding_works where id = $1 for update', [id]);
      await startWorker();
      await queue.add(CLAIM_EMBEDDING_WORK, { workId: id });
      await vi.waitFor(
        async () => {
          const waiting = await harness.pool.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
             where application_name = 'devfootnote-worker'
               and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`,
            [blockerPid],
          );

          expect(waiting.rows[0]?.n).toBe(1);
        },
        { timeout: 600, interval: 10 },
      );

      // claim의 PG 잠금 대기 뒤 ack Lua를 포함한 쓰기를 멈춘다.
      // ALL은 정리용 관리 명령까지 막으므로 UNPAUSE가 가능한 WRITE만 차단한다.
      expect(await admin.call('CLIENT', 'PAUSE', '15000', 'WRITE')).toBe('OK');
      await blocker.query('rollback');
      await vi.waitFor(
        async () => {
          const result = await harness.pool.query(
            'select state from indexing_embedding_works where id = $1',
            [id],
          );

          expect(result.rows[0]?.state).toBe('LEASED');
        },
        { timeout: 2000, interval: 10 },
      );
      const lease = await harness.pool.query(
        'select state, lease_token, lease_expires_at from indexing_embedding_works where id = $1',
        [id],
      );

      closing = closeWorkers();
      await Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Worker 종료가 8초를 초과했습니다.')), 8000);
        }),
      ]);
      expect(warning).toHaveBeenCalledWith('Worker 종료 유예 시간이 지나 전달 확인을 중단합니다.');
      expect(
        (
          await harness.pool.query(
            'select state, lease_token, lease_expires_at from indexing_embedding_works where id = $1',
            [id],
          )
        ).rows,
      ).toEqual(lease.rows);
    } catch (error) {
      failures.push(error);
    } finally {
      if (deadline) {
        clearTimeout(deadline);
      }

      // 관측 연결의 대기 명령과 분리한 관리 연결로 먼저 pause를 해제한다.
      for (const cleanup of [
        async () => {
          try {
            expect(await admin.call('CLIENT', 'UNPAUSE')).toBe('OK');
          } finally {
            admin.disconnect();
          }
        },
        async () => {
          try {
            await blocker.query('rollback');
          } finally {
            blocker.release();
          }
        },
        async () => {
          await closing;
          await closeWorkers();
        },
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }

      warning.mockRestore();
    }

    if (failures.length) {
      throw new AggregateError(failures, 'Redis ack 중단 중 worker 종료 검증에 실패했습니다.', {
        cause: failures[0],
      });
    }
  });

  it('Redis 중단에도 자료 저장·읽기·keyword·ready는 유지하고 work는 PENDING으로 남긴다', async () => {
    // 마지막 장애 검사는 Redis를 기다리는 테스트 관측 연결부터 닫는다.
    await events.close();
    await queue.close();
    connection.disconnect();
    await redis.stop();
    const { id, material } = await seedWork();

    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      expect(await harness.app.get(EmbeddingDeliveryService).deliver(ownerId, id)).toBe(false);
      expect(warning).toHaveBeenCalledWith('작업 claim을 큐에 전달하지 못했습니다.');
      expect(warning).not.toHaveBeenCalledWith('작업 전달 가능 여부를 DB에서 확인하지 못했습니다.');
    } finally {
      warning.mockRestore();
    }

    await request(harness.app.getHttpServer()).get('/api/v1/health/ready').expect(200);
    await request(harness.app.getHttpServer())
      .get(`/api/v1/materials/${material.id}`)
      .set('Cookie', access)
      .expect(200);
    await request(harness.app.getHttpServer())
      .get('/api/v1/search')
      .query({ q: 'PostgreSQL' })
      .set('Cookie', access)
      .expect(200);
    expect(
      (await harness.pool.query('select state from indexing_embedding_works where id = $1', [id]))
        .rows[0].state,
    ).toBe('PENDING');
    const fresh = await startAuthHarness(undefined, 0, process.env.REDIS_URL);

    try {
      await request(fresh.app.getHttpServer()).get('/api/v1/health/ready').expect(200);
      const tokens = await fresh.auth.completeLogin(GOOGLE_SUBJECT_A);

      await request(fresh.app.getHttpServer())
        .get('/api/v1/materials')
        .set('Cookie', `devfootnote_access=${tokens.access}`)
        .expect(200);
    } finally {
      await fresh.close();
    }
  });

  it('Redis에 처음부터 연결하지 못한 worker도 SIGINT와 SIGTERM으로 종료된다', async () => {
    // 앞의 장애 검사와 별개로, 이 검사의 Redis도 명시적으로 중단한다.
    await events.close();
    await queue.close();
    connection.disconnect();
    await redis.stop();

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
        // env 파일은 읽지 않고 격리 harness 설정만 사용한다. 실제 AI 호출은 차단한다.
        env: { ...process.env, GEMINI_API_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = once(child, 'exit');
      let unavailable = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;

      child.stdout.on('data', (data: Buffer) => {
        unavailable ||= data.toString().includes('Worker Redis 연결을 확인하지 못했습니다.');
      });
      child.stderr.resume();

      try {
        await vi.waitFor(() => expect(unavailable).toBe(true), { timeout: 5000 });
        child.kill(signal);
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error('Worker 종료가 8초를 초과했습니다.')),
              8000,
            );
          }),
        ]);
        expect(child.signalCode).toBe(signal);
      } finally {
        if (deadline) {
          clearTimeout(deadline);
        }

        // 회귀로 종료가 막혀도 이 테스트가 시작한 프로세스는 반드시 회수한다.
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }

        await exited;
      }
    }
  }, 30000);
});
