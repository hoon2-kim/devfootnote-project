import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AuthError } from '../apps/api/dist/modules/auth/auth.error.js';
import { logger } from '../apps/api/dist/infrastructure/logging/logger.js';
import { AuthRepository } from '../apps/api/dist/modules/auth/repositories/auth.repository.js';
import { startAuthHarness } from './auth-harness.js';
import { authEnvironment, GOOGLE_SUBJECT_A, GOOGLE_SUBJECT_B } from './auth-environment.js';

describe('Passport Google·JWT와 실제 PostgreSQL 인증', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let csrf: Awaited<ReturnType<typeof harness.issueCsrf>>;

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
    harness.setSubject(GOOGLE_SUBJECT_A);
    harness.setGoogleFailure(undefined);
    harness.resetGoogleCalls();
    csrf = await harness.issueCsrf();
  });
  const jwt = new JwtService();
  const refreshCookies = (token: string) => [...csrf.cookies, `devfootnote_refresh=${token}`];
  const accessCookie = (token: string) => `devfootnote_access=${token}`;
  const login = () => harness.auth.completeLogin(GOOGLE_SUBJECT_A);
  const agent = () => request(harness.app.getHttpServer());

  async function atDatabaseBarrier<T>(
    table: string,
    count: number,
    operation: () => PromiseLike<T>[],
  ) {
    const blocker = await harness.pool.connect();
    let pending = Promise.resolve<PromiseSettledResult<T>[]>([]);
    const failures: unknown[] = [];

    try {
      await blocker.query('begin');
      await blocker.query(`lock table ${table} in share mode`);
      pending = Promise.allSettled(operation());
      await vi.waitFor(
        async () => {
          const result = await harness.pool.query(
            "select count(*)::int as count from pg_stat_activity where application_name = 'devfootnote' and wait_event_type = 'Lock'",
          );

          expect(result.rows[0].count).toBe(count);
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
        // barrier 실패도 시작한 요청이 끝난 뒤 다음 fixture로 넘어간다.
        await pending;
      }
    }

    if (failures.length) {
      throw failures[0];
    }

    return pending;
  }

  it('barrier 관찰 실패도 잠금을 풀고 시작한 로그인들을 정리한 뒤 원래 오류를 전달한다', async () => {
    await expect(
      atDatabaseBarrier('accounts', 3, () => [
        harness.auth.completeLogin(GOOGLE_SUBJECT_A),
        harness.auth.completeLogin(GOOGLE_SUBJECT_B),
      ]),
    ).rejects.toThrow(/expected 2 to be 3/);

    expect(
      (await harness.pool.query('select count(*)::int as count from auth_refresh_tokens')).rows,
    ).toEqual([{ count: 2 }]);
  });

  it('컬럼 불일치는 정제된 500이며 refresh와 cookie를 변경하지 않는다', async () => {
    const first = await login();
    const before = (await harness.pool.query('select * from auth_refresh_tokens')).rows;
    const logs = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await harness.pool.query(
      'alter table auth_refresh_tokens rename column token_hash to broken_token_hash',
    );

    try {
      const response = await agent()
        .post('/api/v1/auth/refresh')
        .set(csrf.headers)
        .set('Cookie', refreshCookies(first.refresh))
        .expect(500, {
          success: false,
          error: 'INTERNAL_SERVER_ERROR',
          message: '요청을 처리하지 못했습니다.',
        });

      expect(response.get('Set-Cookie')).toBeUndefined();
      expect(logs).toHaveBeenCalled();
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(
        /token_hash|broken_token_hash|update |eyJ/,
      );
    } finally {
      await harness.pool.query(
        'alter table auth_refresh_tokens rename column broken_token_hash to token_hash',
      );
      logs.mockRestore();
    }

    expect((await harness.pool.query('select * from auth_refresh_tokens')).rows).toEqual(before);
  });

  it('잠금 timeout은 503이며 잠금 해제 후 같은 refresh로 복구한다', async () => {
    const first = await login();
    const blocker = await harness.pool.connect();

    try {
      await blocker.query('begin');
      await blocker.query('lock table auth_refresh_tokens in access exclusive mode');
      const response = await agent()
        .post('/api/v1/auth/refresh')
        .set(csrf.headers)
        .set('Cookie', refreshCookies(first.refresh))
        .expect(503, {
          success: false,
          error: 'SERVICE_UNAVAILABLE',
          message: '잠시 후 다시 시도해 주세요.',
        });

      expect(response.get('Set-Cookie')).toBeUndefined();
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    await agent()
      .post('/api/v1/auth/refresh')
      .set(csrf.headers)
      .set('Cookie', refreshCookies(first.refresh))
      .expect(204);
  });

  it('transaction 안의 토큰 발급 버그는 DB 불가로 분류하지 않고 계정 생성도 rollback한다', async () => {
    const repository = new AuthRepository(drizzle(harness.pool));
    const failure = repository.establishSession(
      'https://accounts.google.com',
      GOOGLE_SUBJECT_A,
      () => {
        throw new Error('PRIVATE_SIGNING_KEY_FAILURE');
      },
    );

    await expect(failure).rejects.not.toBeInstanceOf(AuthError);
    await expect(failure).rejects.not.toHaveProperty('cause');
    await expect(failure).rejects.not.toHaveProperty('message', 'PRIVATE_SIGNING_KEY_FAILURE');
    expect(
      (await harness.pool.query('select count(*)::int as count from accounts')).rows[0].count,
    ).toBe(0);
    expect(
      (await harness.pool.query('select count(*)::int as count from auth_refresh_tokens')).rows[0]
        .count,
    ).toBe(0);
  });

  it('CSRF 발급 endpoint는 인증 없이 토큰을 제공하고 캐시하지 않는다', async () => {
    const response = await agent()
      .get('/api/v1/auth/csrf')
      .expect(200)
      .expect('Cache-Control', 'no-store');

    expect(response.body).toEqual({ success: true, data: { csrfToken: expect.any(String) } });
    expect(response.body.data.csrfToken).not.toBe('');
    const cookies = response.get('Set-Cookie') ?? [];

    expect(cookies).toHaveLength(2);
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^devfootnote_csrf_binding=/),
        expect.stringMatching(/^devfootnote_csrf=/),
      ]),
    );

    for (const cookie of cookies) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      expect(cookie).not.toContain('Domain=');
    }
  });

  it('JSON으로 파싱된 비정상 CSRF 쿠키는 bootstrap에서 다시 발급한다', async () => {
    const cookies = csrf.cookies.map((cookie) =>
      cookie.startsWith('devfootnote_csrf=')
        ? `devfootnote_csrf=${encodeURIComponent('j:{}')}`
        : cookie,
    );
    const recovered = await harness.issueCsrf(cookies);

    expect(recovered.token).not.toBe(csrf.token);
    await agent()
      .post('/api/v1/auth/logout')
      .set(recovered.headers)
      .set('Cookie', recovered.cookies)
      .expect(204);
  });

  it('Google 시작 Guard가 고정 callback과 state, profile scope를 사용한다', async () => {
    const begin = await agent().get('/api/v1/auth/google').expect(302);
    const url = new URL(String(begin.headers.location));

    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(harness.callbackUrl);
    expect(url.searchParams.get('scope')).toBe('profile');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('access_type')).toBe(false);
    expect(harness.googleCalls).toEqual({ token: 0, profile: 0 });
  });

  async function authorize(cookies: string[] = [], returnTo?: string) {
    const begin = await agent()
      .get('/api/v1/auth/google')
      .query(returnTo ? { returnTo } : {})
      .set('Cookie', cookies)
      .expect(302);
    const authorization = new URL(String(begin.headers.location));
    // Google의 사용자 승인 화면만 생략한다. callback Guard와 실제 Strategy는 그대로 실행한다.
    const location = new URL(harness.callbackUrl);

    location.searchParams.set('state', authorization.searchParams.get('state') ?? '');
    location.searchParams.set('code', 'fixture-google-code');
    const cookieHeader: unknown = begin.headers['set-cookie'];

    if (!Array.isArray(cookieHeader) || typeof cookieHeader[0] !== 'string') {
      throw new Error('pre-auth cookie 누락');
    }

    return { location: location.href, binding: cookieHeader[0].split(';')[0] ?? '' };
  }

  async function callback(location: string, binding: string, cookies: string[] = []) {
    const url = new URL(location);

    return agent()
      .get(`${url.pathname}${url.search}`)
      .set('Host', url.host)
      .set('Cookie', [...cookies, binding])
      .expect(302);
  }

  async function loginViaGoogle(subject: string) {
    harness.setSubject(subject);
    const flow = await authorize();
    const completed = await callback(flow.location, flow.binding);

    expect(completed.headers.location).toBe('/library');
    const cookies = (completed.get('Set-Cookie') ?? []).map((cookie) => cookie.split(';')[0] ?? '');
    const browser = await harness.issueCsrf(cookies);
    const me = await agent().get('/api/v1/auth/me').set('Cookie', browser.cookies).expect(200);
    const ownerId: string = me.body.data.ownerId;

    return { ...browser, ownerId };
  }

  it('실제 Passport code 교환·profile 파싱·state 검증을 거쳐 로그인한다', async () => {
    const flow = await authorize();
    const response = await callback(flow.location, flow.binding);

    expect(response.headers.location).toBe('/library');
    const cookies = response.headers['set-cookie'];

    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining('devfootnote_access='),
        expect.stringContaining('devfootnote_refresh='),
      ]),
    );
    expect(JSON.stringify(cookies)).toContain('HttpOnly');
    expect(JSON.stringify(cookies)).toContain('SameSite=Lax');
    expect(JSON.stringify(cookies)).not.toContain('Domain=');
    expect(response.text).not.toMatch(/eyJ|access_token|id_token|fixture-google/);
    expect(JSON.stringify(cookies)).not.toContain('fixture-google-access-token');
    expect(harness.googleCalls).toEqual({ token: 1, profile: 1 });
    expect(
      (await harness.pool.query('select count(*)::int as count from accounts')).rows[0].count,
    ).toBe(1);
    expect(
      (await harness.pool.query('select token_hash from auth_refresh_tokens')).rows[0].token_hash,
    ).toMatch(/^[a-f0-9]{64}$/);
    const replay = await callback(flow.location, flow.binding);

    expect(replay.headers.location).toBe('/login?error=authentication_failed');
    expect(harness.googleCalls).toEqual({ token: 1, profile: 1 });
  });
  it('Google A/B는 서로 다른 계정이며 A 재로그인·refresh·logout이 B의 refresh를 바꾸지 않는다', async () => {
    const a = await loginViaGoogle(GOOGLE_SUBJECT_A);
    const b = await loginViaGoogle(GOOGLE_SUBJECT_B);

    expect(a.ownerId).not.toBe(b.ownerId);
    const bBefore = (
      await harness.pool.query('select * from auth_refresh_tokens where owner_id = $1', [b.ownerId])
    ).rows[0];

    const aAgain = await loginViaGoogle(GOOGLE_SUBJECT_A);

    expect(aAgain.ownerId).toBe(a.ownerId);
    expect(
      (await harness.pool.query('select count(*)::int as count from accounts')).rows[0].count,
    ).toBe(2);
    await agent().post('/api/v1/auth/refresh').set(a.headers).set('Cookie', a.cookies).expect(401);
    expect(
      (
        await harness.pool.query('select * from auth_refresh_tokens where owner_id = $1', [
          b.ownerId,
        ])
      ).rows[0],
    ).toEqual(bBefore);

    await agent()
      .post('/api/v1/auth/refresh')
      .set(aAgain.headers)
      .set('Cookie', aAgain.cookies)
      .expect(204);
    // logout은 회전 전의 유효한 refresh로도 그 계정의 현재 행만 철회한다.
    await agent()
      .post('/api/v1/auth/logout')
      .set(aAgain.headers)
      .set('Cookie', aAgain.cookies)
      .expect(204);
    expect(
      (
        await harness.pool.query('select * from auth_refresh_tokens where owner_id = $1', [
          a.ownerId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await harness.pool.query('select * from auth_refresh_tokens where owner_id = $1', [
          b.ownerId,
        ])
      ).rows[0],
    ).toEqual(bBefore);
    await agent()
      .get('/api/v1/auth/me')
      .set('Cookie', b.cookies)
      .expect(200, { success: true, data: { ownerId: b.ownerId } });
    await agent().post('/api/v1/auth/refresh').set(b.headers).set('Cookie', b.cookies).expect(204);
  });
  it('동일 Google subject의 동시 첫 로그인은 계정과 현재 refresh를 하나씩 만든다', async () => {
    const flows = await Promise.all([authorize(), authorize()]);
    const responses = await atDatabaseBarrier('accounts', 2, () =>
      flows.map((flow) => callback(flow.location, flow.binding)),
    );
    const ownerIds: string[] = [];

    for (const result of responses) {
      if (result.status === 'rejected') {
        throw result.reason;
      }

      const response = result.value;

      expect(response.headers.location).toBe('/library');
      const cookies = (response.get('Set-Cookie') ?? []).map(
        (cookie) => cookie.split(';')[0] ?? '',
      );
      const me = await agent().get('/api/v1/auth/me').set('Cookie', cookies).expect(200);

      ownerIds.push(me.body.data.ownerId);
    }

    expect(new Set(ownerIds).size).toBe(1);
    expect(
      (await harness.pool.query('select count(*)::int as count from accounts')).rows[0].count,
    ).toBe(1);
    expect(
      (await harness.pool.query('select count(*)::int as count from auth_refresh_tokens')).rows[0]
        .count,
    ).toBe(1);
  });
  it('callback binding·state 실패를 거부하고 pre-auth를 재사용하지 않는다', async () => {
    const flow = await authorize();

    expect(
      (await callback(flow.location, 'devfootnote_login=' + 'x'.repeat(43))).headers.location,
    ).toBe('/login?error=authentication_failed');
    expect(harness.googleCalls).toEqual({ token: 0, profile: 0 });
    expect((await callback(flow.location, flow.binding)).headers.location).toBe('/library');
    expect((await callback(flow.location, flow.binding)).headers.location).toBe(
      '/login?error=authentication_failed',
    );
    expect(
      (await harness.pool.query('select count(*)::int as count from accounts')).rows[0].count,
    ).toBe(1);
    expect(harness.googleCalls).toEqual({ token: 1, profile: 1 });
  });
  it('누락된 state와 시작 경로의 code는 Google 교환 전에 거부한다', async () => {
    const flow = await authorize();
    const withoutState = new URL(flow.location);

    withoutState.searchParams.delete('state');
    expect((await callback(withoutState.href, flow.binding)).headers.location).toBe(
      '/login?error=authentication_failed',
    );
    await agent().get('/api/v1/auth/google?code=fixture-google-code').expect(400);
    expect(harness.googleCalls).toEqual({ token: 0, profile: 0 });
  });
  it.each(['code=fixture-google-code', 'error=access_denied'])(
    '잘못된 callback·사용자 취소 %s는 장애 로그를 남기지 않는다',
    async (query) => {
      const logs = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

      try {
        await agent()
          .get(`/api/v1/auth/google/callback?${query}`)
          .expect(302)
          .expect('Location', '/login?error=authentication_failed');
        expect(logs).not.toHaveBeenCalled();
        expect(harness.googleCalls).toEqual({ token: 0, profile: 0 });
      } finally {
        logs.mockRestore();
      }
    },
  );
  it('Google 시작 경로의 JSON body code도 state 검증을 우회할 수 없다', async () => {
    const response = await agent().get('/api/v1/auth/google').send({ code: 'fixture-google-code' });

    expect.soft(response.status).toBe(400);
    expect.soft(harness.googleCalls).toEqual({ token: 0, profile: 0 });

    for (const table of ['accounts', 'auth_refresh_tokens']) {
      expect
        .soft(
          (await harness.pool.query(`select count(*)::int as count from ${table}`)).rows[0].count,
        )
        .toBe(0);
    }
  });
  it.each(['token', 'profile'] as const)(
    'Google %s 실패는 계정·refresh를 저장하지 않고 일반 오류만 반환한다',
    async (failure) => {
      harness.setGoogleFailure(failure);
      const flow = await authorize();
      const logs = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      let response: request.Response;

      try {
        response = await callback(flow.location, flow.binding);
        expect(logs.mock.calls).toEqual([['Google 로그인 콜백을 처리하지 못했습니다.']]);
      } finally {
        logs.mockRestore();
      }

      expect(response.headers.location).toBe('/login?error=authentication_failed');
      expect(response.text).not.toContain('PRIVATE_GOOGLE_ERROR');
      expect(JSON.stringify(response.headers['set-cookie'])).not.toContain('devfootnote_access=');

      for (const table of ['accounts', 'auth_refresh_tokens']) {
        expect(
          (await harness.pool.query(`select count(*)::int as count from ${table}`)).rows[0].count,
        ).toBe(0);
      }
    },
  );
  it('Google profile에 ID가 없으면 계정·refresh를 저장하지 않는다', async () => {
    harness.setSubject('');
    const flow = await authorize();

    expect((await callback(flow.location, flow.binding)).headers.location).toBe(
      '/login?error=authentication_failed',
    );

    for (const table of ['accounts', 'auth_refresh_tokens']) {
      expect(
        (await harness.pool.query(`select count(*)::int as count from ${table}`)).rows[0].count,
      ).toBe(0);
    }
  });
  it('인증 없는 me는 401, health는 공개이며 unsafe GET은 없다', async () => {
    await agent().get('/api/v1/auth/me').expect(401).expect('Cache-Control', 'no-store');
    await agent().get('/api/v1/health/live').expect(200);
    await agent().get('/api/v1/auth/logout').expect(404);
    await agent().head('/api/v1/auth/google').expect(400);
  });
  it('쿠키가 하나도 없는 첫 POST도 일반 JSON 403으로 거부한다', async () => {
    // CSRF binding이 없는 상태는 미들웨어 안에서 예외로 처리된다. 응답이 Express 기본
    // 오류 페이지로 새지 않고 공통 envelope를 유지하는지 확인한다.
    const rejected = await agent()
      .post('/api/v1/auth/logout')
      .set('Origin', harness.origin)
      .expect(403);

    expect(rejected.headers['content-type']).toContain('application/json');
    expect(rejected.body).toEqual({
      success: false,
      error: 'FORBIDDEN',
      message: '허용되지 않은 요청입니다.',
    });
    expect(
      (await harness.pool.query('select count(*)::int as count from auth_refresh_tokens')).rows[0]
        .count,
    ).toBe(0);
  });
  it('refresh는 access 없이 204, 고정 7일 만료와 새 jti를 보존하고 원문을 저장하지 않는다', async () => {
    const first = await login();
    const before = (await harness.pool.query('select * from auth_refresh_tokens')).rows[0];
    const refreshed = await agent()
      .post('/api/v1/auth/refresh')
      .set(csrf.headers)
      .set('Cookie', refreshCookies(first.refresh))
      .expect(204);
    const cookies: unknown = refreshed.headers['set-cookie'];

    if (!Array.isArray(cookies)) {
      throw new Error('갱신 cookie 누락');
    }

    const secondRefresh = cookies
      .find((cookie: string) => cookie.startsWith('devfootnote_refresh='))
      ?.split(';')[0]
      ?.slice('devfootnote_refresh='.length);
    const secondAccess = cookies
      .find((cookie: string) => cookie.startsWith('devfootnote_access='))
      ?.split(';')[0]
      ?.slice('devfootnote_access='.length);

    if (!secondRefresh || !secondAccess) {
      throw new Error('갱신 token 누락');
    }

    const oldClaims = jwt.decode(first.refresh),
      newClaims = jwt.decode(secondRefresh);

    expect(newClaims.exp).toBe(oldClaims.exp);
    expect(newClaims.jti).not.toBe(oldClaims.jti);
    expect(jwt.decode(secondAccess).exp - jwt.decode(secondAccess).iat).toBe(900);
    const after = (await harness.pool.query('select * from auth_refresh_tokens')).rows[0];

    expect(after.expires_at).toEqual(before.expires_at);
    expect(after.created_at).toEqual(before.created_at);
    expect(JSON.stringify(after)).not.toContain(secondRefresh);
    await agent()
      .post('/api/v1/auth/refresh')
      .set(csrf.headers)
      .set('Cookie', refreshCookies(secondRefresh))
      .expect(204);
    const failed = await agent()
      .post('/api/v1/auth/refresh')
      .set(csrf.headers)
      .set('Cookie', refreshCookies(secondRefresh))
      .expect(401);

    expect(failed.headers['set-cookie']).toBeUndefined();
  });
  it('동일 refresh 동시 요청은 성공 1건이며 실패 응답은 쿠키를 변경하지 않는다', async () => {
    const first = await login();
    const responses = await atDatabaseBarrier('auth_refresh_tokens', 4, () =>
      Array.from({ length: 4 }, () =>
        agent()
          .post('/api/v1/auth/refresh')
          .set(csrf.headers)
          .set('Cookie', refreshCookies(first.refresh)),
      ),
    );

    expect(
      responses.map((r) => (r.status === 'fulfilled' ? r.value.status : r.status)).sort(),
    ).toEqual([204, 401, 401, 401]);

    for (const response of responses) {
      if (response.status === 'fulfilled' && response.value.status === 401) {
        expect(response.value.headers['set-cookie']).toBeUndefined();
      }
    }
  });
  it('exact Origin·서명된 CSRF token·JSON을 모두 검사한다', async () => {
    const first = await login();

    for (const origin of ['', 'null', 'https://attacker.invalid']) {
      const attempt = agent()
        .post('/api/v1/auth/refresh')
        .set('X-CSRF-Token', csrf.token)
        .set('Cookie', refreshCookies(first.refresh));

      if (origin) {
        attempt.set('Origin', origin);
      }

      await attempt.expect(403);
    }

    await agent()
      .post('/api/v1/auth/logout')
      .set('Origin', csrf.headers.Origin)
      .set('Cookie', csrf.cookies)
      .expect(403);
    await agent()
      .post('/api/v1/auth/logout')
      .set(csrf.headers)
      .set('X-CSRF-Token', 'forged-token')
      .set('Cookie', csrf.cookies)
      .expect(403);
    await agent()
      .post('/api/v1/auth/logout')
      .set(csrf.headers)
      .set('Cookie', csrf.cookies)
      .type('form')
      .send({ a: 'b' })
      .expect(403);
  });
  it('CSRF token은 브라우저 binding에 묶이며 헤더와 쿠키를 함께 위조해도 거부한다', async () => {
    const otherBrowser = await harness.issueCsrf();
    const otherBinding = otherBrowser.cookies.find((cookie) =>
      cookie.startsWith('devfootnote_csrf_binding='),
    );

    if (!otherBinding) {
      throw new Error('다른 브라우저의 CSRF binding 누락');
    }

    const mixedCookies = csrf.cookies.map((cookie) =>
      cookie.startsWith('devfootnote_csrf_binding=') ? otherBinding : cookie,
    );

    await agent()
      .post('/api/v1/auth/logout')
      .set(csrf.headers)
      .set('Cookie', mixedCookies)
      .expect(403);

    const forgedToken = (csrf.token[0] === 'a' ? 'b' : 'a') + csrf.token.slice(1);
    const forgedCookies = csrf.cookies.map((cookie) =>
      cookie.startsWith('devfootnote_csrf=') ? `devfootnote_csrf=${forgedToken}` : cookie,
    );

    await agent()
      .post('/api/v1/auth/logout')
      .set(csrf.headers)
      .set('X-CSRF-Token', forgedToken)
      .set('Cookie', forgedCookies)
      .expect(403);
  });
  it('로그인은 CSRF를 교체하고 refresh는 유지하며 logout은 두 CSRF 쿠키를 지운다', async () => {
    const flow = await authorize(csrf.cookies);
    const completed = await callback(flow.location, flow.binding, csrf.cookies);

    expect(completed.headers.location).toBe('/library');
    const loginCookies = completed.get('Set-Cookie') ?? [];
    const current = await harness.issueCsrf([
      ...csrf.cookies,
      ...loginCookies.map((cookie) => cookie.split(';')[0] ?? ''),
    ]);

    expect(current.token).not.toBe(csrf.token);
    expect(
      current.cookies.find((cookie) => cookie.startsWith('devfootnote_csrf_binding=')),
    ).not.toBe(csrf.cookies.find((cookie) => cookie.startsWith('devfootnote_csrf_binding=')));
    await agent()
      .post('/api/v1/auth/refresh')
      .set(csrf.headers)
      .set('Cookie', current.cookies)
      .expect(403);

    const refreshed = await agent()
      .post('/api/v1/auth/refresh')
      .set(current.headers)
      .set('Cookie', current.cookies)
      .expect(204);
    const refreshUpdates = refreshed.get('Set-Cookie') ?? [];

    expect(refreshUpdates.some((cookie) => cookie.startsWith('devfootnote_csrf'))).toBe(false);
    const afterRefresh = await harness.issueCsrf([
      ...current.cookies,
      ...refreshUpdates.map((cookie) => cookie.split(';')[0] ?? ''),
    ]);

    expect(afterRefresh.token).toBe(current.token);
    const loggedOut = await agent()
      .post('/api/v1/auth/logout')
      .set(afterRefresh.headers)
      .set('Cookie', afterRefresh.cookies)
      .expect(204);
    const cleared = loggedOut.get('Set-Cookie') ?? [];

    for (const name of ['devfootnote_csrf_binding', 'devfootnote_csrf']) {
      const cookie = cleared.find((value) => value.startsWith(`${name}=`));

      expect(cookie).toContain(`${name}=;`);
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
      expect(cookie).toContain('Path=/');
    }
  });
  it('토큰 용도·서명키·issuer·audience 혼용을 거부한다', async () => {
    const first = await login();

    await agent().get('/api/v1/auth/me').set('Cookie', accessCookie(first.refresh)).expect(401);
    await agent()
      .post('/api/v1/auth/refresh')
      .set(csrf.headers)
      .set('Cookie', refreshCookies(first.access))
      .expect(401);
    const claims = jwt.decode(first.access);
    const wrongKey = jwt.sign(claims, {
      secret: authEnvironment.JWT_REFRESH_SECRET,
      algorithm: 'HS256',
    });

    await agent().get('/api/v1/auth/me').set('Cookie', accessCookie(wrongKey)).expect(401);

    for (const patch of [
      { iss: 'wrong' },
      { aud: 'wrong' },
      { token_use: 'refresh' },
      { exp: 1 },
      { sub: 'invalid' },
    ]) {
      const token = jwt.sign(
        { ...claims, ...patch },
        { secret: authEnvironment.JWT_ACCESS_SECRET, algorithm: 'HS256' },
      );

      await agent().get('/api/v1/auth/me').set('Cookie', accessCookie(token)).expect(401);
    }
  });
  it('새 로그인은 기존 refresh만 교체하며 logout 뒤 기존 access는 만료까지 유효하다', async () => {
    const first = await login();
    const next = await login();

    await agent()
      .post('/api/v1/auth/refresh')
      .set(csrf.headers)
      .set('Cookie', refreshCookies(first.refresh))
      .expect(401);
    await agent()
      .post('/api/v1/auth/logout')
      .set(csrf.headers)
      .set('Cookie', refreshCookies(next.refresh))
      .expect(204);
    await agent()
      .post('/api/v1/auth/logout')
      .set(csrf.headers)
      .set('Cookie', refreshCookies(next.refresh))
      .expect(204);
    expect(
      (await harness.pool.query('select count(*)::int as count from auth_refresh_tokens')).rows[0]
        .count,
    ).toBe(0);
    await agent().get('/api/v1/auth/me').set('Cookie', accessCookie(first.access)).expect(200);
    const now = vi.spyOn(Date, 'now').mockReturnValue(first.accessExpiresAt * 1000);

    try {
      await agent().get('/api/v1/auth/me').set('Cookie', accessCookie(first.access)).expect(401);
    } finally {
      now.mockRestore();
    }
  });
  it('회전과 logout 경쟁 뒤 refresh 행은 남지 않는다', async () => {
    const first = await login();

    const results = await atDatabaseBarrier('auth_refresh_tokens', 2, () => [
      agent()
        .post('/api/v1/auth/refresh')
        .set(csrf.headers)
        .set('Cookie', refreshCookies(first.refresh)),
      agent()
        .post('/api/v1/auth/logout')
        .set(csrf.headers)
        .set('Cookie', refreshCookies(first.refresh))
        .expect(204),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(
      (await harness.pool.query('select count(*)::int as count from auth_refresh_tokens')).rows[0]
        .count,
    ).toBe(0);
  });
  it('잘못된 binding은 정상 state를 소모하지 않는다', async () => {
    const attempt = await harness.auth.beginLogin();
    const other = await harness.auth.beginLogin();

    await expect(harness.auth.consumeOAuthState(attempt.state, other.binding)).rejects.toThrow();
    await expect(
      harness.auth.consumeOAuthState(attempt.state, attempt.binding),
    ).resolves.toBeDefined();
    await expect(harness.auth.consumeOAuthState(attempt.state, attempt.binding)).rejects.toThrow();
  });

  it('state 동시 소비는 binding·TTL을 만족한 한 요청만 성공한다', async () => {
    const attempt = await harness.auth.beginLogin();
    const results = await atDatabaseBarrier('auth_oauth_states', 2, () => [
      harness.auth.consumeOAuthState(attempt.state, attempt.binding),
      harness.auth.consumeOAuthState(attempt.state, attempt.binding),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it.each([
    ['/search?q=redis&page=2', '/search?q=redis&page=2'],
    ['/search?q=redis%20%5C', '/search?q=redis%20%5C'],
    [
      '/documents/12345678-1234-4234-8234-123456789abc?revision=12345678-1234-4234-8234-123456789def#source-title',
      '/documents/12345678-1234-4234-8234-123456789abc?revision=12345678-1234-4234-8234-123456789def#source-title',
    ],
    ['https://attacker.invalid', '/library'],
    ['//attacker.invalid', '/library'],
    ['/\\attacker.invalid', '/library'],
    ['/login', '/library'],
    ['/search?q=x&q=y', '/library'],
    ['/search?page=0', '/library'],
    ['/search?redirect=https://attacker.invalid', '/library'],
    ['/documents/not-a-uuid', '/library'],
    ['/library#unsafe', '/library'],
  ])('로그인 복귀 %s는 state에 연결된 %s로만 이동한다', async (input, expected) => {
    const flow = await authorize([], input);
    const callbackUrl = new URL(flow.location);

    callbackUrl.searchParams.set('returnTo', 'https://attacker.invalid');
    expect((await callback(callbackUrl.href, flow.binding)).headers.location).toBe(expected);
  });

  it('만료 pre-auth·refresh 정리는 최대 100건이며 잠긴 행과 미만료 행을 보존한다', async () => {
    await harness.pool.query(`insert into auth_oauth_states (state_hash, binding_hash, expires_at)
      select md5(n::text), md5(n::text), now() - interval '1 day' from generate_series(1, 150) n`);
    const valid = await harness.auth.beginLogin();

    // 위 호출에서 첫 100건이 정리된다. 다음 묶음을 추가해 잠금 회피를 함께 확인한다.
    await harness.pool.query(`insert into auth_oauth_states (state_hash, binding_hash, expires_at)
      select md5(n::text), md5(n::text), now() - interval '1 day' from generate_series(151, 300) n`);
    const blocker = await harness.pool.connect();

    try {
      await blocker.query('begin');
      const locked = await blocker.query(
        'select state_hash from auth_oauth_states where expires_at < now() order by state_hash limit 10 for update',
      );

      await harness.auth.beginLogin();
      expect(
        (
          await harness.pool.query(
            'select count(*)::int as count from auth_oauth_states where expires_at < now()',
          )
        ).rows[0].count,
      ).toBe(100);
      expect(
        (
          await harness.pool.query(
            'select state_hash from auth_oauth_states where state_hash = any($1)',
            [locked.rows.map((row) => row.state_hash)],
          )
        ).rowCount,
      ).toBe(10);
      await expect(harness.auth.consumeOAuthState(valid.state, valid.binding)).resolves.toBe(
        '/library',
      );
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    await harness.pool.query(
      `insert into accounts (issuer, subject) select 'fixture', n::text from generate_series(1, 150) n`,
    );
    await harness.pool
      .query(`insert into auth_refresh_tokens (owner_id, token_hash, created_at, expires_at)
      select id, md5(subject), now() - interval '8 days', now() - interval '1 day' from accounts`);
    const refreshBlocker = await harness.pool.connect();

    try {
      await refreshBlocker.query('begin');
      const locked = await refreshBlocker.query(
        'select owner_id from auth_refresh_tokens where expires_at < now() order by owner_id limit 10 for update',
      );

      await login();
      expect(
        (
          await harness.pool.query(
            'select count(*)::int as count from auth_refresh_tokens where expires_at < now()',
          )
        ).rows[0].count,
      ).toBe(50);
      expect(
        (
          await harness.pool.query(
            'select owner_id from auth_refresh_tokens where owner_id = any($1)',
            [locked.rows.map((row) => row.owner_id)],
          )
        ).rowCount,
      ).toBe(10);
      expect(
        (
          await harness.pool.query(
            'select count(*)::int as count from auth_refresh_tokens where expires_at > now()',
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      try {
        await refreshBlocker.query('rollback');
      } finally {
        refreshBlocker.release();
      }
    }
  });

  it('pre-auth와 refresh는 만료 equality에서 거부한다', async () => {
    const attempt = await harness.auth.beginLogin();

    await harness.pool.query('update auth_oauth_states set expires_at = now()');
    await expect(harness.auth.consumeOAuthState(attempt.state, attempt.binding)).rejects.toThrow();
    const first = await login();
    const now = vi.spyOn(Date, 'now').mockReturnValue(first.refreshExpiresAt * 1000);

    try {
      await agent()
        .post('/api/v1/auth/refresh')
        .set(csrf.headers)
        .set('Cookie', refreshCookies(first.refresh))
        .expect(401);
    } finally {
      now.mockRestore();
    }
  });
});
