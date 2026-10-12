import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { startAuthHarness } from './auth-harness.js';
import { GOOGLE_SUBJECT_A, GOOGLE_SUBJECT_B } from './auth-environment.js';

const requireFixture = createRequire(resolve('tests/answers.integration.test.ts'));
const { MaterialsService }: typeof import('../apps/api/dist/modules/materials/index.js') =
  requireFixture('../apps/api/dist/modules/materials/index.js');
const { AnswerUsageService }: typeof import('../apps/api/dist/modules/usage-retention/index.js') =
  requireFixture('../apps/api/dist/modules/usage-retention/index.js');
const {
  EmbeddingActivationService,
  EmbeddingDeliveryService,
}: typeof import('../apps/api/dist/modules/indexing/index.js') = requireFixture(
  '../apps/api/dist/modules/indexing/index.js',
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
const { MaterialsModule }: typeof import('../apps/worker/dist/modules/materials/index.js') =
  requireFixture('../apps/worker/dist/modules/materials/index.js');
const {
  UsageRetentionModule,
}: typeof import('../apps/worker/dist/modules/usage-retention/index.js') = requireFixture(
  '../apps/worker/dist/modules/usage-retention/index.js',
);
const {
  AnswersService: WorkerAnswersService,
}: typeof import('../apps/worker/dist/modules/answers/answers.service.js') = requireFixture(
  '../apps/worker/dist/modules/answers/answers.service.js',
);
const {
  AnswersRepository,
}: typeof import('../apps/worker/dist/modules/answers/answers.repository.js') = requireFixture(
  '../apps/worker/dist/modules/answers/answers.repository.js',
);
const {
  GeminiAnswer,
  geminiFreePolicy,
  geminiFreeAnswerPolicy,
  AnswerProviderError,
}: typeof import('@devfootnote/ai') = requireFixture('@devfootnote/ai');

describe('근거 답변 / 실제 PostgreSQL, 외부 호출 없는 제공자 fixture', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let worker: TestingModule;
  let settings: ConfigService;
  let ownerId: string;
  let access: string;
  let csrf: Awaited<ReturnType<typeof harness.issueCsrf>>;
  let saved: { id: string; revisionId: string };
  const policy = geminiFreeAnswerPolicy();
  const embeddingPolicy = geminiFreePolicy();
  const claimText = '행 잠금은 같은 자료의 수정을 직렬화합니다.';
  const candidate = {
    insufficientEvidence: false,
    claims: [{ text: claimText, evidenceIds: ['e1'] }],
    usage: { inputTokens: 100, outputTokens: 20 },
  };
  const agent = () => request(harness.app.getHttpServer());
  const command = (requestId = randomUUID(), question = '행 잠금은 어떤 역할인가요?') => ({
    requestId,
    question,
    evidence: [{ materialId: saved.id, revisionId: saved.revisionId }],
  });
  const post = (
    input: ReturnType<typeof command> & {
      history?: { requestId: string; question: string }[];
    } = command(),
  ) =>
    agent()
      .post('/api/v1/answers')
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, access])
      .send(input);
  const read = (id: string) => agent().get(`/api/v1/answers/${id}`).set('Cookie', access);
  const execute = (id: string) => worker.get(WorkerAnswersService).process(ownerId, id);
  const effects = async (id: string) =>
    (
      await harness.pool.query(
        `select a.state, a.question, a.claims, a.evidence, r.state as reservation_state, r.settled_amount::text, r.reserved_maximum::text, r.exposure_started_at, r.input_tokens, r.output_tokens,
    (select count(*)::int from answer_call_attempts c where c.owner_id=a.owner_id and c.request_id=a.request_id) as attempts
    from answer_requests a join usage_embedding_reservations r on r.id=a.reservation_id where a.request_id=$1`,
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    harness = await startAuthHarness();
    settings = new ConfigService({
      databaseUrl: harness.app.get(ConfigService).getOrThrow('databaseUrl'),
      answerPolicy: policy,
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
        WorkerAnswersService,
        AnswersRepository,
        { provide: GeminiAnswer, useValue: new GeminiAnswer('fixture-no-network') },
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(settings)
      .compile();
    await worker.init();
  });

  afterAll(async () => {
    vi.restoreAllMocks();

    try {
      await worker?.close();
    } finally {
      await harness?.close();
    }
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.pool.query(
      'truncate answer_call_attempts, answer_requests, usage_answer_consents, indexing_embedding_vectors, usage_embedding_call_receipts, auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_works, indexing_embedding_attempts, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations',
    );
    harness.app.get(ConfigService).set('embeddingPolicy', embeddingPolicy);
    harness.app.get(ConfigService).set('answerPolicy', policy);
    settings.set('answerPolicy', policy);
    vi.spyOn(harness.app.get(EmbeddingDeliveryService), 'deliver').mockResolvedValue(false);
    const tokens = await harness.auth.completeLogin(GOOGLE_SUBJECT_A);

    access = `devfootnote_access=${tokens.access}`;
    ownerId = (await harness.pool.query('select id from accounts')).rows[0].id;
    csrf = await harness.issueCsrf();
    saved = await harness.app.get(MaterialsService).create(ownerId, {
      idempotencyKey: randomUUID(),
      body: '행 잠금은 같은 자료의 수정을 직렬화한다.',
    });
    const activation = await harness.app.get(EmbeddingActivationService).activate(ownerId, {
      requestId: randomUUID(),
      accepted: true,
      expectedConsentEpoch: 0,
      policyVersion: embeddingPolicy.policyVersion,
      configFingerprint: embeddingPolicy.fingerprint,
      targets: [{ materialId: saved.id, revisionId: saved.revisionId }],
    });

    await harness.pool.query("update indexing_embedding_works set state='PUBLISHED' where id=$1", [
      activation.workIds[0],
    ]);
    await harness.pool.query(
      'insert into indexing_embedding_vectors (work_id,owner_id,material_id,revision_id,chunk_id,embedding) select $1,owner_id,material_id,revision_id,id,$2::vector from material_chunks where revision_id=$3',
      [
        activation.workIds[0],
        JSON.stringify(Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))),
        saved.revisionId,
      ],
    );
    await harness.app.get(AnswerUsageService).grant(ownerId, 0, policy.fingerprint);
    vi.spyOn(worker.get(GeminiAnswer), 'generate').mockResolvedValue(candidate);
  });

  it('snapshot·예약 commit → STARTED commit → 잠금 없는 provider → 게시·실제 사용량 정산', async () => {
    const input = command();
    const provider = vi
      .spyOn(worker.get(GeminiAnswer), 'generate')
      .mockImplementation(async (payload) => {
        expect(payload.question).toBe(input.question);
        expect(payload.evidence[0]?.text).toBe('행 잠금은 같은 자료의 수정을 직렬화한다.');
        expect(await effects(input.requestId)).toMatchObject({
          state: 'RUNNING',
          reservation_state: 'reserved',
          attempts: 1,
        });
        expect((await effects(input.requestId)).exposure_started_at).not.toBeNull();
        const active = await harness.pool.query(
          "select count(*)::int as count from pg_stat_activity where application_name='devfootnote-worker' and state='idle in transaction'",
        );

        expect(active.rows[0].count).toBe(0);

        return candidate;
      });

    expect((await post(input).expect(202)).body.data.state).toBe('RESERVED');
    await execute(input.requestId);
    expect(await effects(input.requestId)).toMatchObject({
      state: 'PUBLISHED',
      question: null,
      reservation_state: 'settled',
      settled_amount: '80000',
      input_tokens: 100,
      output_tokens: 20,
      attempts: 1,
    });
    const result = await read(input.requestId).expect(200);

    expect(result.body.data.claims).toEqual(candidate.claims);
    expect(result.body.data.citations[0]).toMatchObject({
      materialId: saved.id,
      revisionId: saved.revisionId,
      evidenceId: 'e1',
    });
    await post(input).expect(202);
    await execute(input.requestId);
    expect(provider).toHaveBeenCalledTimes(1);
    await post({ ...input, question: '다른 질문' }).expect(409);
  });

  it('미동의·설정 없음에서는 예약과 호출이 없다', async () => {
    await harness.app.get(AnswerUsageService).revoke(ownerId, 1);
    await post().expect(403);
    await harness.app.get(AnswerUsageService).grant(ownerId, 2, policy.fingerprint);
    harness.app.get(ConfigService).set('answerPolicy', null);
    await post().expect(409);
    harness.app.get(ConfigService).set('answerPolicy', policy);
    expect(
      (await harness.pool.query('select count(*)::int as count from answer_requests')).rows[0]
        .count,
    ).toBe(0);
    expect(worker.get(GeminiAnswer).generate).not.toHaveBeenCalled();
  });

  it('자료 하나의 질문은 임베딩 준비 없이 현재 본문으로 답한다', async () => {
    await harness.pool.query("update indexing_embedding_works set state='FINAL_FAILED'");
    await harness.pool.query('delete from indexing_embedding_vectors');
    const input = command();

    await post(input).expect(202);
    await execute(input.requestId);
    expect((await read(input.requestId).expect(200)).body.data.state).toBe('PUBLISHED');
  });

  it('후속 질문은 서버의 게시 답변을 참고하고 완료 후 질문 문맥을 지운다', async () => {
    const first = command();

    await post(first).expect(202);
    await execute(first.requestId);
    const followup = {
      ...command(randomUUID(), '그 방법의 역할을 다시 설명해 줘'),
      history: [{ requestId: first.requestId, question: first.question }],
    };
    const provider = vi.spyOn(worker.get(GeminiAnswer), 'generate');

    await post(followup).expect(202);
    await execute(followup.requestId);
    expect(JSON.parse(provider.mock.calls.at(-1)?.[0].question ?? '{}')).toEqual({
      question: followup.question,
      history: [{ question: first.question, answer: claimText }],
    });
    expect(await effects(followup.requestId)).toMatchObject({ state: 'PUBLISHED', question: null });
    await post(followup).expect(202);
    await execute(followup.requestId);
    expect(provider).toHaveBeenCalledTimes(2);
    await post({ ...followup, history: [] }).expect(409);
  });

  it('다른 자료·만료된 답변·다른 owner의 대화 문맥은 예약 전에 거부한다', async () => {
    const first = command();

    await post(first).expect(202);
    await execute(first.requestId);
    const other = await harness.app.get(MaterialsService).create(ownerId, {
      idempotencyKey: randomUUID(),
      body: '다른 자료입니다.',
    });
    const followup = {
      ...command(),
      history: [{ requestId: first.requestId, question: first.question }],
    };

    await post({
      ...followup,
      evidence: [{ materialId: other.id, revisionId: other.revisionId }],
    }).expect(409);
    await harness.pool.query(
      "update answer_requests set answer_expires_at=clock_timestamp()-interval '1 second' where request_id=$1",
      [first.requestId],
    );
    await post(followup).expect(409);
    expect(
      (await harness.pool.query('select count(*)::int as count from answer_requests')).rows[0]
        .count,
    ).toBe(1);
    const otherTokens = await harness.auth.completeLogin(GOOGLE_SUBJECT_B);
    const otherOwner = (await harness.pool.query('select id from accounts where id<>$1', [ownerId]))
      .rows[0].id;

    await harness.app.get(AnswerUsageService).grant(otherOwner, 0, policy.fingerprint);
    await agent()
      .post('/api/v1/answers')
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, `devfootnote_access=${otherTokens.access}`])
      .send(followup)
      .expect(409);
  });

  it('SSE는 owner를 검사하고 검증된 게시 답변만 전송하며 재연결로 AI를 재호출하지 않는다', async () => {
    const input = command();

    await post(input).expect(202);
    await execute(input.requestId);
    const path = `/api/v1/answers/${input.requestId}/events`;

    await agent().get(path).expect(401);
    const otherTokens = await harness.auth.completeLogin(GOOGLE_SUBJECT_B);

    await agent().get(path).set('Cookie', `devfootnote_access=${otherTokens.access}`).expect(404);

    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const response = await agent().get(path).set('Cookie', access).expect(200);

      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('"state":"PUBLISHED"');
      expect(response.text).toContain(claimText);
      expect(response.text).not.toContain('"success":true');
    }

    expect(worker.get(GeminiAnswer).generate).toHaveBeenCalledTimes(1);
    await harness.app.get(AnswerUsageService).revoke(ownerId, 1);
    const revoked = await agent().get(path).set('Cookie', access).expect(200);

    expect(revoked.text).toContain('"state":"INVALIDATED"');
    expect(revoked.text).not.toContain(claimText);
  });

  it('대기 중 SSE 연결에서도 완료된 답변을 전달하고 연결 종료가 새 호출을 만들지 않는다', async () => {
    const input = command();

    await post(input).expect(202);
    const controller = new AbortController();
    const response = await fetch(
      `${await harness.app.getUrl()}/api/v1/answers/${input.requestId}/events`,
      {
        headers: { Cookie: access },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      },
    );
    const reader = response.body?.getReader();

    try {
      expect(response.status).toBe(200);

      if (!reader) {
        throw new Error('SSE 본문이 없습니다.');
      }

      const decoder = new TextDecoder();
      let received = '';

      while (!received.includes('"state":"RESERVED"')) {
        const chunk = await reader.read();

        expect(chunk.done).toBe(false);
        received += decoder.decode(chunk.value, { stream: true });
      }

      expect(received).not.toContain(claimText);
      await execute(input.requestId);

      while (true) {
        const chunk = await reader.read();

        if (chunk.done) {
          break;
        }

        received += decoder.decode(chunk.value, { stream: true });
      }

      expect(received).toContain('"state":"PUBLISHED"');
      expect(received).toContain(claimText);
      expect(worker.get(GeminiAnswer).generate).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await reader?.cancel();
    }
  });

  it('답변 목적의 예산이 부족하면 요청과 예약을 남기지 않고 429로 거부한다', async () => {
    harness.app.get(ConfigService).set('answerPolicy', { ...policy, purposeBudgetLimit: '1' });

    await post().expect(429);
    expect(
      (await harness.pool.query('select count(*)::int as count from answer_requests')).rows[0]
        .count,
    ).toBe(0);
    expect(
      (
        await harness.pool.query(
          "select count(*)::int as count from usage_embedding_reservations where purpose='grounded-answer'",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(worker.get(GeminiAnswer).generate).not.toHaveBeenCalled();
  });

  it('출력 검증에 실패해도 검증 가능한 실제 사용량은 독립적으로 정산한다', async () => {
    const input = command();

    vi.spyOn(worker.get(GeminiAnswer), 'generate').mockRejectedValue(
      new AnswerProviderError('invalid_response', { inputTokens: 100, outputTokens: 20 }),
    );
    await post(input).expect(202);
    await execute(input.requestId);
    expect(await effects(input.requestId)).toMatchObject({
      state: 'FAILED',
      claims: null,
      reservation_state: 'settled',
      settled_amount: '80000',
      input_tokens: 100,
      output_tokens: 20,
    });
  });

  for (const change of ['edit', 'delete', 'revoke'] as const) {
    it(`호출 중 ${change === 'edit' ? '수정' : change === 'delete' ? '삭제' : '철회'}되어도 비용은 정산하고 답변은 숨긴다`, async () => {
      const input = command();

      vi.spyOn(worker.get(GeminiAnswer), 'generate').mockImplementation(async () => {
        if (change === 'edit') {
          await harness.app.get(MaterialsService).update(ownerId, saved.id, {
            idempotencyKey: randomUUID(),
            expectedRevisionId: saved.revisionId,
            body: '변경된 근거',
          });
        }

        if (change === 'delete') {
          await harness.app.get(MaterialsService).delete(ownerId, saved.id, {
            idempotencyKey: randomUUID(),
            expectedRevisionId: saved.revisionId,
          });
        }

        if (change === 'revoke') {
          await harness.app.get(AnswerUsageService).revoke(ownerId, 1);
        }

        return candidate;
      });
      await post(input).expect(202);
      await execute(input.requestId);
      expect(await effects(input.requestId)).toMatchObject({
        state: 'INVALIDATED',
        claims: null,
        question: null,
        reservation_state: 'settled',
        settled_amount: '80000',
      });
      expect((await read(input.requestId)).body.data.claims).toEqual([]);
    });
  }

  it('429·응답 불명은 자동 재시도 없이 예약 상한으로 정산한다', async () => {
    const input = command();

    vi.spyOn(worker.get(GeminiAnswer), 'generate').mockRejectedValue(
      new AnswerProviderError('rate_limited'),
    );
    await post(input).expect(202);
    await execute(input.requestId);
    await execute(input.requestId);
    const result = await effects(input.requestId);

    expect(result.state).toBe('FAILED');
    expect(result.settled_amount).toBe(result.reserved_maximum);
    expect(worker.get(GeminiAnswer).generate).toHaveBeenCalledTimes(1);
  });

  it('근거 부족은 NO_ANSWER이고 snapshot 밖 인용은 FAILED다', async () => {
    const first = command();

    vi.spyOn(worker.get(GeminiAnswer), 'generate').mockResolvedValue({
      ...candidate,
      insufficientEvidence: true,
      claims: [],
    });
    await post(first).expect(202);
    await execute(first.requestId);
    expect((await read(first.requestId)).body.data.state).toBe('NO_ANSWER');
    const second = command();

    vi.spyOn(worker.get(GeminiAnswer), 'generate').mockResolvedValue({
      ...candidate,
      claims: [{ text: '근거 이탈', evidenceIds: ['outside'] }],
    });
    await post(second).expect(202);
    await execute(second.requestId);
    expect((await read(second.requestId)).body.data.state).toBe('FAILED');
  });

  it('호출 전 만료는 비용 없이 해제하고 질문을 지운다', async () => {
    const input = command();

    await post(input).expect(202);
    await harness.pool.query(
      "update answer_requests set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where request_id=$1",
      [input.requestId],
    );
    await execute(input.requestId);
    expect(await effects(input.requestId)).toMatchObject({
      state: 'EXPIRED',
      question: null,
      reservation_state: 'released',
      exposure_started_at: null,
      attempts: 0,
    });
    expect(worker.get(GeminiAnswer).generate).not.toHaveBeenCalled();
  });

  it('답변 본문 TTL 뒤에는 내용이 삭제돼도 receipt가 남아 재호출하지 않는다', async () => {
    const input = command();

    await post(input).expect(202);
    await execute(input.requestId);
    await harness.pool.query(
      "update answer_requests set answer_expires_at=now()-interval '1 second' where request_id=$1",
      [input.requestId],
    );
    await execute(input.requestId);
    expect(await effects(input.requestId)).toMatchObject({
      claims: null,
      evidence: [],
      question: null,
    });
    expect((await post(input).expect(202)).body.data.state).toBe('EXPIRED');
    expect(worker.get(GeminiAnswer).generate).toHaveBeenCalledTimes(1);
  });

  it('다른 owner의 결과와 CSRF 없는 명령은 거부한다', async () => {
    const input = command();

    await post(input).expect(202);
    const other = await harness.auth.completeLogin(GOOGLE_SUBJECT_B);

    await agent()
      .get(`/api/v1/answers/${input.requestId}`)
      .set('Cookie', `devfootnote_access=${other.access}`)
      .expect(404);
    await agent().post('/api/v1/answers').set('Cookie', access).send(command()).expect(403);
  });

  it('같은 요청이 동의 행 잠금에서 경쟁해도 snapshot과 예약은 한 번만 확정된다', async () => {
    const input = command();
    const blocker = await harness.pool.connect();
    let pending = Promise.resolve<PromiseSettledResult<request.Response>[]>([]);
    let failure: unknown;

    try {
      await blocker.query('begin');
      await blocker.query(
        'select owner_id from usage_answer_consents where owner_id=$1 for update',
        [ownerId],
      );
      pending = Promise.allSettled([post(input), post(input)]);
      await vi.waitFor(
        async () => {
          const result = await harness.pool.query(
            "select count(*)::int as count from pg_stat_activity where application_name='devfootnote' and wait_event_type='Lock'",
          );

          expect(result.rows[0].count).toBe(2);
        },
        { timeout: 1500, interval: 10 },
      );
    } catch (error) {
      failure = error;
    } finally {
      try {
        await blocker.query('rollback');
      } finally {
        blocker.release();
        await pending;
      }
    }

    if (failure) {
      throw failure;
    }

    for (const result of await pending) {
      if (result.status === 'rejected') {
        throw result.reason;
      }

      expect(result.value.status).toBe(202);
    }

    expect(
      (await harness.pool.query('select count(*)::int as count from answer_requests')).rows[0]
        .count,
    ).toBe(1);
    expect(
      (
        await harness.pool.query(
          "select count(*)::int as count from usage_embedding_reservations where purpose='grounded-answer'",
        )
      ).rows[0].count,
    ).toBe(1);
    await execute(input.requestId);
    expect(worker.get(GeminiAnswer).generate).toHaveBeenCalledTimes(1);
  });

  it('snapshot 저장 실패는 앞서 만든 예약까지 같은 transaction에서 rollback한다', async () => {
    await harness.pool.query(
      "create function reject_answer_fixture() returns trigger language plpgsql as $$ begin raise exception 'fixture'; end $$",
    );
    await harness.pool.query(
      'create trigger reject_answer_fixture before insert on answer_requests for each row execute function reject_answer_fixture()',
    );

    try {
      await post().expect(500);
      expect(
        (await harness.pool.query('select count(*)::int as count from answer_requests')).rows[0]
          .count,
      ).toBe(0);
      expect(
        (
          await harness.pool.query(
            "select count(*)::int as count from usage_embedding_reservations where purpose='grounded-answer'",
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await harness.pool.query('drop trigger reject_answer_fixture on answer_requests');
      await harness.pool.query('drop function reject_answer_fixture()');
    }
  });

  it('중복 worker가 실제 동의 잠금에서 경쟁해도 STARTED와 호출은 하나다', async () => {
    const input = command();

    await post(input).expect(202);
    const blocker = await harness.pool.connect();
    let pending = Promise.resolve<PromiseSettledResult<void>[]>([]);
    let failure: unknown;

    try {
      await blocker.query('begin');
      await blocker.query(
        'select owner_id from usage_answer_consents where owner_id=$1 for update',
        [ownerId],
      );
      pending = Promise.allSettled([execute(input.requestId), execute(input.requestId)]);
      await vi.waitFor(
        async () => {
          const result = await harness.pool.query(
            "select count(*)::int as count from pg_stat_activity where application_name='devfootnote-worker' and wait_event_type='Lock'",
          );

          expect(result.rows[0].count).toBe(2);
        },
        { timeout: 1500, interval: 10 },
      );
    } catch (error) {
      failure = error;
    } finally {
      try {
        await blocker.query('rollback');
      } finally {
        blocker.release();
        await pending;
      }
    }

    if (failure) {
      throw failure;
    }

    for (const result of await pending) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }

    expect(await effects(input.requestId)).toMatchObject({
      state: 'PUBLISHED',
      attempts: 1,
      settled_amount: '80000',
    });
    expect(worker.get(GeminiAnswer).generate).toHaveBeenCalledTimes(1);
  });

  it('STARTED 뒤 crash로 결과가 없으면 만료 복구가 상한 정산하고 다시 호출하지 않는다', async () => {
    const input = command();

    await post(input).expect(202);
    await harness.pool.query(
      "update answer_requests set state='RUNNING',created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where request_id=$1",
      [input.requestId],
    );
    await harness.pool.query(
      "insert into answer_call_attempts(id,owner_id,request_id,state) values($1,$2,$3,'STARTED')",
      [randomUUID(), ownerId, input.requestId],
    );
    await harness.pool.query(
      'update usage_embedding_reservations set exposure_started_at=now() where request_id=$1',
      [input.requestId],
    );
    await execute(input.requestId);
    await execute(input.requestId);
    const result = await effects(input.requestId);

    expect(result).toMatchObject({
      state: 'EXPIRED',
      question: null,
      reservation_state: 'settled',
      attempts: 1,
    });
    expect(result.settled_amount).toBe(result.reserved_maximum);
    expect(worker.get(GeminiAnswer).generate).not.toHaveBeenCalled();
  });

  it('90일 중복 방지·비용 기록은 기간이 지난 뒤 연결 순서대로 정리한다', async () => {
    const input = command();

    await post(input).expect(202);
    await execute(input.requestId);
    await harness.pool.query(
      "update answer_requests set created_at=now()-interval '92 days',expires_at=now()-interval '91 days',answer_expires_at=now()-interval '91 days',dedupe_expires_at=now()-interval '1 day' where request_id=$1",
      [input.requestId],
    );
    await harness.pool.query(
      "update usage_embedding_reservations set completed_at=now()-interval '91 days' where request_id=$1",
      [input.requestId],
    );
    await execute(input.requestId);
    expect(
      (
        await harness.pool.query(
          'select count(*)::int as count from answer_requests where request_id=$1',
          [input.requestId],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await harness.pool.query(
          'select count(*)::int as count from answer_call_attempts where request_id=$1',
          [input.requestId],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await harness.pool.query(
          'select count(*)::int as count from usage_embedding_reservations where request_id=$1',
          [input.requestId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
});
