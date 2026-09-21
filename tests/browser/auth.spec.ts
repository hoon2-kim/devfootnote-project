import AxeBuilder from '@axe-core/playwright';
import { JwtService } from '@nestjs/jwt';
import { test, expect } from './fixtures';
import { authEnvironment, GOOGLE_SUBJECT_A, GOOGLE_SUBJECT_B } from '../auth-environment';

import { signIn } from './sign-in';

test.beforeEach(async ({ auth }) => {
  await auth.pool.query(
    'truncate auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents',
  );
  auth.setSubject(GOOGLE_SUBJECT_A);
  auth.setGoogleFailure(undefined);
});

test('비로그인 자료함 진입은 로그인 화면으로 돌아간다', async ({ page }) => {
  await page.goto('/library');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Flibrary$/);
  await expect(page.getByRole('link', { name: '구글 로그인', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toHaveCount(0);
});

test('이미 열린 등록 화면에서 세션이 끝나면 로그인으로 이동하며 저장하지 않는다', async ({
  page,
  context,
  auth,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: '새 자료', exact: true }).click();
  await page.getByLabel('원문', { exact: true }).fill('만료 후 저장하면 안 되는 원문');
  await context.clearCookies({ name: /^devfootnote_(access|refresh)$/ });
  await page.getByRole('button', { name: '자료 저장', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Flibrary$/);
  await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toHaveCount(0);
  expect(
    (await auth.pool.query('select count(*)::int as count from materials')).rows[0].count,
  ).toBe(0);
});

test('검색 경로의 query는 재로그인 뒤 복원한다', async ({ page }) => {
  await page.goto('/search?q=redis&page=2');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  const loginPath = new URL(page.url()).pathname + new URL(page.url()).search;

  await signIn(page, undefined, loginPath);
  await expect(page).toHaveURL(/\/search\?q=redis&page=2$/);
});

for (const width of [320, 768, 1280]) {
  test(`로그인·access 부재 복구·로그아웃 ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
    const cookies = await context.cookies();

    for (const name of ['devfootnote_access', 'devfootnote_refresh']) {
      expect(cookies.find((cookie) => cookie.name === name)).toMatchObject({
        httpOnly: true,
        sameSite: 'Lax',
      });
    }

    expect(await page.evaluate(() => document.cookie)).not.toMatch(/devfootnote_(access|refresh)/);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(
      page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '자료함' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({ path: `test-results/browser/library-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: '본문으로 건너뛰기' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();

    const before = cookies.find((cookie) => cookie.name === 'devfootnote_refresh')?.value;

    await context.clearCookies({ name: 'devfootnote_access' });
    const refreshed = page.waitForResponse(
      (response) => response.url().endsWith('/api/v1/auth/refresh') && response.status() === 204,
    );

    await page.reload();
    await refreshed;
    await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
    expect(
      (await context.cookies()).find((cookie) => cookie.name === 'devfootnote_refresh')?.value,
    ).not.toBe(before);

    const logout = page.getByRole('button', { name: '로그아웃', exact: true });

    await logout.focus();
    await expect(logout).toBeFocused();
    const size = await logout.boundingBox();

    expect(size?.height).toBeGreaterThanOrEqual(44);
    expect(size?.width).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/login$/);
    expect(
      (await context.cookies()).filter((cookie) => cookie.name.startsWith('devfootnote_')),
    ).toEqual([]);
    await page.goto('/library');
    await expect(page).toHaveURL(/\/login\?returnTo=/);
  });
}

