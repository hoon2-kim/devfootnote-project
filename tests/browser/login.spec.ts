import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

for (const width of [320, 768, 1280]) {
  test(`로그인 진입 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: '나의 기록에, 나의 각주를' })).toBeVisible();
    const login = page.getByRole('link', { name: '구글 로그인', exact: true });

    await expect(login.locator('img')).toBeVisible();
    await expect
      .poll(() =>
        login
          .locator('img')
          .evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth > 0),
      )
      .toBe(true);
    await expect(login).toHaveAttribute('href', '/api/v1/auth/google');
    await page.keyboard.press('Tab');
    await expect(login).toBeFocused();
    const size = await login.boundingBox();

    expect(size?.height).toBeGreaterThanOrEqual(44);
    expect(await login.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      'none',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await login.evaluate((element) => element.blur());
    await page.screenshot({ path: `test-results/browser/login-${width}.png`, fullPage: true });
  });
}

test('좁은 화면에서도 인증 오류와 재시도 경로를 유지한다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const returnTo = '/search?q=postgres&page=2';

  await page.goto(`/login?${new URLSearchParams({ error: 'google_failed', returnTo })}`);
  await expect(page.getByRole('alert')).toContainText('로그인하지 못했습니다.');
  const login = page.getByRole('link', { name: '구글 로그인', exact: true });

  await expect(login).toHaveAttribute(
    'href',
    `/api/v1/auth/google?${new URLSearchParams({ returnTo })}`,
  );
  await page.keyboard.press('Tab');
  await expect(login).toBeFocused();
  await expect(login).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: 'test-results/browser/login-error-320.png', fullPage: true });
});
