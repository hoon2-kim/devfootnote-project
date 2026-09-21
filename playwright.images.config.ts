import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/images',
  timeout: 600_000,
  workers: 1,
  outputDir: 'test-results/images',
  reporter: [['list'], ['json', { outputFile: 'test-results/images.json' }]],
  use: {
    browserName: 'chromium',
    launchOptions: {
      args: ['--host-resolver-rules=MAP devfootnote.test 127.0.0.1', '--no-proxy-server'],
    },
  },
});