test('Google profile 실패는 안전한 안내를 보여 주고 계정을 만들지 않는다', async ({
  page,
  auth,
}) => {
  auth.setGoogleFailure('profile');
  await signIn(page);
  await expect(page).toHaveURL(/\/login\?error=authentication_failed$/);
  await expect(page.getByRole('alert').filter({ hasText: '로그인하지 못했습니다.' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('PRIVATE_GOOGLE_ERROR');
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect((await auth.pool.query('select count(*)::int as count from accounts')).rows[0].count).toBe(
    0,
  );
  await page.screenshot({ path: 'test-results/browser/login-error.png', fullPage: true });
});

test('refresh도 없으면 로그인 복귀 후 이전 자료함은 표시하지 않는다', async ({ page, context }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
  await context.clearCookies({ name: /^devfootnote_(access|refresh)$/ });
  await page.reload();
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toHaveCount(0);
});

for (const failure of ['503', 'network']) {
  test(`refresh ${failure}는 logout 대신 오류와 명시적 복구를 제공한다`, async ({
    page,
    context,
  }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
    await context.clearCookies({ name: 'devfootnote_access' });
    let refreshCount = 0;

    await page.route('**/api/v1/auth/refresh', async (route) => {
      refreshCount++;

      if (failure === 'network') {
        await route.abort();
      } else {
        await route.fulfill({
          status: 503,
          json: { success: false, error: 'SERVICE_UNAVAILABLE' },
        });
      }
    });
    await page.reload();
    await expect(
      page.getByRole('alert').filter({ hasText: '자동으로 로그아웃하지 않았습니다.' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/library$/);
    expect(refreshCount).toBe(1);
    expect((await context.cookies()).some((cookie) => cookie.name === 'devfootnote_refresh')).toBe(
      true,
    );
    await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toHaveCount(0);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({ path: `test-results/browser/refresh-${failure}.png`, fullPage: true });
    await page.unroute('**/api/v1/auth/refresh');
    await page.getByRole('button', { name: '다시 확인' }).click();
    await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
  });
}

test('logout 실패는 완료로 위장하지 않고 재시도할 수 있다', async ({ page, context }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
  await page.route('**/api/v1/auth/logout', (route) =>
    route.fulfill({ status: 503, json: { success: false } }),
  );
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '로그아웃하지 못했습니다.' }),
  ).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === 'devfootnote_refresh')).toBe(
    true,
  );
  await page.unroute('**/api/v1/auth/logout');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('로그인 확인 중 상태를 알리고 동작 줄이기 설정을 지킨다', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route('**/api/v1/auth/me', async (route) => {
    await pending;
    await route.fallback();
  });

  try {
    await page.goto('/library');
    const status = page.getByRole('status').filter({ hasText: '로그인 상태를 확인하고 있습니다.' });

    await expect(status).toBeVisible();
    expect(
      await status.locator('svg').evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none');
    await page.screenshot({ path: 'test-results/browser/auth-loading.png', fullPage: true });
  } finally {
    release();
  }

  await expect(page).toHaveURL(/\/login\?returnTo=/);
});

test('로그아웃 뒤 다른 Google 계정은 새 owner로 확인한다', async ({ page, auth }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
  const first = await (await page.request.get('/api/v1/auth/me')).json();

  await page.getByRole('button', { name: '새 자료', exact: true }).click();
  await page.getByLabel('제목 (선택)').fill('첫 계정의 개인 자료');
  await page.getByLabel('원문', { exact: true }).fill('다른 계정에는 보이지 않는 격리검증 원문');
  await page.getByRole('button', { name: '자료 저장', exact: true }).click();
  await page.getByRole('link', { name: '첫 계정의 개인 자료' }).click();
  await expect(page.getByRole('heading', { name: '첫 계정의 개인 자료' })).toBeVisible();
  const firstDocument = page.url();

  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  auth.setSubject(GOOGLE_SUBJECT_B);
  await signIn(page);
  await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
  const second = await (await page.request.get('/api/v1/auth/me')).json();

  expect(second.data.ownerId).not.toBe(first.data.ownerId);
  await expect(page.getByText('아직 저장한 자료가 없습니다')).toBeVisible();
  await page.goto('/search?q=격리검증');
  await expect(page.getByRole('status')).toContainText('일치하는 자료가 없습니다.');
  await page.goto(firstDocument);
  await expect(page.getByRole('heading', { name: '자료를 찾을 수 없습니다' })).toBeVisible();
});

for (const use of ['access', 'refresh'] as const) {
  test(`만료된 ${use} JWT를 실제 API가 거부한 뒤 올바르게 복구한다`, async ({ page, context }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
    const me = await (await page.request.get('/api/v1/auth/me')).json();
    const cookie = (await context.cookies()).find((cookie) => cookie.name === `devfootnote_${use}`);

    if (!cookie) {
      throw new Error('인증 쿠키가 없습니다.');
    }

    const expired = new JwtService().sign(
      { sub: me.data.ownerId, exp: 1, token_use: use, jti: 'expired-fixture' },
      {
        secret:
          use === 'access' ? authEnvironment.JWT_ACCESS_SECRET : authEnvironment.JWT_REFRESH_SECRET,
        algorithm: 'HS256',
        issuer: 'devfootnote',
        audience: 'devfootnote-web',
      },
    );

    await context.addCookies([{ ...cookie, value: expired }]);

    if (use === 'refresh') {
      await context.clearCookies({ name: 'devfootnote_access' });
    }

    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/auth/refresh'),
    );

    await page.reload();
    expect((await refreshed).status()).toBe(use === 'access' ? 204 : 401);

    if (use === 'access') {
      await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
    } else {
      await expect(page).toHaveURL(/\/login\?returnTo=/);
    }
  });
}
