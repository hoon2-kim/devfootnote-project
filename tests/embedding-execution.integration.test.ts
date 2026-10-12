import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingPolicy } from '../apps/api/dist/modules/usage-retention/index.js';
import type { EmbeddingCallFailure } from '../apps/worker/dist/modules/indexing/embedding-execution.types.js';
import { startAuthHarness } from './auth-harness.js';
import { GOOGLE_SUBJECT_A, GOOGLE_SUBJECT_B } from './auth-environment.js';

const requireFixture = createRequire(resolve('tests/embedding-execution.integration.test.ts'));
const { MaterialsService }: typeof import('../apps/api/dist/modules/materials/index.js') =
  requireFixture('../apps/api/dist/modules/materials/index.js');
const { EmbeddingActivationService }: typeof import('../apps/api/dist/modules/indexing/index.js') =
  requireFixture('../apps/api/dist/modules/indexing/index.js');
const { UsageService }: typeof import('../apps/api/dist/modules/usage-retention/index.js') =
  requireFixture('../apps/api/dist/modules/usage-retention/index.js');
const {
  TransactionsModule,
}: typeof import('../apps/worker/dist/infrastructure/database/transactions.module.js') =
  requireFixture('../apps/worker/dist/infrastructure/database/transactions.module.js');
const {
  DatabaseModule,
}: typeof import('../apps/worker/dist/infrastructure/database/database.module.js') = requireFixture(
  '../apps/worker/dist/infrastructure/database/database.module.js',
);
const { MaterialsModule }: typeof import('../apps/worker/dist/modules/materials/index.js') =
  requireFixture('../apps/worker/dist/modules/materials/index.js');
