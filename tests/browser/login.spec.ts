import { expect, test } from '@playwright/test';

for (const width of [320, 1280]) {
  test(`로그인 진입 scaffold ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'devfootnote' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Google로 로그인' })).toBeDisabled();
    await expect(page.getByText('로그인 기능을 준비하고 있습니다.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/browser/login-${width}.png`, fullPage: true });
  });
}
