import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { EMBEDDING_CLAIM_QUEUE } from '@devfootnote/queue';
import type { EmbeddingPolicy } from '../apps/api/dist/modules/usage-retention/index.js';
import type { ActivateEmbeddings } from '../apps/api/dist/modules/indexing/index.js';
import { startAuthHarness } from './auth-harness.js';
import { GOOGLE_SUBJECT_A, GOOGLE_SUBJECT_B } from './auth-environment.js';

const requireFixture = createRequire(resolve('tests/embedding-activation.integration.test.ts'));
const { MaterialsService }: typeof import('../apps/api/dist/modules/materials/index.js') =
  requireFixture('../apps/api/dist/modules/materials/index.js');
const { EmbeddingDeliveryService }: typeof import('../apps/api/dist/modules/indexing/index.js') =
  requireFixture('../apps/api/dist/modules/indexing/index.js');

// 제품에는 이 설정이나 provider adapter가 없다. 가격·보존·기간은 격리 fixture일 뿐 승인값이 아니다.
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

describe('embedding 활성화 admission / 실제 PostgreSQL·Redis, provider 호출 없음', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let redis: StartedTestContainer;
  let connection: Redis;
  let queue: Queue;
  let csrf: Awaited<ReturnType<typeof harness.issueCsrf>>;
  let ownerId: string;
  let access: string;
  let config: ConfigService;
  const agent = () => request(harness.app.getHttpServer());
  const mutation = (path: string, body: object, cookie = access) =>
    agent()
      .post(path)
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, cookie])
      .send(body);
  const activate = (body: object, cookie = access) =>
    mutation('/api/v1/indexing/embedding/activations', body, cookie);
  const revoke = (epoch: number) =>
    mutation('/api/v1/indexing/embedding/consent/revoke', { expectedConsentEpoch: epoch });
  const preview = (cookie = access) =>
    agent().get('/api/v1/indexing/embedding/preview').set('Cookie', cookie);

  async function material(owner = ownerId) {
    return harness.app
      .get(MaterialsService)
      .create(owner, { idempotencyKey: randomUUID(), body: '활성화할 PostgreSQL 원문' });
  }

  async function command(cookie = access): Promise<ActivateEmbeddings> {
    const response = await preview(cookie).expect(200);

    return {
      requestId: randomUUID(),
      configFingerprint: response.body.data.policy.configFingerprint,
      policyVersion: policy.policyVersion,
      expectedConsentEpoch: response.body.data.consentEpoch,
      accepted: true,
      targets: response.body.data.items.map((item: { materialId: string; revisionId: string }) => ({
        materialId: item.materialId,
        revisionId: item.revisionId,
      })),
    };
  }

  async function effects() {
    const {
      rows: [row],
    } = await harness.pool.query(`select
      (select count(*)::int from usage_embedding_consents) as consents,
      (select count(*)::int from usage_embedding_budgets) as budgets,
      (select count(*)::int from usage_embedding_reservations) as reservations,
      (select count(*)::int from indexing_embedding_works) as works,
      (select count(*)::int from indexing_activation_receipts) as receipts,
      (select count(*)::int from indexing_embedding_activations) as activations`);

    return row;
  }

  async function atBarrier(table: string, operations: () => PromiseLike<request.Response>[]) {
    const blocker = await harness.pool.connect();
    let pending = Promise.resolve<PromiseSettledResult<request.Response>[]>([]);
    const failures: unknown[] = [];

    try {
      await blocker.query('begin');
      await blocker.query(`lock table ${table} in share mode`);
      pending = Promise.allSettled(operations());
      await vi.waitFor(
        async () => {
          const {
            rows: [row],
          } = await harness.pool.query(`select count(*)::int as count from pg_stat_activity
          where application_name = 'devfootnote' and wait_event_type = 'Lock'`);

          expect(row.count).toBe(2);
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
      throw failures[0];
    }

    return (await pending).map((result) => {
      if (result.status === 'rejected') {
        throw result.reason;
      }

      return result.value;
    });
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
    config = harness.app.get(ConfigService);
    connection = new Redis(url, { maxRetriesPerRequest: null });
    queue = new Queue(EMBEDDING_CLAIM_QUEUE, { connection });
  });

  afterAll(async () => {
    try {
      await queue?.close();
    } finally {
      connection?.disconnect();

      try {
        await harness?.close();
      } finally {
        await redis?.stop();
      }
    }
  });

  beforeEach(async () => {
    await queue.drain();
    await harness.pool.query(
      'truncate answer_call_attempts, answer_requests, usage_answer_consents, indexing_embedding_vectors, usage_embedding_call_receipts, auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_works, indexing_embedding_attempts, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations',
    );
    config.set('embeddingPolicy', policy);
    const tokens = await harness.auth.completeLogin(GOOGLE_SUBJECT_A);

    access = `devfootnote_access=${tokens.access}`;
    ownerId = (await harness.pool.query('select id from accounts')).rows[0].id;
    csrf = await harness.issueCsrf();
  });

  it('미설정은 활성화를 막고 기존 저장·검색·읽기는 유지한다', async () => {
    const saved = await material();
    const input = await command();

    config.set('embeddingPolicy', null);
    expect((await preview().expect(200)).body.data).toEqual({
      configured: false,
      consented: false,
      automatic: false,
      includeExisting: false,
      states: [],
      consentEpoch: 0,
      items: [],
      policy: null,
      nextCursor: null,
      reservedMaximum: '0',
    });
    expect((await activate(input).expect(409)).body.error).toBe('EMBEDDING_NOT_CONFIGURED');
    expect(await effects()).toEqual({
      consents: 0,
      budgets: 0,
      reservations: 0,
      works: 0,
      receipts: 0,
      activations: 0,
    });
    await agent().get(`/api/v1/materials/${saved.id}`).set('Cookie', access).expect(200);
    await agent().get('/api/v1/search?q=PostgreSQL').set('Cookie', access).expect(200);
  });

  it('인증·CSRF·명시적 동의·bounded 입력을 검증한다', async () => {
    await material();
    const input = await command();

    await agent().get('/api/v1/indexing/embedding/preview').expect(401);
    await agent()
      .post('/api/v1/indexing/embedding/activations')
      .set('Cookie', access)
      .send(input)
      .expect(403);
    await activate({ ...input, accepted: false }).expect(400);
    await activate({ ...input, targets: [] }).expect(400);
    await activate({ ...input, targets: [], includeExisting: true, retryFailed: true }).expect(400);
    await activate({
      ...input,
      targets: Array.from({ length: 21 }, () => input.targets[0]),
    }).expect(400);
    await activate({ ...input, targets: [input.targets[0], input.targets[0]] }).expect(400);
    expect(await effects()).toMatchObject({ reservations: 0, works: 0, consents: 0 });
  });

  it('자료가 없어도 전체 자동 준비를 한 번 켜고 같은 요청은 멱등하게 반환한다', async () => {
    const input = { ...(await command()), includeExisting: true };

    expect((await preview()).body.data).toMatchObject({ automatic: false, includeExisting: false });
    const first = await activate(input).expect(202);

    expect(first.body.data).toMatchObject({ consentEpoch: 1, workIds: [], reservedMaximum: '0' });
    expect((await activate(input).expect(202)).body.data).toEqual(first.body.data);
    expect((await preview()).body.data).toMatchObject({
      consented: true,
      automatic: true,
      includeExisting: true,
    });
    expect(await effects()).toEqual({
      consents: 1,
      budgets: 0,
      reservations: 0,
      works: 0,
      receipts: 1,
      activations: 1,
    });
    await revoke(1).expect(200);
    expect((await preview()).body.data).toMatchObject({
      consented: false,
      automatic: false,
      includeExisting: false,
    });
  });

  it('기존 선택 동의의 전송 범위는 명시적 새 요청만 전체 자료로 확대한다', async () => {
    await material();
    const input = await command();

    await activate(input).expect(202);
    expect((await preview()).body.data).toMatchObject({ automatic: true, includeExisting: false });
    await activate({ ...input, includeExisting: true }).expect(409);
    await activate({
      ...(await command()),
      includeExisting: true,
      targets: [],
    }).expect(202);
    expect((await preview()).body.data).toMatchObject({
      consentEpoch: 1,
      automatic: true,
      includeExisting: true,
    });
    // 이전 선택 요청을 다시 보내도 전체 범위가 취소되거나 새 work가 생기지 않는다.
    await activate(input).expect(202);
    expect((await preview()).body.data.includeExisting).toBe(true);
    expect(await effects()).toMatchObject({ works: 1, receipts: 2 });
  });

  it('동의·예약·work·receipt commit 후에만 실제 Redis로 전달하고 같은 요청은 재사용한다', async () => {
    await material();
    const input = await command();
    const delivery = harness.app.get(EmbeddingDeliveryService);
    const original = delivery.deliver.bind(delivery);
    const observed = vi.spyOn(delivery, 'deliver').mockImplementation(async (owner, workId) => {
      // 다른 연결에서 work가 보이고 consent 잠금도 없어야 commit 뒤 전달이다.
      expect(
        (
          await harness.pool.query('select id from indexing_embedding_works where id = $1', [
            workId,
          ])
        ).rowCount,
      ).toBe(1);
      await harness.pool.query(
        'select owner_id from usage_embedding_consents where owner_id = $1 for update nowait',
        [owner],
      );

      return original(owner, workId);
    });

    try {
      const first = await activate(input).expect(202);

      expect(first.body.data).toEqual({
        requestId: input.requestId,
        consentEpoch: 1,
        workIds: [expect.any(String)],
        reservedMaximum: '10',
      });
      expect(await effects()).toEqual({
        consents: 1,
        budgets: 1,
        reservations: 1,
        works: 1,
        receipts: 1,
        activations: 1,
      });
      expect(observed).toHaveBeenCalledTimes(1);
      const workId = first.body.data.workIds[0];

      expect((await queue.getJob(workId))?.data).toEqual({ workId });
      expect((await activate(input).expect(202)).body).toEqual(first.body);
      await activate({ ...input, expectedConsentEpoch: 1 }).expect(409);
      expect(await effects()).toMatchObject({ works: 1, reservations: 1, receipts: 1 });
    } finally {
      observed.mockRestore();
    }
  });

  it.each([
    { table: 'usage_embedding_reservations', step: '비용 예약' },
    { table: 'indexing_embedding_works', step: '임베딩 작업' },
    { table: 'indexing_activation_receipts', step: '활성화 처리 결과' },
  ])('$step 저장 실패 시 동의·비용 예약·작업 생성을 모두 취소한다', async ({ table }) => {
    await material();
    const input = await command();

    await harness.pool
      .query(`create function fail_activation_fixture() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_ACTIVATION_BODY'; end $$;
      create trigger fail_activation_fixture before insert on ${table} for each row execute function fail_activation_fixture()`);

    try {
      const response = await activate(input).expect(500);

      expect(JSON.stringify(response.body)).not.toContain('PRIVATE_');
      expect(await effects()).toEqual({
        consents: 0,
        budgets: 0,
        reservations: 0,
        works: 0,
        receipts: 0,
        activations: 0,
      });
      expect(await queue.getWaitingCount()).toBe(0);
    } finally {
      await harness.pool.query(
        `drop trigger fail_activation_fixture on ${table}; drop function fail_activation_fixture()`,
      );
    }
  });

  it('두 동일 요청이 실제 consent 잠금에서 경쟁해도 예약과 work는 한 번만 생긴다', async () => {
    await material();
    const input = await command();
    const responses = await atBarrier('usage_embedding_consents', () => [
      activate(input),
      activate(input),
    ]);

    expect(responses.map((result) => result.status)).toEqual([202, 202]);
    expect(responses[0]?.body).toEqual(responses[1]?.body);
    expect(await effects()).toMatchObject({ reservations: 1, works: 1, receipts: 1 });
  });

  it('다른 owner도 공유 예산 잠금에서 경쟁하며 한도를 넘는 예약은 전체 rollback한다', async () => {
    config.set('embeddingPolicy', { ...policy, budgetLimit: '10' });
    await material();
    const first = await command();
    const tokens = await harness.auth.completeLogin(GOOGLE_SUBJECT_B);
    const otherAccess = `devfootnote_access=${tokens.access}`;
    const other = (await harness.pool.query('select id from accounts where id <> $1', [ownerId]))
      .rows[0].id;

    await material(other);
    const second = await command(otherAccess);
    const results = await atBarrier('usage_embedding_budgets', () => [
      activate(first),
      activate(second, otherAccess),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([202, 409]);
    expect(results.find((result) => result.status === 409)?.body.error).toBe(
      'EMBEDDING_BUDGET_EXHAUSTED',
    );
    expect(await effects()).toEqual({
      consents: 1,
      budgets: 1,
      reservations: 1,
      works: 1,
      receipts: 1,
      activations: 1,
    });
  });

  it('preview 뒤 수정·삭제·다른 owner·정책 변경은 stale 입력으로 work를 만들지 않는다', async () => {
    const saved = await material();
    const input = await command();

    await harness.app.get(MaterialsService).update(ownerId, saved.id, {
      idempotencyKey: randomUUID(),
      expectedRevisionId: saved.revisionId,
      body: '수정된 원문',
    });
    expect((await activate(input).expect(409)).body.error).toBe('MATERIAL_REVISION_CONFLICT');
    const current = await command();
    const target = current.targets[0];

    if (!target) {
      throw new Error('수정된 자료가 preview에 없습니다.');
    }

    const other = await harness.auth.completeLogin(GOOGLE_SUBJECT_B);

    await activate(current, `devfootnote_access=${other.access}`).expect(404);
    await activate({ ...current, configFingerprint: '0'.repeat(64) }).expect(409);
    await harness.app.get(MaterialsService).delete(ownerId, saved.id, {
      idempotencyKey: randomUUID(),
      expectedRevisionId: target.revisionId,
    });
    await activate(current).expect(404);
    expect(await effects()).toMatchObject({ works: 0, reservations: 0, consents: 0 });
  });

  it('철회는 epoch를 바꿔 이전 요청을 막고 재동의는 기존 work를 되살리지 않는다', async () => {
    await material();
    const input = await command();
    const first = await activate(input).expect(202);

    expect((await revoke(1).expect(200)).body.data).toEqual({ consentEpoch: 2 });
    await activate(input).expect(409);
    const next = await command();

    expect(next.expectedConsentEpoch).toBe(2);
    const second = await activate(next).expect(202);

    expect(second.body.data.consentEpoch).toBe(3);
    expect(second.body.data.workIds).not.toEqual(first.body.data.workIds);
    expect(await effects()).toMatchObject({ reservations: 2, works: 2, receipts: 2 });
  });

  it.each([
    { operation: 'preview', step: '활성화 미리보기' },
    { operation: 'revoke', step: '동의 철회' },
  ] as const)(
    '$step 중 DB 잠금 대기 시간이 초과되면 503을 반환하고 동의 상태를 유지한다',
    async ({ operation }) => {
      await material();
      await activate(await command()).expect(202);
      const blocker = await harness.pool.connect();

      try {
        await blocker.query('begin');
        await blocker.query('lock table usage_embedding_consents in access exclusive mode');
        const response = await (operation === 'preview' ? preview() : revoke(1)).expect(503);

        expect(response.body).toEqual({
          success: false,
          error: 'SERVICE_UNAVAILABLE',
          message: '잠시 후 다시 시도해 주세요.',
        });
      } finally {
        try {
          await blocker.query('rollback');
        } finally {
          blocker.release();
        }
      }

      expect(
        (
          await harness.pool.query(
            'select epoch, revoked_at from usage_embedding_consents where owner_id = $1',
            [ownerId],
          )
        ).rows,
      ).toEqual([{ epoch: 1, revoked_at: null }]);
      expect((await preview().expect(200)).body.data.consentEpoch).toBe(1);
      expect((await revoke(1).expect(200)).body.data).toEqual({ consentEpoch: 2 });
      expect(await effects()).toMatchObject({ reservations: 1, works: 1, receipts: 1 });
    },
  );

  it('이미 활성화한 intent와 terminal work는 새 요청으로 자동 부활하지 않는다', async () => {
    await material();
    const input = await command();

    await activate(input).expect(202);
    expect((await preview().expect(200)).body.data.items).toEqual([]);
    const next = { ...input, requestId: randomUUID(), expectedConsentEpoch: 1 };

    expect((await activate(next).expect(202)).body.data).toMatchObject({
      workIds: [],
      reservedMaximum: '0',
    });
    await harness.pool.query("update indexing_embedding_works set state = 'FINAL_FAILED'");
    expect(
      (await activate({ ...next, requestId: randomUUID() }).expect(202)).body.data.workIds,
    ).toEqual([]);
    expect(await effects()).toMatchObject({ works: 1, reservations: 1 });
  });

  it('preview는 owner의 current 자료만 bounded cursor로 순회한다', async () => {
    const first = await material();
    const second = await material();
    const page = await agent()
      .get('/api/v1/indexing/embedding/preview?limit=1')
      .set('Cookie', access)
      .expect(200);
    const next = await agent()
      .get('/api/v1/indexing/embedding/preview')
      .query({ limit: 1, afterId: page.body.data.nextCursor })
      .set('Cookie', access)
      .expect(200);

    const selected = first.id < second.id ? first : second;

    // 승인 설정의 budget ID·가격 정책과 내부 intent ID가 응답에 섞이지 않아야 한다.
    expect(page.body.data).toEqual({
      configured: true,
      consented: false,
      automatic: false,
      includeExisting: false,
      states: [
        {
          materialId: selected.id,
          revisionId: selected.revisionId,
          title: null,
          state: 'NOT_STARTED',
          failure: null,
        },
      ],
      consentEpoch: 0,
      policy: {
        configFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        policyVersion: policy.policyVersion,
        provider: policy.provider,
        retentionNotice: policy.retentionNotice,
        currency: policy.currency,
        unitScale: policy.unitScale,
        budgetLimit: policy.budgetLimit,
      },
      items: [{ materialId: selected.id, revisionId: selected.revisionId, chunkCount: 1 }],
      nextCursor: selected.id,
      reservedMaximum: '10',
    });
    expect(next.body.data.nextCursor).toBeNull();
    expect([page.body.data.items[0].materialId, next.body.data.items[0].materialId].sort()).toEqual(
      [first.id, second.id].sort(),
    );
    const tokens = await harness.auth.completeLogin(GOOGLE_SUBJECT_B);

    expect(
      (await preview(`devfootnote_access=${tokens.access}`).expect(200)).body.data.items,
    ).toEqual([]);
  });

  it('명시적 실패 재시도는 terminal을 수정하지 않고 같은 요청의 새 generation을 한 번만 만든다', async () => {
    const saved = await material();
    const input = await command();
    const first = await activate(input).expect(202);
    const firstId = first.body.data.workIds[0];

    await harness.pool.query(
      "update indexing_embedding_works set state = 'FINAL_FAILED', last_failure = 'rate_limited' where id = $1",
      [firstId],
    );
    const status = (await preview().expect(200)).body.data;

    expect(status.consented).toBe(true);
    expect(status.states).toEqual([
      {
        materialId: saved.id,
        revisionId: saved.revisionId,
        title: null,
        state: 'FINAL_FAILED',
        failure: 'rate_limited',
      },
    ]);
    const retry = { ...input, requestId: randomUUID(), expectedConsentEpoch: 1, retryFailed: true };
    const results = await atBarrier('usage_embedding_consents', () => [
      activate(retry),
      activate(retry),
    ]);

    expect(results.map((result) => result.status)).toEqual([202, 202]);
    expect(results[0]?.body).toEqual(results[1]?.body);
    expect(
      (
        await harness.pool.query(
          'select generation, state from indexing_embedding_works order by generation',
        )
      ).rows,
    ).toEqual([
      { generation: 1, state: 'FINAL_FAILED' },
      { generation: 2, state: 'PENDING' },
    ]);
    expect((await activate({ ...retry, retryFailed: false }).expect(409)).body.error).toBe(
      'EMBEDDING_REQUEST_CONFLICT',
    );
    expect((await preview().expect(200)).body.data.states[0].state).toBe('PENDING');
  });

  it.each([
    { state: 'settled', result: '정산된 예약의 실제 정산액을 반영한다' },
    { state: 'expired', result: '예약 만료로 반환된 금액을 반영한다' },
  ] as const)('사용 가능한 예산에 $result', async ({ state }) => {
    config.set('embeddingPolicy', { ...policy, budgetLimit: '10' });
    await material();
    await activate(await command()).expect(202);
    const second = await material();
    const input = await command();

    expect(input.targets.map((target) => target.materialId)).toEqual([second.id]);
    await activate(input).expect(409);

    if (state === 'settled') {
      await harness.pool.query(
        "update usage_embedding_reservations set state = 'settled', settled_amount = 1",
      );
      await activate(input).expect(409);
      await harness.pool.query('update usage_embedding_reservations set settled_amount = 0');
    } else {
      // 호출 노출이 없으면 state가 아직 reserved여도 DB 시각상 만료 뒤 새 admission을 허용한다.
      await harness.pool.query(
        "update usage_embedding_reservations set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'",
      );
    }

    await activate(input).expect(202);
    expect(await effects()).toMatchObject({ works: 2, reservations: 2 });
  });

  it('호출 노출이 있는 batch 예약은 만료돼도 다른 owner의 공유 예산에 반영한다', async () => {
    config.set('embeddingPolicy', { ...policy, budgetLimit: '20' });
    await material();
    await material();
    const first = await activate(await command()).expect(202);

    expect(first.body.data.reservedMaximum).toBe('20');
    expect(first.body.data.workIds).toHaveLength(2);
    // 실제 provider 없이 호출 시작 뒤 결과가 불명확해진 예약의 DB 상태를 재현한다.
    await harness.pool.query(`update usage_embedding_reservations
      set created_at = now() - interval '2 hours',
          exposure_started_at = now() - interval '90 minutes',
          expires_at = now() - interval '1 hour'`);
    const tokens = await harness.auth.completeLogin(GOOGLE_SUBJECT_B);
    const otherAccess = `devfootnote_access=${tokens.access}`;
    const otherOwner = (
      await harness.pool.query('select id from accounts where id <> $1', [ownerId])
    ).rows[0].id;

    await material(otherOwner);
    const next = await command(otherAccess);
    const denied = await activate(next, otherAccess).expect(409);

    expect(denied.body.error).toBe('EMBEDDING_BUDGET_EXHAUSTED');
    expect(await effects()).toEqual({
      consents: 1,
      budgets: 1,
      reservations: 1,
      works: 2,
      receipts: 1,
      activations: 1,
    });
    const { rows: reservations } = await harness.pool.query(`select id, owner_id, state,
      reserved_maximum::text, settled_amount, expires_at < now() as expired,
      exposure_started_at is not null as exposed
      from usage_embedding_reservations`);

    expect(reservations).toEqual([
      {
        id: expect.any(String),
        owner_id: ownerId,
        state: 'reserved',
        reserved_maximum: '20',
        settled_amount: null,
        expired: true,
        exposed: true,
      },
    ]);
    const { rows: works } = await harness.pool.query<{ id: string; reservation_id: string }>(
      'select id, reservation_id from indexing_embedding_works',
    );

    expect(works.map((work) => work.id).sort()).toEqual([...first.body.data.workIds].sort());
    expect(works.map((work) => work.reservation_id)).toEqual([
      reservations[0].id,
      reservations[0].id,
    ]);
  });

  it('Redis 중단 중에도 활성화 commit과 core 읽기를 유지한다', async () => {
    const saved = await material();
    const input = await command();

    await queue.close();
    connection.disconnect();
    await redis.stop();
    const result = await activate(input).expect(202);

    expect(result.body.data.workIds).toHaveLength(1);
    expect(await effects()).toMatchObject({ works: 1, reservations: 1, receipts: 1 });
    expect((await harness.pool.query('select state from indexing_embedding_works')).rows).toEqual([
      { state: 'PENDING' },
    ]);
    await agent().get(`/api/v1/materials/${saved.id}`).set('Cookie', access).expect(200);
    await agent().get('/api/v1/search?q=PostgreSQL').set('Cookie', access).expect(200);
  });
});
