import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { startAuthHarness } from './auth-harness';
import { GOOGLE_SUBJECT_A, GOOGLE_SUBJECT_B } from './auth-environment';

describe('자료 수정·삭제·키워드 검색 정합성', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let csrf: Awaited<ReturnType<typeof harness.issueCsrf>>;
  let cookie: string;
  const agent = () => request(harness.app.getHttpServer());
  const create = (body: string, note = '') =>
    agent()
      .post('/api/v1/materials')
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, cookie])
      .send({ idempotencyKey: randomUUID(), body, note });
  const update = (id: string, revision: string, body: string, key = randomUUID()) =>
    agent()
      .put(`/api/v1/materials/${id}`)
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, cookie])
      .send({ idempotencyKey: key, expectedRevisionId: revision, body });
  const remove = (id: string, revision: string, key = randomUUID()) =>
    agent()
      .delete(`/api/v1/materials/${id}`)
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, cookie])
      .send({ idempotencyKey: key, expectedRevisionId: revision });
  const search = (q: string) => agent().get('/api/v1/search').query({ q }).set('Cookie', cookie);

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
    cookie = `devfootnote_access=${(await harness.auth.completeLogin(GOOGLE_SUBJECT_A)).access}`;
    csrf = await harness.issueCsrf();
  });

  it('실제 검색 응답은 정규화·다중 토큰의 일치 위치와 이모지를 보존한다', async () => {
    await create(`${'가'.repeat(300)}ＢｕｌｌＭＱ`).expect(201);
    const fullWidth = (await search('bullmq').expect(200)).body.data.items;

    expect(fullWidth).toHaveLength(1);
    expect(fullWidth[0].snippet).toContain('ＢｕｌｌＭＱ');
    await agent()
      .post('/api/v1/materials')
      .set(csrf.headers)
      .set('Cookie', [...csrf.cookies, cookie])
      .send({ idempotencyKey: randomUUID(), title: 'postgres', body: `${'가'.repeat(300)}redis` })
      .expect(201);
    const multi = (await search('postgres redis').expect(200)).body.data.items;

    expect(multi).toHaveLength(1);
    expect(multi[0]).toMatchObject({ matchedField: 'body' });
    expect(multi[0].snippet).toContain('redis');
    await create(`${'a'.repeat(239)}😀`).expect(201);
    const emoji = (await search('a').expect(200)).body.data.items;

    expect(emoji).toHaveLength(1);
    expect(emoji[0].snippet).not.toContain('\uFFFD');
    expect(emoji[0].snippet).toBe(Buffer.from(emoji[0].snippet).toString('utf8'));
  });

  it('검색 페이지는 추가 조회 행을 노출하지 않고 마지막·빈 페이지를 구분한다', async () => {
    await create('페이지경계 첫 번째').expect(201);
    await create('페이지경계 두 번째').expect(201);
    const pages = [];

    for (const page of [1, 2, 3]) {
      const response = await agent()
        .get('/api/v1/search')
        .query({ q: '페이지경계', page, pageSize: 1 })
        .set('Cookie', cookie)
        .expect(200);

      pages.push(response.body.data);
    }

    expect(
      pages.map(({ page, hasNext, items }) => ({ page, hasNext, count: items.length })),
    ).toEqual([
      { page: 1, hasNext: true, count: 1 },
      { page: 2, hasNext: false, count: 1 },
      { page: 3, hasNext: false, count: 0 },
    ]);
    expect(pages[0].items[0].id).not.toBe(pages[1].items[0].id);
  });

  it('정규화 후 변경 없는 저장은 현재 버전·수정 시각을 유지하고 receipt만 확정한다', async () => {
    const original = {
      title: '제목',
      body: '첫 줄\n둘째 줄',
      note: '메모',
      context: '',
      sourceUrl: 'https://example.com/',
    };
    const first = (
      await agent()
        .post('/api/v1/materials')
        .set(csrf.headers)
        .set('Cookie', [...csrf.cookies, cookie])
        .send({ ...original, idempotencyKey: randomUUID() })
        .expect(201)
    ).body.data;
    const before = (await harness.pool.query('select * from materials')).rows;
    const key = randomUUID();
    const unchanged = () =>
      agent()
        .put(`/api/v1/materials/${first.id}`)
        .set(csrf.headers)
        .set('Cookie', [...csrf.cookies, cookie])
        .send({
          ...original,
          title: '  제목  ',
          body: '첫 줄\r\n둘째 줄',
          note: ' 메모 ',
          context: '  ',
          expectedRevisionId: first.revisionId,
          idempotencyKey: key,
        });

    expect((await unchanged().expect(200)).body.data).toEqual(first);
    expect((await unchanged().expect(200)).body.data).toEqual(first);
    expect((await harness.pool.query('select * from materials')).rows).toEqual(before);

    for (const table of [
      'material_revisions',
      'material_chunks',
      'material_keywords',
      'embedding_intents',
    ]) {
      expect(
        (await harness.pool.query(`select count(*)::int as count from ${table}`)).rows,
      ).toEqual([{ count: 1 }]);
    }

    expect(
      (await harness.pool.query('select count(*)::int as count from material_request_receipts'))
        .rows,
    ).toEqual([{ count: 2 }]);
    expect(
      (
        await harness.pool.query(
          'select material_id, revision_id from material_request_receipts where idempotency_key = $1',
          [key],
        )
      ).rows,
    ).toEqual([{ material_id: first.id, revision_id: first.revisionId }]);
    const changed = (await update(first.id, first.revisionId, '실제로 변경한 본문').expect(200))
      .body.data;

    // 나중에 현재 버전이 바뀌어도 확정된 no-op 요청의 재전송 결과는 바뀌지 않는다.
    expect((await unchanged().expect(200)).body.data).toEqual(first);
    expect(
      (await update(first.id, first.revisionId, '다른 요청 내용', key).expect(409)).body.error,
    ).toBe('MATERIAL_REQUEST_CONFLICT');
    // 내용이 현재와 같아도 오래된 기대 버전으로 보낸 새 요청은 성공으로 위장하지 않는다.
    expect(
      (await update(first.id, first.revisionId, '실제로 변경한 본문').expect(409)).body.error,
    ).toBe('MATERIAL_REVISION_CONFLICT');
    expect(
      (await agent().get(`/api/v1/materials/${first.id}`).set('Cookie', cookie).expect(200)).body
        .data.revisionId,
    ).toBe(changed.revisionId);
    expect(
      (await harness.pool.query('select count(*)::int as count from material_request_receipts'))
        .rows,
    ).toEqual([{ count: 3 }]);
  });

  it('본문 공백과 메모만 바뀐 수정도 실제 변경으로 기록한다', async () => {
    const first = (await create('원문').expect(201)).body.data;
    const second = (await update(first.id, first.revisionId, '원문 ').expect(200)).body.data;
    const third = (
      await agent()
        .put(`/api/v1/materials/${first.id}`)
        .set(csrf.headers)
        .set('Cookie', [...csrf.cookies, cookie])
        .send({
          body: '원문 ',
          note: '메모 추가',
          expectedRevisionId: second.revisionId,
          idempotencyKey: randomUUID(),
        })
        .expect(200)
    ).body.data;

    expect(new Set([first.revisionId, second.revisionId, third.revisionId]).size).toBe(3);
    expect(
      (
        await harness.pool.query(
          'select revision, body, note from material_revisions order by revision',
        )
      ).rows,
    ).toEqual([
      { revision: 1, body: '원문', note: null },
      { revision: 2, body: '원문 ', note: null },
      { revision: 3, body: '원문 ', note: '메모 추가' },
    ]);
    expect(
      (await harness.pool.query('select count(*)::int as count from embedding_intents')).rows,
    ).toEqual([{ count: 3 }]);
  });

  it('동일한 변경 없음 요청이 경합해도 버전 추가 없이 receipt 하나만 남는다', async () => {
    const first = (await create('경쟁 원문').expect(201)).body.data;
    const key = randomUUID();
    const blocker = await harness.pool.connect();
    let pending = Promise.resolve<PromiseSettledResult<request.Response>[]>([]);

    try {
      await blocker.query('begin');
      await blocker.query('select id from materials where id = $1 for update', [first.id]);
      pending = Promise.allSettled([
        update(first.id, first.revisionId, '경쟁 원문', key),
        update(first.id, first.revisionId, '경쟁 원문', key),
      ]);
      await vi.waitFor(
        async () => {
          const locks = await harness.pool.query(
            "select count(*)::int as count from pg_stat_activity where application_name = 'devfootnote' and wait_event_type = 'Lock'",
          );

          expect(locks.rows[0].count).toBe(2);
        },
        { timeout: 800, interval: 10 },
      );
    } finally {
      try {
        await blocker.query('rollback');
      } finally {
        blocker.release();
        await pending;
      }
    }

    for (const result of await pending) {
      if (result.status === 'rejected') {
        throw result.reason;
      }

      expect(result.value.status).toBe(200);
      expect(result.value.body.data).toEqual(first);
    }

    for (const table of [
      'material_revisions',
      'material_chunks',
      'material_keywords',
      'embedding_intents',
    ]) {
      expect(
        (await harness.pool.query(`select count(*)::int as count from ${table}`)).rows,
      ).toEqual([{ count: 1 }]);
    }

    expect(
      (await harness.pool.query('select count(*)::int as count from material_request_receipts'))
        .rows,
    ).toEqual([{ count: 2 }]);
  });

  it('수정은 이전 revision을 보존하고 현재 검색 결과만 바꾼다', async () => {
    const first = (await create('old_unique 원문', '개인판단 AlphaBeta').expect(201)).body.data;

    expect((await search('개인판단 alphabeta').expect(200)).body.data.items).toHaveLength(1);
    const key = randomUUID();
    const next = (await update(first.id, first.revisionId, 'new_unique 새원문', key).expect(200))
      .body.data;

    expect(
      (await update(first.id, first.revisionId, 'new_unique 새원문', key).expect(200)).body.data,
    ).toEqual(next);
    expect((await update(first.id, first.revisionId, '다른원문', key).expect(409)).body.error).toBe(
      'MATERIAL_REQUEST_CONFLICT',
    );
    expect((await update(first.id, first.revisionId, '낡은수정').expect(409)).body.error).toBe(
      'MATERIAL_REVISION_CONFLICT',
    );
    expect((await search('old_unique').expect(200)).body.data.items).toEqual([]);
    expect((await search('new_unique').expect(200)).body.data.items).toMatchObject([
      { id: first.id, revisionId: next.revisionId, revision: 2 },
    ]);
    expect(
      (await harness.pool.query('select revision, body from material_revisions order by revision'))
        .rows,
    ).toEqual([
      { revision: 1, body: 'old_unique 원문' },
      { revision: 2, body: 'new_unique 새원문' },
    ]);

    for (const table of ['material_chunks', 'material_keywords', 'embedding_intents']) {
      expect(
        (await harness.pool.query(`select count(*)::int as count from ${table}`)).rows,
      ).toEqual([{ count: 2 }]);
    }
  });

  it('동시 수정·수정과 수정·삭제는 같은 기대 버전을 두 번 확정하지 않는다', async () => {
    for (const deletes of [false, true]) {
      const first = (await create('경쟁 이전 원문').expect(201)).body.data;
      const keys = [randomUUID(), randomUUID()];
      const blocker = await harness.pool.connect();
      let race = Promise.resolve<PromiseSettledResult<request.Response>[]>([]);
      const failures: unknown[] = [];

      try {
        await blocker.query('begin');
        await blocker.query('select id from materials where id = $1 for update', [first.id]);
        race = Promise.allSettled([
          update(first.id, first.revisionId, '승자 원문', keys[0]),
          deletes
            ? remove(first.id, first.revisionId, keys[1])
            : update(first.id, first.revisionId, '다른 승자', keys[1]),
        ]);
        await vi.waitFor(
          async () => {
            const result = await harness.pool.query<{ count: number }>(
              "select count(*)::int as count from pg_stat_activity where application_name = 'devfootnote' and wait_event_type = 'Lock'",
            );

            expect(result.rows[0]?.count).toBe(2);
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
          await race;
        }
      }

      if (failures.length) {
        throw failures[0];
      }

      const results = (await race).map((result) => {
        if (result.status === 'rejected') {
          throw result.reason;
        }

        return result.value;
      });

      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      expect([404, 409]).toContain(results.find((result) => result.status !== 200)?.status);
      const winner = results.findIndex((result) => result.status === 200);
      const deleted = deletes && winner === 1;
      const final = (
        await harness.pool.query(
          'select current_revision_id, deleted_at from materials where id = $1',
          [first.id],
        )
      ).rows[0];

      expect(final.current_revision_id).toBe(results[winner]?.body.data.revisionId);
      expect(final.deleted_at !== null).toBe(deleted);
      const receipts = await harness.pool.query(
        'select idempotency_key from material_request_receipts where material_id = $1 and idempotency_key = any($2::uuid[])',
        [first.id, keys],
      );

      expect(receipts.rows).toEqual([{ idempotency_key: keys[winner] }]);

      for (const table of [
        'material_revisions',
        'material_chunks',
        'material_keywords',
        'embedding_intents',
      ]) {
        const count = await harness.pool.query(
          `select count(*)::int as count from ${table} where material_id = $1`,
          [first.id],
        );

        expect(count.rows[0].count).toBe(deleted ? 1 : 2);
      }

      const read = await agent()
        .get(`/api/v1/materials/${first.id}`)
        .set('Cookie', cookie)
        .expect(deleted ? 404 : 200);
      const items = (await search('승자').expect(200)).body.data.items;

      if (deleted) {
        expect(items.some((item: { id: string }) => item.id === first.id)).toBe(false);
      } else {
        expect(read.body.data.body).toBe(winner === 0 ? '승자 원문' : '다른 승자');
        expect(items.filter((item: { id: string }) => item.id === first.id)).toMatchObject([
          { revisionId: final.current_revision_id },
        ]);
      }
    }
  });

  it('동시 동일 수정·삭제 재전송은 모두 같은 성공 결과다', async () => {
    const first = (await create('처음').expect(201)).body.data;
    const key = randomUUID();
    const updated = await Promise.all([
      update(first.id, first.revisionId, '갱신', key),
      update(first.id, first.revisionId, '갱신', key),
    ]);

    expect(updated.map((result) => result.status)).toEqual([200, 200]);
    expect(updated[0]?.body).toEqual(updated[1]?.body);
    const revision = updated[0]?.body.data.revisionId;
    const deleteKey = randomUUID();
    const deleted = await Promise.all([
      remove(first.id, revision, deleteKey),
      remove(first.id, revision, deleteKey),
    ]);

    expect(deleted.map((result) => result.status)).toEqual([200, 200]);
    expect(deleted[0]?.body).toEqual(deleted[1]?.body);
    await agent().get(`/api/v1/materials/${first.id}`).set('Cookie', cookie).expect(404);
    expect((await search('갱신').expect(200)).body.data.items).toEqual([]);
    expect(
      (await agent().get('/api/v1/materials').set('Cookie', cookie).expect(200)).body.data.items,
    ).toEqual([]);
  });

  it.each([
    'material_revisions',
    'material_chunks',
    'material_keywords',
    'embedding_intents',
    'material_request_receipts',
  ])('수정 중 %s 실패는 current pointer와 모든 파생 데이터를 보존한다', async (table) => {
    const first = (await create('실패 전 원문').expect(201)).body.data;

    await harness.pool.query(
      `alter table ${table} add constraint fixture_change_failure check (false) not valid`,
    );

    try {
      await update(first.id, first.revisionId, '실패할 새 원문').expect(500);
      expect(
        (await agent().get(`/api/v1/materials/${first.id}`).set('Cookie', cookie).expect(200)).body
          .data.body,
      ).toBe('실패 전 원문');

      for (const name of [
        'material_revisions',
        'material_chunks',
        'material_keywords',
        'embedding_intents',
        'material_request_receipts',
      ]) {
        expect(
          (await harness.pool.query(`select count(*)::int as count from ${name}`)).rows,
        ).toEqual([{ count: 1 }]);
      }
    } finally {
      await harness.pool.query(`alter table ${table} drop constraint fixture_change_failure`);
    }
  });

  it('삭제 receipt 실패는 tombstone도 취소하고 다른 계정은 변경·검색할 수 없다', async () => {
    const first = (await create('소유자전용 SecretToken').expect(201)).body.data;

    await harness.pool.query(
      'alter table material_request_receipts add constraint fixture_delete_failure check (false) not valid',
    );

    try {
      await remove(first.id, first.revisionId).expect(500);
    } finally {
      await harness.pool.query(
        'alter table material_request_receipts drop constraint fixture_delete_failure',
      );
    }

    await agent().get(`/api/v1/materials/${first.id}`).set('Cookie', cookie).expect(200);
    cookie = `devfootnote_access=${(await harness.auth.completeLogin(GOOGLE_SUBJECT_B)).access}`;
    await update(first.id, first.revisionId, '공격').expect(404);
    await remove(first.id, first.revisionId).expect(404);
    expect((await search('SecretToken').expect(200)).body.data.items).toEqual([]);
  });

  it('한영·부분 문자열·기호를 안전하게 검색하고 공통 pagination을 검증한다', async () => {
    await create('PostgreSQL의 트랜잭션 원자성을 100% 보장하기 foo_bar').expect(201);
    await create('별개 자료').expect(201);

    for (const q of ['postgresql 트랜잭션', '원자', '100%', 'foo_bar']) {
      const result = await search(q).expect(200).expect('Cache-Control', 'no-store');

      expect(result.body.data.items).toHaveLength(1);
      expect(result.body.data.items[0]).not.toHaveProperty('body');
    }

    expect((await search("' OR 1=1 --").expect(200)).body.data.items).toEqual([]);
    expect((await search('   ').expect(200)).body.data.items).toEqual([]);

    for (const route of ['/api/v1/materials', '/api/v1/search?q=원자']) {
      await agent().get(route).query({ page: 0 }).set('Cookie', cookie).expect(400);
      await agent().get(route).query({ pageSize: 51 }).set('Cookie', cookie).expect(400);
    }
  });
});
