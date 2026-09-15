import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  // 실행 산출물은 test-results/에만 쓴다. docs/evidence는 검증 시점에 의도적으로 보존하는 기록이다.
  outputDir: 'test-results/browser',
  reporter: [['list'], ['json', { outputFile: 'test-results/browser.json' }]],
  // 사용 중인 개발 서버와 겹치지 않도록 브라우저 검증은 별도 포트를 사용한다.
  use: { baseURL: 'http://127.0.0.1:33000', browserName: 'chromium' },
  webServer: {
    command: 'node apps/web/node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port 33000',
    url: 'http://127.0.0.1:33000/login',
    reuseExistingServer: false,
  },
});
