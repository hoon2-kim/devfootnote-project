import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMaterial,
  getMe,
  logout,
  refreshAuthentication,
} from '../packages/api-client/src/generated/index';
import {
  createBrowserApiClient,
  TerminalAuthError,
  unwrapApiResult,
} from '../apps/web/src/lib/api-client';

const origin = 'http://localhost:3000';
const csrfResponse = () =>
  Response.json({ success: true, data: { csrfToken: 'csrf-fixture-token' } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function browserTransport(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];

  vi.stubGlobal('window', { location: { origin } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);

      requests.push(request);

      return handler(request);
    }),
  );

  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe('브라우저 생성 SDK의 CSRF transport', () => {
  it('최종 인증 실패는 이미 진행 중인 보호 요청의 늦은 성공도 폐기한다', async () => {
    let release!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const terminal = vi.fn();

    browserTransport((request) => {
      if (request.url.endsWith('/csrf')) {
        return csrfResponse();
      }

      if (request.url.endsWith('/refresh')) {
        return new Response(null, { status: 401 });
      }

      return ++reads === 1 ? late : new Response(null, { status: 401 });
    });
    const client = createBrowserApiClient({ onTerminalAuth: terminal });
    const first = getMe({ client });

    await getMe({ client });
    release(Response.json({ success: true, data: { ownerId: 'late-owner' } }));
    expect((await first).data).toBeUndefined();
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('생성 SDK 오류 정규화는 상태·알려진 코드·필드 오류만 보존한다', () => {
    const issues = [{ field: 'body', code: 'maxLength', message: '본문 길이를 확인해 주세요.' }];

    expect(() =>
      unwrapApiResult({
        response: new Response(null, { status: 400 }),
        error: { error: 'VALIDATION_ERROR', errors: issues },
      }),
    ).toThrow(expect.objectContaining({ status: 400, code: 'VALIDATION_ERROR', issues }));
    expect(() =>
      unwrapApiResult({
        response: new Response(null, { status: 409 }),
        error: { error: 'MATERIAL_REVISION_CONFLICT' },
      }),
    ).toThrow(expect.objectContaining({ status: 409, code: 'MATERIAL_REVISION_CONFLICT' }));
    expect(() =>
      unwrapApiResult({
        response: new Response(null, { status: 502 }),
        error: '<html>proxy</html>',
      }),
    ).toThrow(expect.objectContaining({ status: 502, code: undefined, issues: [] }));
    expect(() => unwrapApiResult({ error: new TypeError('network') })).toThrow(
      expect.objectContaining({ status: 0, code: undefined }),
    );
  });
  it.each([401, 204])(
    'refresh %s 이후 최종 401은 인증 종료를 한 번 알리고 새 요청을 막는다',
    async (status) => {
      const terminal = vi.fn();
      const requests = browserTransport((request) =>
        request.url.endsWith('/csrf')
          ? csrfResponse()
          : request.url.endsWith('/refresh')
            ? new Response(null, { status })
            : Response.json({ success: false }, { status: 401 }),
      );
      const client = createBrowserApiClient({ onTerminalAuth: terminal });

      await getMe({ client });
      expect(terminal).toHaveBeenCalledTimes(1);
      const count = requests.length;

      await getMe({ client });
      expect(requests).toHaveLength(count);
      expect(terminal).toHaveBeenCalledTimes(1);
    },
  );

  it.each([403, 503])('refresh %s는 인증 종료 신호를 만들지 않는다', async (status) => {
    const terminal = vi.fn();

    browserTransport((request) =>
      request.url.endsWith('/csrf')
        ? csrfResponse()
        : new Response(null, { status: request.url.endsWith('/refresh') ? status : 401 }),
    );
    await getMe({ client: createBrowserApiClient({ onTerminalAuth: terminal }) });
    expect(terminal).not.toHaveBeenCalled();
  });

  it('자료 등록의 401은 같은 body와 멱등 key로 한 번만 재전송한다', async () => {
    const bodies: unknown[] = [];
    const requests = browserTransport(async (request) => {
      if (request.url.endsWith('/csrf')) {
        return csrfResponse();
      }

      if (request.url.endsWith('/refresh')) {
        return new Response(null, { status: 204 });
      }

      bodies.push(await request.json());

      return bodies.length === 1
        ? Response.json({ success: false }, { status: 401 })
        : Response.json(
            { success: true, data: { id: 'material', revisionId: 'revision' } },
            { status: 201 },
          );
    });
    const body = { idempotencyKey: '5b9bce91-fbd4-4f71-a76a-7052fd90a482', body: '보존할 원문' };
    const result = await createMaterial({ client: createBrowserApiClient(), body });

    expect(result.response?.status).toBe(201);
    expect(bodies).toEqual([body, body]);
    expect(requests.filter((request) => request.url.endsWith('/refresh'))).toHaveLength(1);
  });
  it('동시 401과 늦게 도착한 같은 요청 묶음의 401은 재발급 한 번만 공유한다', async () => {
    let releaseLate!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => {
      releaseLate = resolve;
    });
    let reads = 0;
    const requests = browserTransport((request) => {
      if (request.url.endsWith('/csrf')) {
        return csrfResponse();
      }

      if (request.url.endsWith('/refresh')) {
        return new Response(null, { status: 204 });
      }

      reads++;

      if (reads === 1) {
        return Response.json({ success: false }, { status: 401 });
      }

      if (reads === 2) {
        return late;
      }

      return Response.json({ success: true, data: { ownerId: 'owner-fixture' } });
    });
    const client = createBrowserApiClient();
    const first = getMe({ client });
    const second = getMe({ client });

    expect((await first).response?.status).toBe(200);
    releaseLate(Response.json({ success: false }, { status: 401 }));
    expect((await second).response?.status).toBe(200);
    expect(requests.filter((request) => request.url.endsWith('/refresh'))).toHaveLength(1);
    expect(reads).toBe(4);
  });

  it.each([401, 403, 503])('재발급 %s는 재시도 없이 해당 실패로 전달한다', async (status) => {
    const requests = browserTransport((request) =>
      request.url.endsWith('/csrf')
        ? csrfResponse()
        : Response.json(
            { success: false },
            { status: request.url.endsWith('/refresh') ? status : 401 },
          ),
    );
    const result = await getMe({ client: createBrowserApiClient() });

    expect(result.error).toMatchObject({ status });
    expect(requests.filter((request) => request.url.endsWith('/refresh'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith('/me'))).toHaveLength(1);
  });

  it('재발급 network 실패는 로그인 만료로 바꾸지 않는다', async () => {
    browserTransport((request) => {
      if (request.url.endsWith('/csrf')) {
        return csrfResponse();
      }

      if (request.url.endsWith('/refresh')) {
        throw new TypeError('Network unavailable');
      }

      return Response.json({ success: false }, { status: 401 });
    });
    expect((await getMe({ client: createBrowserApiClient() })).error).toMatchObject({ status: 0 });
  });
  it('재발급 전 CSRF 발급의 403을 보존하고 refresh POST는 보내지 않는다', async () => {
    const requests = browserTransport((request) =>
      Response.json(
        { success: false },
        {
          status: request.url.endsWith('/csrf') ? 403 : 401,
        },
      ),
    );

    expect((await getMe({ client: createBrowserApiClient() })).error).toMatchObject({
      status: 403,
    });
    expect(requests.filter((request) => request.url.endsWith('/refresh'))).toHaveLength(0);
  });

  it('재전송도 401이면 두 번째 refresh를 하지 않는다', async () => {
    const requests = browserTransport((request) => {
      if (request.url.endsWith('/csrf')) {
        return csrfResponse();
      }

      if (request.url.endsWith('/refresh')) {
        return new Response(null, { status: 204 });
      }

      return Response.json({ success: false }, { status: 401 });
    });

    expect((await getMe({ client: createBrowserApiClient() })).error).toBeInstanceOf(
      TerminalAuthError,
    );
    expect(requests.filter((request) => request.url.endsWith('/refresh'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith('/me'))).toHaveLength(2);
  });

  it('보호 API의 403과 멱등성 미보장 mutation의 401은 자동 재발급·재전송하지 않는다', async () => {
    const requests = browserTransport((request) =>
      request.url.endsWith('/csrf')
        ? csrfResponse()
        : Response.json({ success: false }, { status: request.method === 'GET' ? 403 : 401 }),
    );
    const client = createBrowserApiClient();

    expect((await getMe({ client })).response?.status).toBe(403);
    expect(
      (await client.patch({ url: '/api/v1/materials/fixture', body: { text: 'fixture' } })).response
        ?.status,
    ).toBe(401);
    expect(requests.filter((request) => request.url.endsWith('/refresh'))).toHaveLength(0);
    expect(requests.filter((request) => request.url.endsWith('/materials/fixture'))).toHaveLength(
      1,
    );
  });

  it('logout은 진행 중인 refresh를 기다리고 이전 조회 결과를 버린다', async () => {
    let releaseRefresh!: (response: Response) => void;
    const refreshed = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const requests = browserTransport((request) => {
      if (request.url.endsWith('/csrf')) {
        return csrfResponse();
      }

      if (request.url.endsWith('/refresh')) {
        refreshStarted();

        return refreshed;
      }

      if (request.url.endsWith('/logout')) {
        return new Response(null, { status: 204 });
      }

      return Response.json({ success: false }, { status: 401 });
    });
    const client = createBrowserApiClient();
    const read = getMe({ client });

    await started;
    const signedOut = logout({ client });

    // CSRF bootstrap 완료를 기다린 뒤에도 refresh보다 먼저 logout을 보내지 않는다.
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.url.endsWith('/csrf'))).toHaveLength(2),
    );
    expect(requests.filter((request) => request.url.endsWith('/logout'))).toHaveLength(0);
    releaseRefresh(new Response(null, { status: 204 }));
    expect((await signedOut).response?.status).toBe(204);
    expect((await read).error).toMatchObject({ name: 'AbortError' });
    expect((await getMe({ client })).error).toMatchObject({ name: 'AbortError' });
    expect(requests.filter((request) => request.url.endsWith('/me'))).toHaveLength(1);
  });
  it('logout 전송 중·완료 후 새 mutation은 CSRF bootstrap 전에 거부한다', async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    const requests = browserTransport((request) => {
      if (request.url.endsWith('/csrf')) {
        return csrfResponse();
      }

      started.resolve();

      return response.promise;
    });
    const client = createBrowserApiClient();
    const signedOut = logout({ client });

    try {
      await started.promise;
      expect(
        (await createMaterial({ client, body: { body: 'fixture', idempotencyKey: 'fixture' } }))
          .error,
      ).toMatchObject({ name: 'AbortError' });
      expect(requests.filter((request) => request.url.endsWith('/csrf'))).toHaveLength(1);
    } finally {
      response.resolve(new Response(null, { status: 204 }));
      await signedOut;
    }

    expect(
      (await createMaterial({ client, body: { body: 'fixture', idempotencyKey: 'fixture' } }))
        .error,
    ).toMatchObject({ name: 'AbortError' });
    expect(requests.filter((request) => request.url.endsWith('/csrf'))).toHaveLength(1);
  });

  it('logout bootstrap 대기 중에도 새 mutation은 즉시 차단하고 실패 후 gate를 복구한다', async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    let waiting = true;
    const requests = browserTransport((request) => {
      if (request.url.endsWith('/csrf')) {
        if (waiting) {
          started.resolve();

          return response.promise;
        }

        return csrfResponse();
      }

      return new Response(null, { status: 204 });
    });
    const client = createBrowserApiClient();
    const signedOut = logout({ client });

    await started.promise;
    let blocked = false;
    const mutation = createMaterial({
      client,
      body: { body: 'fixture', idempotencyKey: 'fixture' },
    }).then((result) => {
      blocked = result.error instanceof DOMException && result.error.name === 'AbortError';
    });

    try {
      await vi.waitFor(() => expect(blocked).toBe(true), { timeout: 200 });
    } finally {
      response.resolve(Response.json({ success: false }, { status: 503 }));
      await Promise.allSettled([signedOut, mutation]);
    }

    waiting = false;
    expect((await getMe({ client })).response?.status).toBe(204);
    expect((await logout({ client })).response?.status).toBe(204);
    expect(requests.filter((request) => request.url.endsWith('/materials'))).toHaveLength(0);
  });

  it('먼저 진행 중인 mutation bootstrap을 logout이 기다리고 mutation은 보내지 않는다', async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    const requests = browserTransport((request) => {
      if (request.url.endsWith('/csrf')) {
        started.resolve();

        return response.promise;
      }

      return new Response(null, { status: 204 });
    });
    const client = createBrowserApiClient();
    const mutation = createMaterial({
      client,
      body: { body: 'fixture', idempotencyKey: 'fixture' },
    });

    await started.promise;
    const signedOut = logout({ client });

    response.resolve(csrfResponse());
    const [saved, ended] = await Promise.all([mutation, signedOut]);

    expect(saved.error).toMatchObject({ name: 'AbortError' });
    expect(ended.response?.status).toBe(204);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/v1/auth/csrf',
      '/api/v1/auth/logout',
    ]);
  });

  it('조회는 같은 origin의 cookie transport만 사용하고 CSRF를 발급하지 않는다', async () => {
    const requests = browserTransport(() =>
      Response.json({ success: true, data: { ownerId: 'owner-fixture' } }),
    );
    const result = await getMe({ client: createBrowserApiClient() });

    expect(result.response?.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${origin}/api/v1/auth/me`);
    expect(requests[0]?.credentials).toBe('same-origin');
    expect(requests[0]?.headers.has('X-CSRF-Token')).toBe(false);
    expect(requests[0]?.headers.has('Authorization')).toBe(false);
    expect(requests[0]?.headers.has('Cookie')).toBe(false);
  });

  it.each([
    { name: 'refresh', operation: refreshAuthentication },
    { name: 'logout', operation: logout },
  ])('$name 요청은 CSRF 확인 뒤 전송하며 204를 유지한다', async ({ operation }) => {
    const requests = browserTransport((request) =>
      request.method === 'GET' ? csrfResponse() : new Response(null, { status: 204 }),
    );

    const result = await operation({ client: createBrowserApiClient() });

    expect(result.response?.status).toBe(204);
    expect(result.error).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`${origin}/api/v1/auth/csrf`);
    expect(requests[0]?.cache).toBe('no-store');
    expect(requests[1]?.method).toBe('POST');
    expect(requests[1]?.headers.get('X-CSRF-Token')).toBe('csrf-fixture-token');

    for (const request of requests) {
      expect(request.credentials).toBe('same-origin');
      expect(request.headers.has('Authorization')).toBe(false);
      expect(request.headers.has('Cookie')).toBe(false);
    }
  });

  it('동시 unsafe 요청은 진행 중인 CSRF 발급만 공유한다', async () => {
    let issueToken!: (response: Response) => void;
    const issued = new Promise<Response>((resolve) => {
      issueToken = resolve;
    });
    let beginIssuing!: () => void;
    const started = new Promise<void>((resolve) => {
      beginIssuing = resolve;
    });
    let bootstrap = true;
    const requests = browserTransport((request) => {
      if (request.method === 'GET') {
        if (!bootstrap) {
          return csrfResponse();
        }

        bootstrap = false;
        beginIssuing();

        return issued;
      }

      return new Response(null, { status: 204 });
    });
    const client = createBrowserApiClient();
    const pending = Promise.all([
      refreshAuthentication({ client }),
      refreshAuthentication({ client }),
    ]);

    await started;
    issueToken(csrfResponse());
    const results = await pending;

    expect(results.map((result) => result.response?.status)).toEqual([204, 204]);
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2);

    // 후속 요청은 로그인·로그아웃 이후의 cookie 상태를 서버에서 다시 확인한다.
    expect((await logout({ client })).response?.status).toBe(204);
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(2);
  });

  it.each(['http', 'network'])(
    'CSRF 발급 %s 실패 시 mutation을 보내지 않고 다음 명시적 요청에서 재확인한다',
    async (failure) => {
      let fail = true;
      const requests = browserTransport((request) => {
        if (request.method === 'POST') {
          return new Response(null, { status: 204 });
        }

        if (!fail) {
          return csrfResponse();
        }

        if (failure === 'network') {
          throw new TypeError('Network unavailable');
        }

        return Response.json({ success: false, error: 'FORBIDDEN' }, { status: 403 });
      });
      const client = createBrowserApiClient();
      const result = await logout({ client });

      expect(result.error).toBeDefined();
      expect(requests.map((request) => request.method)).toEqual(['GET']);

      fail = false;
      const retry = await logout({ client });

      expect(retry.response?.status).toBe(204);
      expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'POST']);
    },
  );

  it('mutation의 403을 자동 재시도하거나 refresh로 바꾸지 않는다', async () => {
    const requests = browserTransport((request) =>
      request.method === 'GET'
        ? csrfResponse()
        : Response.json({ success: false, error: 'FORBIDDEN' }, { status: 403 }),
    );

    const result = await logout({ client: createBrowserApiClient() });

    expect(result.response?.status).toBe(403);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/v1/auth/csrf',
      '/api/v1/auth/logout',
    ]);
  });
});
