import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 통합 테스트는 컨테이너 기동·migration 때문에 hook이 길다. 단위 검사는 기본 timeout을 쓴다.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 120000 },
});
