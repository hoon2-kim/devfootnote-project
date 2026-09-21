import { getCsrfToken, refreshAuthentication } from '@devfootnote/api-client';
import { createClient } from '@devfootnote/api-client/client';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly issues: { field: string; code: string; message: string }[] = [],
  ) {
    super('API 요청을 완료하지 못했습니다.');
  }
}

export class TerminalAuthError extends ApiError {
  constructor() {
    super(401, 'AUTHENTICATION_REQUIRED');
  }
}

const publicErrorCodes = new Set([
  'VALIDATION_ERROR',
  'AUTHENTICATION_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'CLIENT_ERROR',
  'INTERNAL_SERVER_ERROR',
  'MATERIAL_REQUEST_CONFLICT',
  'MATERIAL_REVISION_CONFLICT',
  'MATERIAL_NOT_FOUND',
]);

// SDK의 transport.data와 서버 envelope.data를 구분한다. 화면별 안내·복구는 feature가 맡는다.
export function unwrapApiResult<T>(result: {
  data?: { data: T };
  error?: unknown;
  response?: Response;
}): T {
  if (result.data) {
    return result.data.data;
  }

  throw normalizeApiError(result.error, result.response?.status ?? 0);
}

function normalizeApiError(error: unknown, status: number): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (!error || typeof error !== 'object') {
    return new ApiError(status);
  }

  const code =
    'error' in error && typeof error.error === 'string' && publicErrorCodes.has(error.error)
      ? error.error
      : undefined;
  const issues =
    code === 'VALIDATION_ERROR' && 'errors' in error && Array.isArray(error.errors)
      ? error.errors.filter(
          (issue): issue is ApiError['issues'][number] =>
            issue !== null &&
            typeof issue === 'object' &&
            typeof issue.field === 'string' &&
            typeof issue.code === 'string' &&
            typeof issue.message === 'string',
        )
      : [];

  return new ApiError(status, code, issues);
}

/**
 * 생성 SDK에 CSRF·401 재발급·로그아웃 요청 순서를 연결하는 브라우저 transport.
 * 동시 요청이 같은 복구 상태를 쓰도록 ApiProvider가 인스턴스를 유지한다. 탭 간 조율은 하지 않는다.
 */
export function createBrowserApiClient({ onTerminalAuth }: { onTerminalAuth?: () => void } = {}) {
  let csrfRequest: Promise<string> | undefined;
  let lastRefresh: Promise<void> | undefined;
  let refreshing = false;
  let refreshVersion = 0;
  let signingOut = false;
  let privateRequests = new AbortController();
  let authenticationEnded = false;

  function resumeAfterFailedLogout() {
    signingOut = false;
    privateRequests = new AbortController();
  }

  function endAuthentication() {
    if (!authenticationEnded) {
      authenticationEnded = true;
      privateRequests.abort();
      onTerminalAuth?.();
    }

    return new TerminalAuthError();
  }

  const client = createClient({
    // Client Component의 사전 렌더링에서는 요청하지 않는다. 실제 요청은 브라우저에서만 시작한다.
    baseUrl: typeof window === 'undefined' ? undefined : window.location.origin,
    credentials: 'same-origin',
    cache: 'no-store',
    fetch: async (input) => {
      const request = new Request(input);
      const path = new URL(request.url).pathname;
      const protectedRequest = path === '/api/v1/auth/me' || !path.startsWith('/api/v1/auth/');

      if (authenticationEnded && protectedRequest) {
        throw new TerminalAuthError();
      }

      if (path === '/api/v1/auth/logout') {
        let completed = false;

        try {
          // 회전 응답의 Set-Cookie가 logout의 쿠키 삭제보다 늦게 도착하지 않게 한다.
          if (refreshing) {
            try {
              await lastRefresh;
            } catch {
              /* 재발급 실패여도 명시적 logout은 시도한다. */
            }
          }

          const response = await fetch(request);

          completed = response.status === 204;

          return response;
        } finally {
          // 성공 후 화면 전환 사이의 me 재조회가 CSRF 쿠키를 다시 만들지 못하게 한다.
          // 실패한 logout만 같은 페이지에서 다시 시도할 수 있다.
          if (!completed) {
            resumeAfterFailedLogout();
          }
        }
      }

      if (!protectedRequest) {
        return fetch(request);
      }

      if (signingOut) {
        throw new DOMException('종료 중이거나 종료된 인증 요청입니다.', 'AbortError');
      }

      const signal = AbortSignal.any([request.signal, privateRequests.signal]);

      if (refreshing) {
        await lastRefresh;
      }

      signal.throwIfAborted();
      const version = refreshVersion;
      // 자료 mutation은 서버 멱등성 계약이 있다. 첫 전송 전에 동일 body의 재전송본을 보존한다.
      const replay =
        ['GET', 'HEAD'].includes(request.method) ||
        (request.method === 'POST' && path === '/api/v1/materials') ||
        (['PUT', 'DELETE'].includes(request.method) &&
          /^\/api\/v1\/materials\/[0-9a-f-]+$/i.test(path))
          ? request.clone()
          : undefined;
      const response = await fetch(new Request(request, { signal }));

      signal.throwIfAborted();

      if (response.status !== 401 || !replay) {
        return response;
      }

      // 먼저 도착한 401이 이미 재발급을 시작했다면 늦은 401도 그 결과를 공유한다.
      // 진행 여부만 보면 재발급 완료 뒤 도착한 응답이 불필요한 두 번째 회전을 시작할 수 있다.
      if (!lastRefresh || version === refreshVersion) {
        refreshVersion++;
        refreshing = true;
        lastRefresh = refreshAuthentication({ client })
          .then((result) => {
            if (result.response?.status === 401) {
              throw endAuthentication();
            }

            if (result.error instanceof ApiError) {
              throw result.error;
            }

            if (result.response?.status !== 204) {
              throw normalizeApiError(result.error, result.response?.status ?? 0);
            }
          })
          .finally(() => {
            refreshing = false;
          });
      }

      await lastRefresh;
      signal.throwIfAborted();
      const retried = await fetch(new Request(replay, { signal }));

      signal.throwIfAborted();

      if (retried.status === 401) {
        throw endAuthentication();
      }

      return retried;
    },
  });

  client.interceptors.request.use(async (request) => {
    if (authenticationEnded) {
      throw new TerminalAuthError();
    }

    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return request;
    }

    if (signingOut) {
      throw new DOMException('종료 중이거나 종료된 인증 요청입니다.', 'AbortError');
    }

    const isLogout = new URL(request.url).pathname === '/api/v1/auth/logout';
    const signal = privateRequests.signal;

    if (isLogout) {
      // bootstrap 전에 차단해야 뒤늦은 mutation이 삭제된 CSRF cookie를 다시 만들지 않는다.
      signingOut = true;
      privateRequests.abort();
    }

    try {
      // 먼저 시작된 발급은 logout도 기다린다. GET인 logout bootstrap 자체는 gate를 통과한다.
      csrfRequest ??= getCsrfToken({ client, cache: 'no-store' })
        .then((result) => unwrapApiResult(result).csrfToken)
        .finally(() => {
          csrfRequest = undefined;
        });
      request.headers.set('X-CSRF-Token', await csrfRequest);
      request.signal.throwIfAborted();

      if (!isLogout) {
        // 실패한 logout이 새 controller를 만들어도 이전 대기 요청을 되살리지 않는다.
        signal.throwIfAborted();
      }
    } catch (error) {
      if (isLogout) {
        resumeAfterFailedLogout();
      }

      throw error;
    }

    return request;
  });

  return client;
}