const {
  UsageRetentionModule,
  WorkerUsageService,
}: typeof import('../apps/worker/dist/modules/usage-retention/index.js') = requireFixture(
  '../apps/worker/dist/modules/usage-retention/index.js',
);
const {
  EmbeddingWorkRepository,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-work.repository.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-work.repository.js');
const {
  EmbeddingExecutionService,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-execution.service.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-execution.service.js');
const {
  EmbeddingProcessorService,
}: typeof import('../apps/worker/dist/modules/indexing/embedding-processor.service.js') =
  requireFixture('../apps/worker/dist/modules/indexing/embedding-processor.service.js');
const { GeminiEmbedding, EmbeddingProviderError }: typeof import('@devfootnote/ai') =
  requireFixture('@devfootnote/ai');

// 실제 provider·가격 승인이 아니다. 큐 없이 호출 전후 DB 전이만 검증하는 합성 설정이다.
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
  budgetId: '00000000-0000-4000-8000-000000000100',
  budgetLimit: '1000',
  periodStart: '2020-01-01T00:00:00.000Z',
  periodEnd: '2100-01-01T00:00:00.000Z',
  reservationSeconds: 600,
};

describe('embedding 실행·복구 / 실제 PostgreSQL, 외부 provider 없음', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let worker: TestingModule;
  let settings: ConfigService;
  let ownerId: string;
  let execution: InstanceType<typeof EmbeddingExecutionService>;
  let repository: InstanceType<typeof EmbeddingWorkRepository>;
  let activation: InstanceType<typeof EmbeddingActivationService>;

  async function seedWork() {
    const material = await harness.app.get(MaterialsService).create(ownerId, {
      idempotencyKey: randomUUID(),
      body: '실행·재시도·복구를 확인하는 원문',
    });
    const preview = await activation.preview(ownerId);

    if (!preview.policy) {
      throw new Error('테스트 활성화 설정이 없습니다.');
    }

    const activated = await activation.activate(ownerId, {
      requestId: randomUUID(),
      configFingerprint: preview.policy.fingerprint,
      policyVersion: policy.policyVersion,
      expectedConsentEpoch: preview.consentEpoch,
      accepted: true,
      targets: [{ materialId: material.id, revisionId: material.revisionId }],
    });
    const [workId] = activated.workIds;

    if (!workId) {
      throw new Error('활성화된 work가 없습니다.');
    }

    return { workId, material };
  }

  async function claim(workId: string) {
    expect(await repository.claim(workId)).toBe(true);
    const work = await repository.snapshot(workId);

    if (!work?.leaseToken) {
      throw new Error('claim한 작업에 lease token이 없습니다.');
    }

    return work.leaseToken;
  }

  async function start(workId: string, leaseToken: string) {
    const attempt = await execution.startAttempt(workId, leaseToken);

    if (!attempt) {
      throw new Error('호출 준비가 거절됐습니다.');
    }

    return attempt;
  }

  async function effects(workId: string) {
    const { rows } = await harness.pool.query(
      `select w.state, w.attempt_count, w.last_failure, w.lease_token,
        r.state as reservation_state, r.exposure_started_at is not null as exposed,
        (select count(*)::int from indexing_embedding_attempts a where a.work_id = w.id) as attempts
       from indexing_embedding_works w
       left join usage_embedding_reservations r on r.id = w.reservation_id
       where w.id = $1`,
      [workId],
    );

    return rows[0];
  }

  function publicationPolicy(pricePerToken = '200') {
    harness.app.get(ConfigService).set('embeddingPolicy', {
      ...policy,
      dimensions: 1536,
      unitScale: 1_000_000_000,
      maximumPerChunk: '8192000',
      pricePerToken,
      budgetLimit: '1000000000',
    });
    settings.set(
      'embeddingConfigFingerprint',
      harness.app.get(UsageService).configuration()?.fingerprint,
    );
  }

  async function publicationResult(revisionId: string) {
    const { rows } = await harness.pool.query<{ id: string }>(
      'select id from material_chunks where revision_id = $1 order by ordinal',
      [revisionId],
    );

    return {
      configFingerprint: settings.getOrThrow<string>('embeddingConfigFingerprint'),
      tokens: 1,
      vectors: rows.map(({ id }) => ({
        chunkId: id,
        values: Array.from({ length: 1536 }, () => 0.5),
      })),
    };
  }

  async function publicationEffects(workId: string) {
    return (
      await harness.pool.query(
        `select w.state, r.state as reservation_state,
      r.settled_amount::text as settled_amount,
      (select count(*)::int from indexing_embedding_vectors v where v.work_id = w.id) as vectors,
      (select count(*)::int from usage_embedding_call_receipts c where c.reservation_id = r.id) as calls
      from indexing_embedding_works w join usage_embedding_reservations r on r.id = w.reservation_id
      where w.id = $1`,
        [workId],
      )
    ).rows[0];
  }

  async function expireLease(workId: string) {
    await harness.pool.query(
      "update indexing_embedding_works set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [workId],
    );
  }

  async function expireReservation(workId: string) {
    await harness.pool.query(
      `update usage_embedding_reservations
       set created_at = clock_timestamp() - interval '2 hours',
           expires_at = clock_timestamp() - interval '1 hour'
       where id = (select reservation_id from indexing_embedding_works where id = $1)`,
      [workId],
    );
  }

  async function makeRetryDue(workId: string) {
    await harness.pool.query(
      "update indexing_embedding_works set next_attempt_at = clock_timestamp() - interval '1 second' where id = $1",
      [workId],
    );
    expect(await execution.recover(workId)).toBe('pending');
  }

  async function atWorkBarrier<T>(workId: string, operations: () => Promise<T>[]) {
    const blocker = await harness.pool.connect();
    let pending = Promise.resolve<PromiseSettledResult<T>[]>([]);
    const failures: unknown[] = [];

    try {
      await blocker.query('begin');
      await blocker.query('select id from indexing_embedding_works where id = $1 for update', [
        workId,
      ]);
      pending = Promise.allSettled(operations());
      await vi.waitFor(
        async () => {
          const { rows } = await harness.pool.query(`select count(*)::int as count
            from pg_stat_activity where datname = current_database()
              and application_name = 'devfootnote-worker' and wait_event_type = 'Lock'`);

          expect(rows[0].count).toBe(2);
        },
        { timeout: 800, interval: 10 },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await blocker.query('rollback');
      } catch (error) {
        failures.push(error);
      } finally {
        blocker.release();
        await pending;
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, '실행 경쟁 barrier 확인에 실패했습니다.');
    }

    return (await pending).map((result) => {
      if (result.status === 'rejected') {
        throw result.reason;
      }

      return result.value;
    });
  }

  beforeAll(async () => {
    harness = await startAuthHarness();
    const apiSettings = harness.app.get(ConfigService);

    apiSettings.set('redisUrl', null);
    apiSettings.set('embeddingPolicy', policy);
    settings = new ConfigService({
      databaseUrl: apiSettings.getOrThrow<string>('databaseUrl'),
      embeddingConfigFingerprint: harness.app.get(UsageService).configuration()?.fingerprint,
    });
    worker = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        DatabaseModule,
        TransactionsModule,
        MaterialsModule,
        UsageRetentionModule,
      ],
      providers: [
        EmbeddingExecutionService,
        EmbeddingWorkRepository,
        EmbeddingProcessorService,
        { provide: GeminiEmbedding, useValue: new GeminiEmbedding('fixture-no-network') },
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(settings)
      .compile();
    await worker.init();
    execution = worker.get(EmbeddingExecutionService);
    repository = worker.get(EmbeddingWorkRepository);
    activation = harness.app.get(EmbeddingActivationService);
  });

  afterAll(async () => {
    try {
      await worker?.close();
    } finally {
      await harness?.close();
    }
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    settings.set('geminiApiKey', 'fixture-no-network');
    await harness.pool.query(
      'truncate answer_call_attempts, answer_requests, usage_answer_consents, indexing_embedding_vectors, usage_embedding_call_receipts, auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_works, indexing_embedding_attempts, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations',
    );
    harness.app.get(ConfigService).set('embeddingPolicy', policy);
    settings.set(
      'embeddingConfigFingerprint',
      harness.app.get(UsageService).configuration()?.fingerprint,
    );
    await harness.auth.completeLogin(GOOGLE_SUBJECT_A);
    ownerId = (await harness.pool.query('select id from accounts')).rows[0].id;
  });

  it('worker는 STARTED commit 뒤 잠금 없이 제공자를 호출하고 게시·정산을 마친다', async () => {
    publicationPolicy();
    const { workId } = await seedWork();
    const token = await claim(workId);
    const provider = vi
      .spyOn(worker.get(GeminiEmbedding), 'embed')
      .mockImplementation(async (texts, purpose) => {
        expect(purpose).toBe('document');
        expect(texts).toEqual(['실행·재시도·복구를 확인하는 원문']);
        expect(await effects(workId)).toMatchObject({
          state: 'CALLING',
          attempts: 1,
          exposed: true,
        });
        const { rows } = await harness.pool.query(
          "select count(*)::int as count from pg_stat_activity where application_name = 'devfootnote-worker' and state = 'idle in transaction'",
        );

        expect(rows[0].count).toBe(0);

        return { vectors: texts.map(() => Array.from({ length: 1536 }, () => 0.5)), tokens: 2 };
      });

    await worker
      .get(EmbeddingProcessorService)
      .process(workId, token, new AbortController().signal);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await publicationEffects(workId)).toMatchObject({
      state: 'PUBLISHED',
      vectors: 1,
      calls: 1,
      settled_amount: '400',
    });
  });

  it.each([
    {
      kind: 'request_rejected' as const,
      state: 'FINAL_FAILED',
      failure: 'rate_limited',
      reason: '무료 할당량 제한',
    },
    {
      kind: 'access_denied' as const,
      state: 'FINAL_FAILED',
      failure: 'access_denied',
      reason: '키 권한 거부',
    },
    {
      kind: 'provider_error' as const,
      state: 'RETRY_WAIT',
      failure: 'provider_error',
      reason: '제공자 일시 장애',
    },
  ])(
    '$reason 결과를 DB에 기록하고 같은 전달 안에서 재호출하지 않는다',
    async ({ kind, state, failure }) => {
      publicationPolicy();
      const { workId } = await seedWork();
      const token = await claim(workId);
      const provider = vi
        .spyOn(worker.get(GeminiEmbedding), 'embed')
        .mockRejectedValue(new EmbeddingProviderError(kind));

      await worker
        .get(EmbeddingProcessorService)
        .process(workId, token, new AbortController().signal);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(await effects(workId)).toMatchObject({ state, attempts: 1 });
      const { rows } = await harness.pool.query(
        'select last_failure from indexing_embedding_works where id = $1',
        [workId],
      );

      expect(rows[0]?.last_failure).toBe(failure);
      expect((await publicationEffects(workId)).vectors).toBe(0);
    },
  );

  it('철회·잘못된 lease와 키 없는 실행은 외부 호출을 만들지 않는다', async () => {
    publicationPolicy();
    const { workId } = await seedWork();
    const token = await claim(workId);
    const provider = vi.spyOn(worker.get(GeminiEmbedding), 'embed');
    const processor = worker.get(EmbeddingProcessorService);

    await processor.process(workId, randomUUID(), new AbortController().signal);
    settings.set('geminiApiKey', '');
    await processor.process(workId, token, new AbortController().signal);
    settings.set('geminiApiKey', 'fixture-no-network');
    const consent = await harness.app.get(UsageService).consent(ownerId);

    await activation.revoke(ownerId, consent.epoch);
    await processor.process(workId, token, new AbortController().signal);
    expect(provider).not.toHaveBeenCalled();
    expect(await effects(workId)).toMatchObject({ state: 'OBSOLETE', attempts: 0 });
  });

  it('메타데이터만 바뀐 같은 자료는 새 chunk에 벡터를 재사용하고 호출·노출·비용은 추가하지 않는다', async () => {
    publicationPolicy();
    const { workId, material } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);

    await execution.completeAttempt(
      workId,
      token,
      attempt.attemptId,
      await publicationResult(material.revisionId),
    );
    const current = await harness.app.get(MaterialsService).read(ownerId, material.id);
    const updated = await harness.app.get(MaterialsService).update(ownerId, material.id, {
      idempotencyKey: randomUUID(),
      expectedRevisionId: material.revisionId,
      body: current.body,
      title: '제목만 수정',
    });
    const preview = await activation.preview(ownerId);

    if (!preview.policy) {
      throw new Error('테스트 설정 누락');
    }

    const next = await activation.activate(ownerId, {
      requestId: randomUUID(),
      configFingerprint: preview.policy.fingerprint,
      policyVersion: preview.policy.policyVersion,
      expectedConsentEpoch: preview.consentEpoch,
      accepted: true,
      targets: [{ materialId: material.id, revisionId: updated.revisionId }],
    });
    const nextId = next.workIds[0];

    if (!nextId) {
      throw new Error('재사용 작업 누락');
    }

    const nextToken = await claim(nextId);
    const provider = vi.spyOn(worker.get(GeminiEmbedding), 'embed');

    await worker
      .get(EmbeddingProcessorService)
      .process(nextId, nextToken, new AbortController().signal);
    expect(provider).not.toHaveBeenCalled();
    expect(await effects(nextId)).toMatchObject({
      state: 'PUBLISHED',
      attempts: 0,
      exposed: false,
    });
    expect(await publicationEffects(nextId)).toMatchObject({
      vectors: 1,
      calls: 0,
      settled_amount: '0',
    });
  });

  it.each([
    { table: 'indexing_embedding_attempts', step: '시도 기록' },
    { table: 'usage_embedding_reservations', step: '비용 예약' },
  ])(
    '$step SQL 실패 시 호출 상태 전환·시도 기록·비용 노출 기록을 모두 취소한다',
    async ({ table }) => {
      const { workId } = await seedWork();
      const token = await claim(workId);

      await harness.pool.query(`create function fail_execution_fixture() returns trigger
        language plpgsql as $$ begin raise exception 'PRIVATE_EXECUTION_BODY'; end $$;
        create trigger fail_execution_fixture before insert or update on ${table}
        for each row execute function fail_execution_fixture()`);

      try {
        await expect(execution.startAttempt(workId, token)).rejects.toThrow(
          '임베딩 실행 시작에 실패했습니다.',
        );
        expect(await effects(workId)).toEqual({
          state: 'LEASED',
          attempt_count: 0,
          last_failure: null,
          lease_token: token,
          reservation_state: 'reserved',
          exposed: false,
          attempts: 0,
        });
      } finally {
        await harness.pool.query(
          `drop trigger fail_execution_fixture on ${table}; drop function fail_execution_fixture()`,
        );
      }
    },
  );

  it('동시 시작은 실제 잠금에서 경쟁해 attempt·비용 노출을 한 번만 확정한다', async () => {
    const { workId } = await seedWork();
    const token = await claim(workId);

    expect(await execution.startAttempt(workId, randomUUID())).toBeNull();
    const results = await atWorkBarrier(workId, () => [
      execution.startAttempt(workId, token),
      execution.startAttempt(workId, token),
    ]);

    expect(results.filter((result) => result !== null)).toEqual([
      { attemptId: expect.any(String), number: 1 },
    ]);
    expect(await effects(workId)).toMatchObject({
      state: 'CALLING',
      attempt_count: 1,
      attempts: 1,
      exposed: true,
      lease_token: token,
    });
  });

  it('미확정 노출을 가진 worker와 다른 owner의 예산 admission은 같은 예산 행에서 직렬화한다', async () => {
    harness.app.get(ConfigService).set('embeddingPolicy', { ...policy, budgetLimit: '10' });
    settings.set(
      'embeddingConfigFingerprint',
      harness.app.get(UsageService).configuration()?.fingerprint,
    );
    const { workId } = await seedWork();
    const token = await claim(workId);

    await harness.auth.completeLogin(GOOGLE_SUBJECT_B);
    const otherOwner = (
      await harness.pool.query<{ id: string }>('select id from accounts where id <> $1', [ownerId])
    ).rows[0]?.id;

    if (!otherOwner) {
      throw new Error('예산 경쟁에 참여할 다른 계정이 없습니다.');
    }

    const otherMaterial = await harness.app.get(MaterialsService).create(otherOwner, {
      idempotencyKey: randomUUID(),
      body: '다른 사용자의 활성화 대상',
    });
    const preview = await activation.preview(otherOwner);

    if (!preview.policy) {
      throw new Error('예산 경쟁 fixture의 설정이 없습니다.');
    }

    const input = {
      requestId: randomUUID(),
      configFingerprint: preview.policy.fingerprint,
      policyVersion: policy.policyVersion,
      expectedConsentEpoch: preview.consentEpoch,
      accepted: true,
      targets: [{ materialId: otherMaterial.id, revisionId: otherMaterial.revisionId }],
    };
    const blocker = await harness.pool.connect();
    let pendingStart = Promise.resolve<PromiseSettledResult<unknown>[]>([]);
    let pendingAdmission = Promise.resolve<PromiseSettledResult<unknown>[]>([]);
    const failures: unknown[] = [];

    try {
      // 노출 UPDATE 이후 COMMIT 전에 멈춘다. 제품 메서드나 DB 시계를 mock하지 않는다.
      await harness.pool.query(`create function hold_exposure_fixture() returns trigger
        language plpgsql as $$ begin perform pg_advisory_xact_lock(72104, 1); return new; end $$;
        create trigger hold_exposure_fixture after update of exposure_started_at
        on usage_embedding_reservations for each row
        when (old.exposure_started_at is null and new.exposure_started_at is not null)
        execute function hold_exposure_fixture()`);
      const { rows: blockerRows } = await blocker.query(
        'select pg_backend_pid() as pid, pg_advisory_lock(72104, 1)',
      );

      pendingStart = Promise.allSettled([execution.startAttempt(workId, token)]);
      let workerPid = 0;

      await vi.waitFor(
        async () => {
          const { rows } = await harness.pool.query<{ pid: number }>(
            `select pid from pg_stat_activity where datname = current_database()
              and application_name = 'devfootnote-worker' and wait_event_type = 'Lock'
              and $1::integer = any(pg_blocking_pids(pid))`,
            [blockerRows[0].pid],
          );

          expect(rows).toHaveLength(1);
          workerPid = rows[0]?.pid ?? 0;
        },
        { timeout: 800, interval: 10 },
      );
      expect(await effects(workId)).toMatchObject({ state: 'LEASED', attempts: 0, exposed: false });
      pendingAdmission = Promise.allSettled([activation.activate(otherOwner, input)]);
      await vi.waitFor(
        async () => {
          const { rows } = await harness.pool.query(
            `select count(*)::int as count
             from pg_stat_activity where datname = current_database()
               and application_name = 'devfootnote' and wait_event_type = 'Lock'
               and query like '%usage_embedding_budgets%'
               and $1::integer = any(pg_blocking_pids(pid))`,
            [workerPid],
          );

          expect(rows[0].count).toBe(1);
        },
        { timeout: 800, interval: 10 },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await blocker.query('select pg_advisory_unlock(72104, 1)');
      } catch (error) {
        failures.push(error);
      } finally {
        blocker.release();
        await Promise.all([pendingStart, pendingAdmission]);

        try {
          await harness.pool.query(`drop trigger if exists hold_exposure_fixture
            on usage_embedding_reservations; drop function if exists hold_exposure_fixture()`);
        } catch (error) {
          failures.push(error);
        }
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, '호출 노출과 공유 예산 잠금 검증에 실패했습니다.');
    }

    expect(await pendingStart).toEqual([
      { status: 'fulfilled', value: { attemptId: expect.any(String), number: 1 } },
    ]);
    expect(await pendingAdmission).toMatchObject([
      { status: 'rejected', reason: { kind: 'budget_exhausted' } },
    ]);
    expect(await effects(workId)).toMatchObject({
      state: 'CALLING',
      attempt_count: 1,
      attempts: 1,
      exposed: true,
      reservation_state: 'reserved',
    });
    const { rows } = await harness.pool.query(
      `select
        (select count(*)::int from usage_embedding_reservations) as reservations,
        (select count(*)::int from indexing_embedding_works) as works,
        (select count(*)::int from indexing_activation_receipts) as receipts,
        (select count(*)::int from usage_embedding_consents where owner_id = $1) as other_consents`,
      [otherOwner],
    );

    expect(rows).toEqual([{ reservations: 1, works: 1, receipts: 1, other_consents: 0 }]);
  });

  it('호출 준비가 반환되면 별도 연결에서 STARTED·노출이 보이고 열린 worker transaction은 없다', async () => {
    const { workId } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);
    let complete!: (failure: EmbeddingCallFailure) => void;
    const providerResponse = new Promise<EmbeddingCallFailure>((resolve) => {
      complete = resolve;
    });
    const fakeProvider = vi.fn(() => providerResponse);
    // 실제 provider adapter는 다음 단계다. 준비 commit과 지연된 외부 결과 사이만 재현한다.
    const pending = fakeProvider().then((failure) =>
      execution.failAttempt(workId, token, attempt.attemptId, failure),
    );

    try {
      expect(await effects(workId)).toMatchObject({
        state: 'CALLING',
        attempts: 1,
        exposed: true,
      });
      expect(
        (
          await harness.pool.query(
            'select outcome, finished_at from indexing_embedding_attempts where id = $1',
            [attempt.attemptId],
          )
        ).rows,
      ).toEqual([{ outcome: 'STARTED', finished_at: null }]);
      const { rows } = await harness.pool.query(`select count(*)::int as count
        from pg_stat_activity where datname = current_database()
          and application_name = 'devfootnote-worker' and xact_start is not null`);

      expect(rows[0].count).toBe(0);
      expect(fakeProvider).toHaveBeenCalledTimes(1);
    } finally {
      complete('timeout');
      await pending;
    }

    expect(await pending).toBe('retry_wait');
  });

  it.each([
    { failure: 'rate_limited', reason: '요청 제한' },
    { failure: 'timeout', reason: '시간 초과' },
    { failure: 'provider_error', reason: '제공자 오류' },
  ] as const)(
    '$reason 발생 시 DB에 기록한 대기 간격으로 최대 다섯 번 시도하고 종료된 작업은 재시도하지 않는다',
    async ({ failure }) => {
      const { workId } = await seedWork();

      for (let number = 1; number <= 5; number++) {
        const token = await claim(workId);
        const attempt = await start(workId, token);
        const { rows: beforeFailure } = await harness.pool.query(
          'select clock_timestamp() as observed_at',
        );

        expect(attempt.number).toBe(number);
        expect(await execution.failAttempt(workId, token, attempt.attemptId, failure)).toBe(
          number < 5 ? 'retry_wait' : 'final_failed',
        );
        const { rows } = await harness.pool.query(
          `select a.outcome, a.failure, a.finished_at is not null as finished,
             w.next_attempt_at >= $2::timestamptz as retry_not_before_failure,
             extract(epoch from (w.next_attempt_at - a.finished_at)) * 1000 as delay_ms
           from indexing_embedding_attempts a
           join indexing_embedding_works w on w.id = a.work_id where a.id = $1`,
          [attempt.attemptId, beforeFailure[0].observed_at],
        );

        expect(rows[0]).toMatchObject({
          outcome: number < 5 ? 'RETRYABLE_FAILED' : 'FINAL_FAILED',
          failure,
          finished: true,
        });

        if (number < 5) {
          // DB에서 관찰한 실패 전 시각보다 이르지 않고, full-jitter 상한을 넘지 않는다.
          expect(rows[0].retry_not_before_failure).toBe(true);
          expect(Number(rows[0].delay_ms)).toBeLessThanOrEqual(
            Math.min(5000 * 2 ** (number - 1), 60000),
          );
          await harness.pool.query(
            "update indexing_embedding_works set next_attempt_at = clock_timestamp() + interval '1 hour' where id = $1",
            [workId],
          );
          expect(await execution.recover(workId)).toBe('waiting');
          expect(await repository.claim(workId)).toBe(false);
          await makeRetryDue(workId);
        }
      }

      expect(await effects(workId)).toMatchObject({
        state: 'FINAL_FAILED',
        attempt_count: 5,
        attempts: 5,
        last_failure: failure,
        lease_token: null,
        exposed: true,
        reservation_state: 'settled',
      });
      expect(await execution.recover(workId)).toBe('ignored');
      expect(await repository.claim(workId)).toBe(false);
    },
  );

  it('영구 실패의 동시 결과는 한 번만 확정하고 잘못된 attempt·token은 무시한다', async () => {
    const { workId } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);

    expect(await execution.failAttempt(workId, randomUUID(), attempt.attemptId, 'timeout')).toBe(
      'ignored',
    );
    expect(await execution.failAttempt(workId, token, randomUUID(), 'timeout')).toBe('ignored');
    const results = await atWorkBarrier(workId, () => [
      execution.failAttempt(workId, token, attempt.attemptId, 'invalid_response'),
      execution.failAttempt(workId, token, attempt.attemptId, 'invalid_response'),
    ]);

    expect(results.sort()).toEqual(['final_failed', 'ignored']);
    expect(await effects(workId)).toMatchObject({
      state: 'FINAL_FAILED',
      attempt_count: 1,
      attempts: 1,
      last_failure: 'invalid_response',
    });
    expect(await execution.recover(workId)).toBe('ignored');
  });

  it('heartbeat는 현재 유효 token만 갱신하고 만료 lease는 새 token으로 다시 claim한다', async () => {
    const { workId } = await seedWork();
    const token = await claim(workId);

    await harness.pool.query(
      "update indexing_embedding_works set lease_expires_at = clock_timestamp() + interval '5 seconds' where id = $1",
      [workId],
    );
    expect(await execution.heartbeat(workId, randomUUID())).toBe(false);
    expect(await execution.heartbeat(workId, token)).toBe(true);
    const { rows } = await harness.pool.query(
      `select lease_expires_at > clock_timestamp() + interval '50 seconds' as extended
       from indexing_embedding_works where id = $1`,
      [workId],
    );

    expect(rows[0].extended).toBe(true);
    await expireLease(workId);
    expect(await execution.heartbeat(workId, token)).toBe(false);
    expect(await execution.startAttempt(workId, token)).toBeNull();
    expect(await execution.recover(workId)).toBe('pending');
    const nextToken = await claim(workId);

    expect(nextToken).not.toBe(token);
    expect(await execution.startAttempt(workId, token)).toBeNull();
    expect(await execution.heartbeat(workId, token)).toBe(false);
    expect(await effects(workId)).toMatchObject({ attempts: 0, attempt_count: 0, exposed: false });
    expect((await start(workId, nextToken)).number).toBe(1);
  });

  it('CALLING lease 만료는 UNKNOWN을 남기며 늦은 결과가 다음 attempt를 바꾸지 않는다', async () => {
    const { workId } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);

    await expireLease(workId);
    expect(await execution.failAttempt(workId, token, attempt.attemptId, 'provider_error')).toBe(
      'ignored',
    );
    expect(await execution.recover(workId)).toBe('waiting');
    expect(
      (
        await harness.pool.query(
          'select outcome, failure from indexing_embedding_attempts where id = $1',
          [attempt.attemptId],
        )
      ).rows,
    ).toEqual([{ outcome: 'UNKNOWN', failure: 'lease_expired' }]);
    await makeRetryDue(workId);
    const nextToken = await claim(workId);
    const next = await start(workId, nextToken);

    expect(next.number).toBe(2);
    expect(await execution.failAttempt(workId, token, attempt.attemptId, 'invalid_response')).toBe(
      'ignored',
    );
    expect(await effects(workId)).toMatchObject({
      state: 'CALLING',
      lease_token: nextToken,
      attempts: 2,
      attempt_count: 2,
      exposed: true,
    });
  });

  it('heartbeat가 행 잠금을 기다리는 동안 만료된 lease도 되살리지 않는다', async () => {
    const { workId } = await seedWork();
    const token = await claim(workId);
    const blocker = await harness.pool.connect();
    let pending: Promise<PromiseSettledResult<boolean>[]> = Promise.resolve([]);
    const failures: unknown[] = [];

    try {
      await blocker.query('begin');
      await blocker.query('select id from indexing_embedding_works where id = $1 for update', [
        workId,
      ]);
      pending = Promise.allSettled([execution.heartbeat(workId, token)]);
      await vi.waitFor(
        async () => {
          const { rows } = await harness.pool.query(`select count(*)::int as count
            from pg_stat_activity where datname = current_database()
              and application_name = 'devfootnote-worker' and wait_event_type = 'Lock'`);

          expect(rows[0].count).toBe(1);
        },
        { timeout: 800, interval: 10 },
      );
      await blocker.query(
        "update indexing_embedding_works set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1",
        [workId],
      );
      await blocker.query('commit');
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await blocker.query('rollback');
      } catch (error) {
        failures.push(error);
      } finally {
        blocker.release();
        await pending;
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, 'heartbeat 잠금·만료 검증에 실패했습니다.');
    }

    expect(await pending).toEqual([{ status: 'fulfilled', value: false }]);
    expect(await execution.recover(workId)).toBe('pending');
  });

  it('동시 성공 결과는 실제 잠금에서 경쟁해 벡터·성공 시도·비용을 한 번만 확정한다', async () => {
    publicationPolicy();
    const { workId, material } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);
    const result = await publicationResult(material.revisionId);

    expect(await execution.completeAttempt(workId, randomUUID(), attempt.attemptId, result)).toBe(
      'ignored',
    );
    expect(await execution.completeAttempt(workId, token, randomUUID(), result)).toBe('ignored');
    expect(
      await execution.completeAttempt(workId, token, attempt.attemptId, {
        ...result,
        configFingerprint: 'wrong-config',
      }),
    ).toBe('ignored');
    const results = await atWorkBarrier(workId, () => [
      execution.completeAttempt(workId, token, attempt.attemptId, result),
      execution.completeAttempt(workId, token, attempt.attemptId, result),
    ]);

    expect(results.sort()).toEqual(['ignored', 'published']);
    expect(await publicationEffects(workId)).toEqual({
      state: 'PUBLISHED',
      reservation_state: 'settled',
      settled_amount: '200',
      vectors: 1,
      calls: 1,
    });
    expect(
      (
        await harness.pool.query('select outcome from indexing_embedding_attempts where id = $1', [
          attempt.attemptId,
        ])
      ).rows,
    ).toEqual([{ outcome: 'SUCCEEDED' }]);
    expect(await execution.recover(workId)).toBe('ignored');
    expect(await repository.claim(workId)).toBe(false);
  });

  it.each([
    { table: 'indexing_embedding_vectors', reason: '벡터 저장' },
    { table: 'indexing_embedding_attempts', reason: '성공 시도 확정' },
    { table: 'usage_embedding_call_receipts', reason: '호출 비용 기록' },
    { table: 'usage_embedding_reservations', reason: '예약 정산' },
  ])('$reason 실패 시 게시·비용 전체를 rollback하고 같은 응답으로 복구한다', async ({ table }) => {
    publicationPolicy();
    const { workId, material } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);
    const result = await publicationResult(material.revisionId);

    await harness.pool.query(`create function fail_publication_fixture() returns trigger
      language plpgsql as $$ begin raise exception 'PRIVATE_PUBLICATION_BODY'; end $$;
      create trigger fail_publication_fixture before insert or update on ${table}
      for each row execute function fail_publication_fixture()`);

    try {
      await expect(
        execution.completeAttempt(workId, token, attempt.attemptId, result),
      ).rejects.toThrow('임베딩 게시·정산에 실패했습니다.');
      expect(await publicationEffects(workId)).toEqual({
        state: 'CALLING',
        reservation_state: 'reserved',
        settled_amount: null,
        vectors: 0,
        calls: 0,
      });
      expect(
        (
          await harness.pool.query(
            'select outcome from indexing_embedding_attempts where id = $1',
            [attempt.attemptId],
          )
        ).rows,
      ).toEqual([{ outcome: 'STARTED' }]);
    } finally {
      await harness.pool.query(
        `drop trigger fail_publication_fixture on ${table}; drop function fail_publication_fixture()`,
      );
    }

    expect(await execution.completeAttempt(workId, token, attempt.attemptId, result)).toBe(
      'published',
    );
    expect((await publicationEffects(workId)).settled_amount).toBe('200');
  });

  it.each([
    { fault: 'dimension', reason: '잘못된 차원' },
    { fault: 'nonfinite', reason: '저장할 수 없는 수치' },
    { fault: 'zero', reason: '영벡터' },
    { fault: 'missing', reason: '빠진 chunk' },
    { fault: 'foreign', reason: '다른 chunk ID' },
  ])('$reason 결과는 게시하지 않되 확인된 사용량은 정산한다', async ({ fault }) => {
    publicationPolicy();
    const { workId, material } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);
    const result = await publicationResult(material.revisionId);
    const first = result.vectors[0];

    if (!first) {
      throw new Error('검증할 chunk가 필요합니다.');
    }

    if (fault === 'dimension') {
      first.values.pop();
    } else if (fault === 'nonfinite') {
      first.values[0] = Number.MAX_VALUE;
    } else if (fault === 'zero') {
      first.values.fill(0);
    } else if (fault === 'missing') {
      result.vectors.pop();
    } else {
      first.chunkId = randomUUID();
    }

    expect(await execution.completeAttempt(workId, token, attempt.attemptId, result)).toBe(
      'final_failed',
    );
    expect(await publicationEffects(workId)).toEqual({
      state: 'FINAL_FAILED',
      reservation_state: 'settled',
      settled_amount: '200',
      vectors: 0,
      calls: 1,
    });
  });

  it.each([
    { change: 'edit', reason: '수정' },
    { change: 'delete', reason: '삭제' },
    { change: 'revoke', reason: '동의 철회' },
    { change: 'config', reason: '설정 변경' },
  ])('호출 중 $reason 뒤 성공 응답은 비용만 정산하고 게시하지 않는다', async ({ change }) => {
    publicationPolicy();
    const { workId, material } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);
    const result = await publicationResult(material.revisionId);

    if (change === 'edit') {
      await harness.app.get(MaterialsService).update(ownerId, material.id, {
        idempotencyKey: randomUUID(),
        expectedRevisionId: material.revisionId,
        body: '바뀐 원문',
      });
    } else if (change === 'delete') {
      await harness.app.get(MaterialsService).delete(ownerId, material.id, {
        idempotencyKey: randomUUID(),
        expectedRevisionId: material.revisionId,
      });
    } else if (change === 'revoke') {
      await activation.revoke(ownerId, 1);
    } else {
      settings.set('embeddingConfigFingerprint', 'changed');
    }

    expect(await execution.completeAttempt(workId, token, attempt.attemptId, result)).toBe(
      'obsolete',
    );
    expect(await publicationEffects(workId)).toEqual({
      state: 'OBSOLETE',
      reservation_state: 'settled',
      settled_amount: '200',
      vectors: 0,
      calls: 1,
    });
  });

  it('정산은 하드코딩한 현재 단가 대신 예약 당시 단가를 사용한다', async () => {
    publicationPolicy('300');
    const { workId, material } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);
    const result = await publicationResult(material.revisionId);

    // 예약 이후 API 쪽 단가를 바꾸어도 이미 시작한 작업의 청구 근거는 바뀌지 않는다.
    harness.app.get(ConfigService).set('embeddingPolicy', { ...policy, pricePerToken: '900' });
    expect(await execution.completeAttempt(workId, token, attempt.attemptId, result)).toBe(
      'published',
    );
    expect((await publicationEffects(workId)).settled_amount).toBe('300');
  });

  it('공유 예약은 마지막 작업이 종료될 때만 사용량 합계로 정산한다', async () => {
    publicationPolicy();
    const materials = await Promise.all(
      ['첫 원문', '다음 원문'].map((body) =>
        harness.app.get(MaterialsService).create(ownerId, { idempotencyKey: randomUUID(), body }),
      ),
    );
    const preview = await activation.preview(ownerId);

    if (!preview.policy) {
      throw new Error('게시 테스트 설정이 없습니다.');
    }

    const activated = await activation.activate(ownerId, {
      requestId: randomUUID(),
      configFingerprint: preview.policy.fingerprint,
      policyVersion: policy.policyVersion,
      expectedConsentEpoch: preview.consentEpoch,
      accepted: true,
      targets: materials.map((material) => ({
        materialId: material.id,
        revisionId: material.revisionId,
      })),
    });

    for (const [index, workId] of activated.workIds.entries()) {
      const { rows } = await harness.pool.query<{ revision_id: string }>(
        'select i.revision_id from indexing_embedding_works w join embedding_intents i on i.id = w.intent_id where w.id = $1',
        [workId],
      );
      const revision = rows[0]?.revision_id;

      if (!revision) {
        throw new Error('공유 예약의 revision이 없습니다.');
      }

      const token = await claim(workId);
      const attempt = await start(workId, token);

      expect(
        await execution.completeAttempt(
          workId,
          token,
          attempt.attemptId,
          await publicationResult(revision),
        ),
      ).toBe('published');
      expect(await publicationEffects(workId)).toMatchObject(
        index === 0
          ? { reservation_state: 'reserved', settled_amount: null, calls: 1 }
          : { reservation_state: 'settled', settled_amount: '400', calls: 2 },
      );
    }

    expect(activated.workIds).toHaveLength(2);
  });

  it('응답 없는 이전 시도가 있으면 늦은 결과를 게시하지 않고 전체 예약 상한을 정산한다', async () => {
    publicationPolicy();
    const { workId, material } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);
    const result = await publicationResult(material.revisionId);

    await expireLease(workId);
    expect(await execution.completeAttempt(workId, token, attempt.attemptId, result)).toBe(
      'ignored',
    );
    expect(await execution.recover(workId)).toBe('waiting');
    await makeRetryDue(workId);
    const nextToken = await claim(workId);
    const nextAttempt = await start(workId, nextToken);

    expect(await execution.completeAttempt(workId, token, attempt.attemptId, result)).toBe(
      'ignored',
    );
    expect(await execution.completeAttempt(workId, nextToken, nextAttempt.attemptId, result)).toBe(
      'published',
    );
    expect(await publicationEffects(workId)).toEqual({
      state: 'PUBLISHED',
      reservation_state: 'settled',
      settled_amount: '8192000',
      vectors: 1,
      calls: 1,
    });
  });

  it('유효한 벡터에 사용량이 없으면 게시하되 무료로 정산하지 않는다', async () => {
    publicationPolicy();
    const { workId, material } = await seedWork();
    const token = await claim(workId);
    const attempt = await start(workId, token);
    const result = { ...(await publicationResult(material.revisionId)), tokens: null };

    expect(await execution.completeAttempt(workId, token, attempt.attemptId, result)).toBe(
      'published',
    );
    expect(await publicationEffects(workId)).toEqual({
      state: 'PUBLISHED',
      reservation_state: 'settled',
      settled_amount: '8192000',
      vectors: 1,
      calls: 1,
    });
  });

  const fenceCases = [
    { change: 'edit', failure: 'material_obsolete', state: 'OBSOLETE', reason: '자료 수정' },
    { change: 'delete', failure: 'material_obsolete', state: 'OBSOLETE', reason: '자료 삭제' },
    { change: 'revoke', failure: 'consent_revoked', state: 'OBSOLETE', reason: '동의 철회' },
    { change: 'config', failure: 'config_changed', state: 'OBSOLETE', reason: '설정 변경' },
    {
      change: 'expiry',
      failure: 'reservation_expired',
      state: 'FINAL_FAILED',
      reason: '비용 예약 만료',
    },
    {
      change: 'missing',
      failure: 'reservation_missing',
      state: 'FINAL_FAILED',
      reason: '비용 예약 누락',
    },
  ] as const;

  describe.each([
    { timing: 'before-call', step: '외부 호출 전' },
    { timing: 'during-call', step: '외부 호출 중' },
  ] as const)('$step 실행 조건 재검증', ({ timing }) => {
    it.each(fenceCases)(
      '$reason 이후에는 이전 작업을 실행하거나 재시도할 수 없다',
      async ({ change, failure, state }) => {
        const { workId, material } = await seedWork();
        const token = await claim(workId);
        const attempt = timing === 'during-call' ? await start(workId, token) : null;

        if (change === 'edit') {
          await harness.app.get(MaterialsService).update(ownerId, material.id, {
            idempotencyKey: randomUUID(),
            expectedRevisionId: material.revisionId,
            body: '새 revision의 원문',
          });
        } else if (change === 'delete') {
          await harness.app.get(MaterialsService).delete(ownerId, material.id, {
            idempotencyKey: randomUUID(),
            expectedRevisionId: material.revisionId,
          });
        } else if (change === 'revoke') {
          await activation.revoke(ownerId, 1);
        } else if (change === 'config') {
          settings.set('embeddingConfigFingerprint', 'f'.repeat(64));
        } else if (change === 'expiry') {
          await expireReservation(workId);
        } else {
          // 예전 claim-only work는 예약 FK가 nullable이다. 이 경로도 호출 허가로 해석하지 않는다.
          await harness.pool.query(
            'update indexing_embedding_works set reservation_id = null where id = $1',
            [workId],
          );
        }

        if (attempt) {
          expect(await execution.failAttempt(workId, token, attempt.attemptId, 'timeout')).toBe(
            state === 'OBSOLETE' ? 'obsolete' : 'final_failed',
          );
        } else {
          expect(await execution.startAttempt(workId, token)).toBeNull();
        }

        expect(await effects(workId)).toMatchObject({
          state,
          attempts: attempt ? 1 : 0,
          attempt_count: attempt ? 1 : 0,
          last_failure: failure,
          lease_token: null,
        });
        expect(await execution.recover(workId)).toBe('ignored');
        expect(await repository.claim(workId)).toBe(false);
      },
    );
  });

  it('미승인 설정은 기존 work를 실행하거나 repair하지 않는다', async () => {
    const { workId } = await seedWork();
    const token = await claim(workId);

    settings.set('embeddingConfigFingerprint', null);
    expect(await execution.startAttempt(workId, token)).toBeNull();
    await expireLease(workId);
    expect(await execution.recover(workId)).toBe('ignored');
    expect(await effects(workId)).toMatchObject({
      state: 'LEASED',
      attempts: 0,
      attempt_count: 0,
      exposed: false,
    });
  });

  it('미노출 만료 예약만 회수하고 CALLING 이후 비용 노출은 유지한다', async () => {
    const unexposed = await seedWork();
    const exposed = await seedWork();

    await start(exposed.workId, await claim(exposed.workId));
    await expireReservation(unexposed.workId);
    await expireReservation(exposed.workId);
    const usage = worker.get(WorkerUsageService);

    expect(await usage.expireUnexposed()).toBe(1);
    expect(await usage.expireUnexposed()).toBe(0);
    expect(await effects(unexposed.workId)).toMatchObject({
      reservation_state: 'expired',
      exposed: false,
      attempts: 0,
    });
    expect(await effects(exposed.workId)).toMatchObject({
      reservation_state: 'reserved',
      exposed: true,
      attempts: 1,
    });
    expect(await execution.recover(unexposed.workId)).toBe('final_failed');
    expect(await execution.recover(exposed.workId)).toBe('final_failed');
    expect(await effects(exposed.workId)).toMatchObject({
      state: 'FINAL_FAILED',
      reservation_state: 'settled',
      exposed: true,
    });
    expect((await publicationEffects(exposed.workId)).settled_amount).toBe('10');
  });
});
