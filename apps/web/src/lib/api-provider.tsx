'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserApiClient } from './api-client';

const ApiContext = createContext<ReturnType<typeof createBrowserApiClient> | null>(null);
const TerminalAuthContext = createContext(false);

export function useTerminalAuth() {
  return useContext(TerminalAuthContext);
}

// 재렌더링 때 cache나 refresh 공유 상태가 초기화되지 않도록 두 client를 함께 유지한다.
// transport의 인증 종료 신호만 Context로 전달하고 화면 전환은 AuthBoundary에 맡긴다.
export function ApiProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  const [terminalAuth, setTerminalAuth] = useState(false);
  const [client] = useState(() =>
    createBrowserApiClient({ onTerminalAuth: () => setTerminalAuth(true) }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={client}>
        <TerminalAuthContext.Provider value={terminalAuth}>{children}</TerminalAuthContext.Provider>
      </ApiContext.Provider>
    </QueryClientProvider>
  );
}

export function useApiClient() {
  const client = useContext(ApiContext);

  if (!client) {
    throw new Error('ApiProvider가 필요합니다.');
  }

  return client;
}
