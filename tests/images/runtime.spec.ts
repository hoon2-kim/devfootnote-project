import { test, expect } from '@playwright/test';
import { startImageStack } from './stack';
import { signIn } from '../browser/sign-in';

test('app 이미지: HTTPS 로그인·CSRF·재발급·저장·재시작·DB 장애 복구·로그아웃', async ({
  browser,
}) => {
  const stack = await startImageStack();
  // 로컬 자체 서명 인증서의 신뢰만 생략한다. HTTPS와 Secure cookie 동작은 그대로 검증한다.
  const context = await browser.newContext({ baseURL: stack.origin, ignoreHTTPSErrors: true });

  try {
    const page = await context.newPage();

    await signIn(page, stack.origin.replace('devfootnote.test', '127.0.0.1'));
    await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
    const cookies = await context.cookies(`${stack.origin}/api/v1/auth`);

    for (const [name, path] of [
      ['devfootnote_access', '/'],
      ['devfootnote_refresh', '/api/v1/auth'],
    ]) {
      expect(cookies.find((cookie) => cookie.name === name)).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        domain: 'devfootnote.test',
        path,
      });
    }

    expect(cookies.filter((cookie) => cookie.name.startsWith('__Host-'))).toHaveLength(2);
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/devfootnote_(access|refresh)/);
    // 프록시 뒤에서도 CSRF 누락·위조 Origin을 정상 요청으로 취급하면 안 된다.
    expect(
      await page.evaluate(
        async () => (await fetch('/api/v1/auth/logout', { method: 'POST' })).status,
      ),
    ).toBe(403);
    const csrf = await page.evaluate(
      async () => (await (await fetch('/api/v1/auth/csrf')).json()).data.csrfToken,
    );
    const rejected = await context.request.post(
      `${stack.origin.replace('devfootnote.test', '127.0.0.1')}/api/v1/auth/logout`,
      {
        headers: {
          origin: 'https://attacker.test',
          'x-forwarded-host': new URL(stack.origin).host,
          'x-forwarded-proto': 'https',
          'x-csrf-token': csrf,
          cookie: (await context.cookies(`${stack.origin}/api/v1/auth/logout`))
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join('; '),
        },
      },
    );

    expect(rejected.status()).toBe(403);
    await context.clearCookies({ name: 'devfootnote_access' });
    const refresh = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/refresh'),
    );

    await page.reload();
    expect((await refresh).status()).toBe(204);
    await page.getByRole('button', { name: '새 자료', exact: true }).click();
    await page.getByLabel('제목 (선택)').fill('이미지 재시작 이후에도 남는 자료');
    await page.getByLabel('원문', { exact: true }).fill('Redis와 AI 없이 저장하는 PostgreSQL 근거');
    await page.getByRole('button', { name: '자료 저장', exact: true }).click();
    await page.getByRole('link', { name: '이미지 재시작 이후에도 남는 자료' }).click();
    await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText(
      'PostgreSQL 근거',
    );
    const documentUrl = page.url();

    await stack.restart();
    await page.goto(documentUrl);
    await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText(
      'PostgreSQL 근거',
    );
    await page.goto('/search?q=PostgreSQL');
    await expect(
      page.getByRole('link', { name: '이미지 재시작 이후에도 남는 자료' }),
    ).toBeVisible();
    await stack.compose('stop', 'postgres');
    expect(await page.evaluate(async () => (await fetch('/api/v1/health/live')).status)).toBe(200);
    expect(await page.evaluate(async () => (await fetch('/api/v1/health/ready')).status)).toBe(503);
    await stack.compose('up', '-d', '--wait', 'postgres');
    await expect
      .poll(() => page.evaluate(async () => (await fetch('/api/v1/health/ready')).status))
      .toBe(200);
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(
      (await context.cookies(`${stack.origin}/api/v1/auth`)).filter((cookie) =>
        /^(devfootnote_|__Host-devfootnote)/.test(cookie.name),
      ),
    ).toEqual([]);
  } finally {
    await context.close();
    await stack.close();
  }
});
