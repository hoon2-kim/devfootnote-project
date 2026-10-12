import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { startAuthHarness } from './auth-harness.js';
import { GOOGLE_SUBJECT_A, GOOGLE_SUBJECT_B } from './auth-environment.js';

const requireFixture = createRequire(resolve('tests/semantic-search.integration.test.ts'));
const { MaterialsService }: typeof import('../apps/api/dist/modules/materials/index.js') =
  requireFixture('../apps/api/dist/modules/materials/index.js');
const {
  EmbeddingActivationService,
  EmbeddingDeliveryService,
}: typeof import('../apps/api/dist/modules/indexing/index.js') = requireFixture(
  '../apps/api/dist/modules/indexing/index.js',
);
const { UsageService }: typeof import('../apps/api/dist/modules/usage-retention/index.js') =
  requireFixture('../apps/api/dist/modules/usage-retention/index.js');
const { geminiFreePolicy }: typeof import('../packages/ai/dist/index.js') = requireFixture(
  '../packages/ai/dist/index.js',
);

describe('의미 검색 / 실제 PostgreSQL과 외부 전송 없는 Gemini 응답 fixture', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let config: ConfigService;
  let ownerId: string;
  let access: string;
  let csrf: Awaited<ReturnType<typeof harness.issueCsrf>>;
  const policy = geminiFreePolicy();
  const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
  const response = (tokens: number | null = 3) =>
    new Response(
      JSON.stringify({
        embeddings: [{ values: vector }],
        ...(tokens === null ? {} : { usageMetadata: { promptTokenCount: tokens } }),
      }),
      { status: 200 },
    );
  const agent = () => request(harness.app.getHttpServer());
  const query = (
    q = '동시 실행 충돌',
    mode: 'vector' | 'hybrid' = 'vector',
    requestId = randomUUID(),
  ) =>
    agent()
      .post('/api/v1/search/semantic')
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, access])
      .send({ q, mode, requestId });

  async function material(body = '잠금과 원자성', owner = ownerId) {
    return harness.app.get(MaterialsService).create(owner, { body, idempotencyKey: randomUUID() });
  }

  async function published(body = '잠금과 원자성', owner = ownerId, values = vector) {
    const saved = await material(body, owner);
    const usage = harness.app.get(UsageService);
    const consent = await usage.consent(owner);
    const result = await harness.app.get(EmbeddingActivationService).activate(owner, {
      requestId: randomUUID(),
      accepted: true,
      configFingerprint: policy.fingerprint,
      policyVersion: policy.policyVersion,
      expectedConsentEpoch: consent.epoch,
      targets: [{ materialId: saved.id, revisionId: saved.revisionId }],
    });
    const workId = result.workIds[0];

    await harness.pool.query(
      "update indexing_embedding_works set state = 'PUBLISHED' where id = $1",
      [workId],
    );
    await harness.pool.query(
      `insert into indexing_embedding_vectors (work_id, owner_id, material_id, revision_id, chunk_id, embedding)
      select $1, owner_id, material_id, revision_id, id, $2::vector from material_chunks where revision_id = $3`,
      [workId, JSON.stringify(values), saved.revisionId],
    );

    return { ...saved, workId };
  }

  async function receipts() {
    return (
      await harness.pool
        .query(`select r.id, r.request_id, r.fingerprint, r.state, r.settled_amount::text,
      r.reserved_maximum::text, r.exposure_started_at, c.tokens, c.amount::text
      from usage_embedding_reservations r left join usage_embedding_call_receipts c on c.reservation_id = r.id
      where r.fingerprint like 'query-v1:%'`)
    ).rows;
  }

  beforeAll(async () => {
    harness = await startAuthHarness();
    config = harness.app.get(ConfigService);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await harness?.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.pool.query(
      'truncate answer_call_attempts, answer_requests, usage_answer_consents, indexing_embedding_vectors, usage_embedding_call_receipts, auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_works, indexing_embedding_attempts, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations',
    );
    config.set('embeddingPolicy', policy);
    config.set('geminiApiKey', 'fixture-gemini-key');
    vi.spyOn(harness.app.get(EmbeddingDeliveryService), 'deliver').mockResolvedValue(false);
    const tokens = await harness.auth.completeLogin(GOOGLE_SUBJECT_A);

    access = `devfootnote_access=${tokens.access}`;
    ownerId = (await harness.pool.query('select id from accounts')).rows[0].id;
    csrf = await harness.issueCsrf();
  });

  it('예약 노출 commit 뒤 호출하고 정산하며 질의 원문을 durable 행에 남기지 않는다', async () => {
    const saved = await published();
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const rows = await receipts();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'reserved', settled_amount: null });
      expect(rows[0].exposure_started_at).not.toBeNull();
      const active = await harness.pool.query(
        "select count(*)::int as count from pg_stat_activity where application_name = 'devfootnote' and state like 'idle in transaction%'",
      );

      expect(active.rows[0].count).toBe(0);

      return response();
    });
    const result = await query('각 실행의 데이터 경합을 막는 방법').expect(200);

    expect(result.body.data).toMatchObject({
      effectiveMode: 'vector',
      degradedReason: null,
      resultLimit: 50,
      truncated: false,
    });
    expect(result.body.data.items.map((item: { id: string }) => item.id)).toEqual([saved.id]);
    expect(provider).toHaveBeenCalledTimes(1);
    const rows = await receipts();

    expect(rows[0]).toMatchObject({
      state: 'settled',
      settled_amount: '600',
      tokens: 3,
      amount: '600',
    });
    expect(JSON.stringify(rows)).not.toContain('각 실행의 데이터 경합을 막는 방법');
  });

  for (const gate of ['missing', 'consent', 'budget'] as const) {
    it(`${{ missing: '설정 없음', consent: '미동의', budget: '예산 부족' }[gate]} 상태에서는 provider 호출 없이 이유 있는 키워드 결과를 낸다`, async () => {
      const saved =
        gate === 'consent' ? await material('키워드 결과') : await published('키워드 결과');

      if (gate === 'missing') {
        config.set('geminiApiKey', '');
      }

      if (gate === 'budget') {
        await harness.pool.query(
          "update usage_embedding_reservations set state = 'settled', settled_amount = $1, reserved_maximum = $1",
          [policy.budgetLimit],
        );
      }

      const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
      const result = await query('키워드').expect(200);

      expect(result.body.data).toMatchObject({
        effectiveMode: 'keyword',
        degradedReason: {
          missing: 'not_configured',
          consent: 'consent_required',
          budget: 'budget_exhausted',
        }[gate],
      });
      expect(result.body.data.items[0].id).toBe(saved.id);
      expect(provider).not.toHaveBeenCalled();
      expect(await receipts()).toHaveLength(0);
    });
  }

  it('429는 자동 재시도하지 않고 상한 정산 후 키워드로 돌아간다', async () => {
    const saved = await published('키워드 결과');
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 429 }));
    const result = await query('키워드').expect(200);

    expect(result.body.data).toMatchObject({
      effectiveMode: 'keyword',
      degradedReason: 'provider_unavailable',
    });
    expect(result.body.data.items[0].id).toBe(saved.id);
    expect(provider).toHaveBeenCalledTimes(1);
    const [row] = await receipts();

    expect(row.state).toBe('settled');
    expect(row.settled_amount).toBe(row.reserved_maximum);
    expect(row.tokens).toBeNull();
  });

  it('현재 자료의 게시 벡터가 없으면 질의 임베딩 비용도 발생시키지 않는다', async () => {
    const saved = await published('키워드 결과');

    await harness.pool.query(
      "update indexing_embedding_works set state = 'PENDING' where id = $1",
      [saved.workId],
    );
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const result = await query('키워드').expect(200);

    expect(result.body.data).toMatchObject({
      effectiveMode: 'keyword',
      degradedReason: 'index_unavailable',
    });
    expect(result.body.data.items[0].id).toBe(saved.id);
    expect(provider).not.toHaveBeenCalled();
    expect(await receipts()).toHaveLength(0);
  });

  it('provider 응답 전에 예약이 만료되면 알려진 비용만 정산하고 의미검색을 공개하지 않는다', async () => {
    await published('키워드 결과');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await harness.pool.query(
        "update usage_embedding_reservations set created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' where fingerprint like 'query-v1:%'",
      );

      return response();
    });
    const result = await query('키워드').expect(200);

    expect(result.body.data).toMatchObject({
      effectiveMode: 'keyword',
      degradedReason: 'index_unavailable',
    });
    expect((await receipts())[0].settled_amount).toBe('600');
  });

  it('호출 중 철회되어도 비용은 정산하고 vector 결과는 공개하지 않는다', async () => {
    await published('키워드 결과');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await harness.app.get(UsageService).revoke(ownerId, 1);

      return response();
    });
    const result = await query('키워드').expect(200);

    expect(result.body.data).toMatchObject({
      effectiveMode: 'keyword',
      degradedReason: 'consent_changed',
    });
    expect((await receipts())[0].settled_amount).toBe('600');
  });

  it('현재 owner·revision·미삭제·게시·config·epoch 조건을 모든 vector 후보에 적용한다', async () => {
    const visible = await published('남는 자료');
    const deleted = await published('삭제 자료');
    const stale = await published('옛 버전');
    const pending = await published('아직 미게시');
    const wrongConfig = await published('다른 설정');
    const oldConsent = await published('이전 동의');

    await harness.auth.completeLogin(GOOGLE_SUBJECT_B);
    const otherOwner = (
      await harness.pool.query('select id from accounts where id <> $1', [ownerId])
    ).rows[0].id;

    await published('다른 계정', otherOwner);
    await harness.app.get(MaterialsService).delete(ownerId, deleted.id, {
      idempotencyKey: randomUUID(),
      expectedRevisionId: deleted.revisionId,
    });
    await harness.app.get(MaterialsService).update(ownerId, stale.id, {
      idempotencyKey: randomUUID(),
      expectedRevisionId: stale.revisionId,
      body: '새 버전에는 vector 없음',
    });
    await harness.pool.query(
      "update indexing_embedding_works set state = 'PENDING' where id = $1",
      [pending.workId],
    );
    await harness.pool.query(
      "update indexing_embedding_works set config_fingerprint = 'other' where id = $1",
      [wrongConfig.workId],
    );
    await harness.pool.query(
      'update indexing_embedding_works set consent_epoch = 999 where id = $1',
      [oldConsent.workId],
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const result = await query().expect(200);

    expect(result.body.data.items.map((item: { id: string }) => item.id)).toEqual([visible.id]);
  });

  it('긴 자료의 여러 chunk는 한 자료 결과로 합치고 hybrid에 keyword 전용 자료를 포함한다', async () => {
    const semantic = await published('본문 '.repeat(600));
    const keyword = await material('키워드 전용');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const result = await query('키워드', 'hybrid').expect(200);
    const ids = result.body.data.items.map((item: { id: string }) => item.id);

    expect(ids.sort()).toEqual([semantic.id, keyword.id].sort());
    expect(result.body.data.effectiveMode).toBe('hybrid');
  });

  it('같은 요청이 실제 동의 잠금에서 경쟁해도 외부 호출과 비용은 한 번만 발생한다', async () => {
    await published();
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
    const requestId = randomUUID();
    const blocker = await harness.pool.connect();
    let pending: Promise<PromiseSettledResult<request.Response>[]> = Promise.resolve([]);
    let barrierError: unknown;

    try {
      await blocker.query('begin');
      await blocker.query(
        'select owner_id from usage_embedding_consents where owner_id = $1 for update',
        [ownerId],
      );
      pending = Promise.allSettled([
        query(undefined, 'vector', requestId),
        query(undefined, 'vector', requestId),
      ]);
      await vi.waitFor(
        async () => {
          const observed = await harness.pool.query(
            "select count(*)::int as count from pg_stat_activity where application_name = 'devfootnote' and wait_event_type = 'Lock'",
          );

          expect(observed.rows[0].count).toBe(2);
        },
        { timeout: 1000, interval: 10 },
      );
    } catch (error) {
      barrierError = error;
    } finally {
      try {
        await blocker.query('rollback');
      } finally {
        blocker.release();
        await pending;
      }
    }

    if (barrierError) {
      throw barrierError;
    }

    const results = (await pending).map((result) => {
      if (result.status === 'rejected') {
        throw result.reason;
      }

      expect(result.value.status).toBe(200);

      return result.value.body.data;
    });

    expect(results.map((result) => result.effectiveMode).sort()).toEqual(['keyword', 'vector']);
    expect(results.find((result) => result.effectiveMode === 'keyword').degradedReason).toBe(
      'request_used',
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await receipts()).toHaveLength(1);
  });

  it('CSRF 없는 의미검색은 거부하며 기존 GET 키워드 검색은 provider를 부르지 않는다', async () => {
    await published('키워드 결과');
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());

    await agent()
      .post('/api/v1/search/semantic')
      .set('Cookie', access)
      .send({ q: '키워드', mode: 'vector', requestId: randomUUID() })
      .expect(403);
    await agent().get('/api/v1/search?q=키워드').set('Cookie', access).expect(200);
    expect(provider).not.toHaveBeenCalled();
  });
});
