import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { logger } from '../apps/api/dist/infrastructure/logging/logger.js';
import { startAuthHarness } from './auth-harness';
import { GOOGLE_SUBJECT_A, GOOGLE_SUBJECT_B } from './auth-environment';

describe('자료 등록·목록·현재 원문 / 실제 PostgreSQL', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let csrf: Awaited<ReturnType<typeof harness.issueCsrf>>;
  let access: string;
  const agent = () => request(harness.app.getHttpServer());
  const create = (body: object) =>
    agent()
      .post('/api/v1/materials')
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, access])
      .send(body);
  const read = (id: string, cookie = access) =>
    agent().get(`/api/v1/materials/${id}`).set('Cookie', cookie);
  const input = () => ({
    idempotencyKey: randomUUID(),
    body: '# PostgreSQL\n트랜잭션과 원자 저장',
    title: '저장 근거',
    note: '내 판단',
    context: '개발 중',
    sourceUrl: 'https://example.com/docs',
  });
  const tableNames = [
    'materials',
    'material_revisions',
    'material_chunks',
    'material_keywords',
    'material_request_receipts',
    'embedding_intents',
  ];

  async function counts() {
    return Promise.all(
      tableNames.map(
        async (table) =>
          (
            await harness.pool.query<{ count: number }>(
              `select count(*)::int as count from ${table}`,
            )
          ).rows[0]?.count,
      ),
    );
  }

  beforeAll(async () => {
    harness = await startAuthHarness();
  });
  afterAll(async () => {
    await harness?.close();
  });
  beforeEach(async () => {
    await harness.pool.query(
      'truncate auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents',
    );
    access = `devfootnote_access=${(await harness.auth.completeLogin(GOOGLE_SUBJECT_A)).access}`;
    csrf = await harness.issueCsrf();
  });

  it('저장 commit에 revision·chunk·keyword·receipt·intent가 함께 있고 SDK envelope와 읽기가 일치한다', async () => {
    const values = input();
    const saved = await create(values).expect(201);

    expect(Object.keys(saved.body).sort()).toEqual(['data', 'success']);
    expect(saved.body.data).toEqual({ id: expect.any(String), revisionId: expect.any(String) });
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
    const result = await read(saved.body.data.id).expect(200).expect('Cache-Control', 'no-store');

    expect(result.body.data).toMatchObject({
      id: saved.body.data.id,
      revisionId: saved.body.data.revisionId,
      revision: 1,
      body: values.body,
      title: values.title,
      note: values.note,
    });
    expect(result.body.data).not.toHaveProperty('ownerId');
    const projection = await harness.pool.query('select normalized_text from material_keywords');

    expect(projection.rows[0].normalized_text).toContain('postgresql');
    expect(projection.rows[0].normalized_text).toContain('내 판단');
    const intent = (await harness.pool.query('select * from embedding_intents')).rows[0];

    expect(Object.keys(intent).sort()).toEqual([
      'content_fingerprint',
      'id',
      'material_id',
      'owner_id',
      'revision_id',
    ]);
  });

  it('동일 재전송·정규화된 재전송은 같은 결과, 다른 입력은 409다', async () => {
    const values = { ...input(), body: '본문\r\n둘째 줄', title: ' 제목 ' };
    const first = await create(values).expect(201);

    expect(
      (await create({ ...values, body: '본문\n둘째 줄', title: '제목' }).expect(201)).body,
    ).toEqual(first.body);
    const conflict = await create({ ...values, body: '다른 원문' }).expect(409);

    expect(conflict.body.error).toBe('MATERIAL_REQUEST_CONFLICT');
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('동시 같은 요청은 단일 효과이며 다른 payload 경쟁은 하나만 성공한다', async () => {
    const values = input();
    const blocker = await harness.pool.connect();
    let concurrent: Promise<request.Response[]>;

    try {
      await blocker.query('begin');
      // 조회는 허용하고 receipt insert만 막아 모든 요청이 기존 receipt 없이 저장에 진입하게 한다.
      await blocker.query('lock table material_request_receipts in share mode');
      concurrent = Promise.all(Array.from({ length: 5 }, () => create(values)));
      await vi.waitFor(
        async () => {
          const result = await harness.pool.query<{ count: number }>(
            "select count(*)::int as count from pg_locks where relation = 'material_request_receipts'::regclass and not granted",
          );

          expect(result.rows[0]?.count).toBe(5);
        },
        { timeout: 800, interval: 10 },
      );
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    const responses = await concurrent;

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(responses.map((response) => response.body.data.id)).size).toBe(1);
    expect(await counts()).toEqual([1, 1, 1, 1, 1, 1]);
    const next = input();
    const conflicts = await Promise.all([create(next), create({ ...next, body: '경쟁하는 본문' })]);

    expect(conflicts.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await counts()).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it('다른 계정·삭제 자료는 읽기와 목록에서 제외하고 owner 입력은 거부한다', async () => {
    const values = input();
    const first = await create(values).expect(201);
    const other = `devfootnote_access=${(await harness.auth.completeLogin(GOOGLE_SUBJECT_B)).access}`;

    await read(first.body.data.id, other).expect(404);
    const list = await agent().get('/api/v1/materials').set('Cookie', other).expect(200);

    expect(list.body.data.items).toEqual([]);
    await create({ ...input(), ownerId: randomUUID() }).expect(400);
    await harness.pool.query('update materials set deleted_at = now() where id = $1', [
      first.body.data.id,
    ]);
    await read(first.body.data.id).expect(404);
    expect(
      (await agent().get('/api/v1/materials').set('Cookie', access).expect(200)).body.data.items,
    ).toEqual([]);
  });

  it('목록은 안정된 순서·페이지 크기로 나누고 과거 revision을 읽지 않는다', async () => {
    const first = await create(input()).expect(201);
    const second = await create(input()).expect(201);
    const list = await agent()
      .get('/api/v1/materials?page=1&pageSize=1')
      .set('Cookie', access)
      .expect(200);

    expect(list.body.data).toMatchObject({
      page: 1,
      hasNext: true,
      items: [{ id: second.body.data.id }],
    });
    expect(
      (await agent().get('/api/v1/materials?page=2&pageSize=1').set('Cookie', access)).body.data,
    ).toMatchObject({ hasNext: false, items: [{ id: first.body.data.id }] });
    const revision = randomUUID();

    await harness.pool.query(
      'insert into material_revisions (id, owner_id, material_id, revision, body, content_fingerprint) select $1, owner_id, id, 2, $2, $3 from materials where id = $4',
      [revision, '최신 원문', 'test-fingerprint', first.body.data.id],
    );
    await harness.pool.query('update materials set current_revision_id = $1 where id = $2', [
      revision,
      first.body.data.id,
    ]);
    expect((await read(first.body.data.id).expect(200)).body.data).toMatchObject({
      revisionId: revision,
      body: '최신 원문',
    });
  });

  it.each([
    'material_revisions',
    'material_chunks',
    'material_keywords',
    'embedding_intents',
    'material_request_receipts',
  ])('%s 쓰기 실패는 전체 rollback과 정제된 500이다', async (table) => {
    const logs = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await harness.pool.query(
      `alter table ${table} add constraint fixture_reject_insert check (false) not valid`,
    );

    try {
      const response = await create(input()).expect(500);

      expect(response.body.error).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(response.body) + JSON.stringify(logs.mock.calls)).not.toMatch(
        /fixture_reject|insert into|저장 근거|내 판단|params|cause/i,
      );
      expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      await harness.pool.query(`alter table ${table} drop constraint fixture_reject_insert`);
      logs.mockRestore();
    }
  });

  it('DB FK가 다른 material의 current pointer와 교차 owner chunk를 거부한다', async () => {
    const first = await create(input()).expect(201);
    const second = await create(input()).expect(201);

    await expect(
      harness.pool.query('update materials set current_revision_id = $1 where id = $2', [
        second.body.data.revisionId,
        first.body.data.id,
      ]),
    ).rejects.toMatchObject({ code: '23503', constraint: 'materials_current_revision_fk' });
    await expect(
      harness.pool.query('update material_chunks set owner_id = $1 where material_id = $2', [
        randomUUID(),
        first.body.data.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('잠금 timeout은 503이며 해제 뒤 같은 요청으로 저장할 수 있다', async () => {
    const blocker = await harness.pool.connect();
    const values = input();

    try {
      await blocker.query('begin');
      await blocker.query('lock table materials in access exclusive mode');
      await create(values).expect(503);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
    await create(values).expect(201);
  });

  it('인증·CSRF와 DTO 경계에서 잘못된 입력을 저장하지 않는다', async () => {
    await agent().get('/api/v1/materials').expect(401);
    await agent().post('/api/v1/materials').set('Cookie', access).send(input()).expect(403);

    for (const values of [
      { body: '  ' },
      { body: 'x'.repeat(10001) },
      { title: null },
      { sourceUrl: 'javascript:alert(1)' },
      { body: 'x\0y' },
      { idempotencyKey: 'not-a-uuid' },
    ]) {
      await create({ ...input(), ...values }).expect(400);
    }

    await agent().get('/api/v1/materials?pageSize=0').set('Cookie', access).expect(400);
    await read('bad-id').expect(400);
    expect(await counts()).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
