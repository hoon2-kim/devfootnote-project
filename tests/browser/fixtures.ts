import { test as base, expect } from '@playwright/test';
import { startAuthHarness } from '../auth-harness.js';

export const test = base.extend<
  Record<never, never>,
  { auth: Awaited<ReturnType<typeof startAuthHarness>> }
>({
  auth: [
    async ({}, use) => {
      const auth = await startAuthHarness('http://127.0.0.1:33000', 33001);

      try {
        await use(auth);
      } finally {
        await auth.close();
      }
    },
    { scope: 'worker', auto: true },
  ],
});

export { expect };
