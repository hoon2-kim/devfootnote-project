'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMe, logout } from '@devfootnote/api-client';
import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Wordmark } from '../../components/wordmark';
import { AuthHeader } from './auth-header';
import { ApiError, unwrapApiResult } from '../../lib/api-client';
import { useApiClient, useTerminalAuth } from '../../lib/api-provider';

const OwnerContext = createContext<string | null>(null);

export function useOwnerId() {
  const ownerId = useContext(OwnerContext);

  if (!ownerId) {
    throw new Error('인증된 화면 안에서만 사용할 수 있습니다.');
  }

  return ownerId;
}

/**
 * 인증 확인·복구가 끝나기 전 보호 화면을 숨기고 owner별 UI/cache 수명을 관리한다.
 * 클라이언트 화면 경계일 뿐이며 실제 자료 접근 권한은 API Guard와 owner 조건이 검증한다.
 */
export function AuthBoundary({ children }: { children: ReactNode }) {
  const client = useApiClient();
  const terminalAuth = useTerminalAuth();
  const redirecting = useRef(false);
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries();
      const result = await logout({ client });

      if (result.response?.status !== 204) {
        throw new ApiError(result.response?.status ?? 0);
      }
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.replace('/login');
    },
  });
  const session = useQuery({
    queryKey: ['auth', 'me'],
    enabled: !terminalAuth && !signOut.isPending && !signOut.isSuccess,
    queryFn: async ({ signal }) => {
      const result = await getMe({ client, signal });

      return unwrapApiResult(result);
    },
  });

  useEffect(() => {
    if (terminalAuth && !redirecting.current) {
      redirecting.current = true;
      void queryClient.cancelQueries();
      queryClient.clear();
      // callback 목적지는 서버가 검증한다. 여기서는 현재 상대 경로만 전달한다.
      const { pathname, search, hash } = window.location;

      window.location.replace(`/login?returnTo=${encodeURIComponent(pathname + search + hash)}`);
    }
  }, [terminalAuth, queryClient]);

  // 이전 계정의 자식 query와 UI 상태가 새 계정으로 이어지지 않도록 owner를 경계 key로 사용한다.
  useEffect(() => {
    if (session.data) {
      const ownerId = session.data.ownerId;

      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] === 'private' && query.queryKey[1] !== ownerId,
      });
    }
  }, [session.data, queryClient]);

  if (terminalAuth || session.isPending) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center px-6 py-12 text-center">
        <Wordmark />
        <div
          role="status"
          className="mt-8 flex items-center gap-3 text-sm leading-6 text-text-muted"
        >
          <LoaderCircle aria-hidden="true" className="size-5 shrink-0 motion-safe:animate-spin" />
          <p>로그인 상태를 확인하고 있습니다.</p>
        </div>
      </main>
    );
  }

  if (session.isError) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center px-4 py-12">
        <div className="mb-8 text-center">
          <Wordmark />
        </div>
        <section className="rounded-xl border border-border-subtle bg-surface p-6 sm:p-8">
          <CircleAlert
            aria-hidden="true"
            className="mb-6 size-8 text-status-error"
            strokeWidth={1.5}
          />
          <h1 className="text-2xl leading-snug font-semibold tracking-tight">
            로그인 상태를 확인하지 못했습니다
          </h1>
          <p role="alert" className="mt-4 text-base leading-7 text-text-secondary">
            {session.error instanceof ApiError && session.error.status === 403
              ? '요청이 허용되지 않았습니다. 접속 주소와 브라우저의 쿠키 설정을 확인해 주세요.'
              : '서버 또는 네트워크 연결을 확인한 뒤 다시 시도해 주세요. 자동으로 로그아웃하지 않았습니다.'}
          </p>
          <Button
            type="button"
            disabled={session.isFetching}
            onClick={() => void session.refetch()}
            className="mt-6"
          >
            {session.isFetching ? (
              <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
            ) : (
              <RotateCcw aria-hidden="true" />
            )}
            {session.isFetching ? '확인 중…' : '다시 확인'}
          </Button>
        </section>
      </main>
    );
  }

  return (
    <OwnerContext.Provider key={session.data.ownerId} value={session.data.ownerId}>
      <div>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-10 focus:rounded-lg focus:bg-surface focus:p-4"
        >
          본문으로 건너뛰기
        </a>
        <AuthHeader signingOut={signOut.isPending} onSignOut={() => signOut.mutate()} />
        {signOut.isError && (
          <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-8">
            <p
              role="alert"
              className="flex items-start gap-3 rounded-lg border border-status-error bg-surface p-4 text-sm leading-6 text-status-error"
            >
              <CircleAlert aria-hidden="true" className="mt-1 size-4 shrink-0" />
              로그아웃하지 못했습니다. 연결과 쿠키 설정을 확인한 뒤 다시 시도해 주세요.
            </p>
          </div>
        )}
        {signOut.isPending ? (
          <main id="main-content" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-16 sm:px-8">
            <p role="status" className="text-text-muted">
              안전하게 로그아웃하고 있습니다.
            </p>
          </main>
        ) : (
          children
        )}
      </div>
    </OwnerContext.Provider>
  );
}
