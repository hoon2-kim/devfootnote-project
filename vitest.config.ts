import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 통합 테스트는 컨테이너 기동·migration 때문에 hook이 길다. 단위 검사는 기본 timeout을 쓴다.
  test: {
    include: ['tests/**/*.test.ts', 'apps/api/src/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    // Nest가 require하는 빌드 모듈을 다시 변환하면 DI token·singleton이 이중 생성된다.
    server: { deps: { external: [/apps\/(api|worker)\/dist\//, /packages\/db\/dist\//] } },
    testTimeout: 15000,
    hookTimeout: 120000,
  },
});
