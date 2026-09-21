import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { GOOGLE_SUBJECT_A } from '../auth-environment';
import { signIn as googleSignIn } from './sign-in';

async function signIn(page: Page) {
  await googleSignIn(page);
  await expect(page.getByRole('heading', { name: '내 자료함', exact: true })).toBeVisible();
}

test.beforeEach(async ({ auth }) => {
  await auth.pool.query(
    'truncate auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents',
  );
  auth.setSubject(GOOGLE_SUBJECT_A);
  auth.setGoogleFailure(undefined);
});

for (const width of [320, 768, 1280]) {
  test(`등록·목록·안전한 원문 읽기 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await expect(page.getByText('아직 저장한 자료가 없습니다')).toBeVisible();
    await expect(page.getByRole('region', { name: '새 자료 남기기' })).not.toBeVisible();
    await page.getByRole('button', { name: '새 자료', exact: true }).click();
    await expect(page.getByLabel('제목 (선택)')).toBeFocused();
    await page.getByRole('button', { name: '자료 저장', exact: true }).click();
    await expect(page.getByLabel('원문', { exact: true })).toBeFocused();
    await expect(page.getByText('원문을 입력해 주세요.')).toBeVisible();
    await page.getByLabel('제목 (선택)').fill('트랜잭션의 근거');
    await page
      .getByLabel('원문', { exact: true })
      .fill(
        '# PostgreSQL 원문\n\n**원자적 저장**과 rollback\n\n<script>window.alert("bad")</script>\n\n[unsafe](javascript:alert%281%29)\n\n![추적 이미지](https://example.com/track.png)\n\n[문서](https://example.com/reference)',
      );
    await page.getByLabel('나의 메모 (선택)').fill('중복 처리에 사용한 내 판단');
    await page.getByLabel('사용 맥락 (선택)').fill('결제 API 구현');
    await page.getByLabel('출처 URL (선택)').fill('https://example.com/source');
    await page.getByRole('button', { name: '자료 저장', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('저장했습니다.');
    await expect(page.getByRole('link', { name: '트랜잭션의 근거', exact: true })).toBeVisible();
    await expect(page.getByLabel('원문', { exact: true })).toHaveValue('');
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `test-results/browser/material-create-${width}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: '작성 패널 닫기' }).click();
    await expect(page.getByRole('button', { name: '새 자료', exact: true })).toBeFocused();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/browser/material-library-${width}.png`,
      fullPage: true,
    });
    await page.getByRole('link', { name: '트랜잭션의 근거', exact: true }).click();
    await expect(page.getByRole('heading', { name: '트랜잭션의 근거', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '나의 메모' })).toContainText(
      '중복 처리에 사용한 내 판단',
    );
    const source = page.getByRole('region', { name: '저장한 원문' });

    await expect(source).toContainText('원자적 저장');
    await expect(source.locator('script, iframe, img, a[href^="javascript:"]')).toHaveCount(0);
    await expect(source.getByRole('link', { name: /문서/ })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/browser/material-reader-${width}.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(source).toContainText('원자적 저장');
  });
}

test('저장 응답 유실 뒤 입력과 요청 ID를 유지해 중복 없이 재시도한다', async ({ page, auth }) => {
  await signIn(page);
  await page.getByRole('button', { name: '새 자료', exact: true }).click();
  let failed = false;
  const keys: string[] = [];

  await page.route('**/api/v1/materials', async (route) => {
    if (route.request().method() !== 'POST') {
      return route.continue();
    }

    keys.push(route.request().postDataJSON().idempotencyKey);
    const response = await route.fetch();

    if (!failed) {
      failed = true;
      await route.abort('failed');
    } else {
      await route.fulfill({ response });
    }
  });
  await page.getByLabel('원문', { exact: true }).fill('응답이 없어도 남아야 하는 원문');
  await page.getByRole('button', { name: '자료 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '새 자료 남기기' }).getByRole('alert'),
  ).toContainText('입력은 유지됩니다.');
  await expect(page.getByLabel('원문', { exact: true })).toHaveValue(
    '응답이 없어도 남아야 하는 원문',
  );
  await page.getByLabel('원문', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '새 자료', exact: true })).toBeFocused();
  await expect(page.getByRole('region', { name: '새 자료 남기기' })).not.toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('제목 (선택)')).toBeFocused();
  await expect(page.getByLabel('원문', { exact: true })).toHaveValue(
    '응답이 없어도 남아야 하는 원문',
  );
  await page.getByRole('button', { name: '자료 저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('저장했습니다.');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect((await auth.pool.query('select count(*)::int as count from materials')).rows).toEqual([
    { count: 1 },
  ]);
});

test('목록 오류를 빈 자료함과 구분하고 새 자료 진입과 재시도를 유지한다', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.route('**/api/v1/materials?*', (route) =>
    route.fulfill({ status: 503, json: { success: false, error: 'SERVICE_UNAVAILABLE' } }),
  );
  await signIn(page);
  await expect(
    page.getByRole('region', { name: '저장한 자료', exact: true }).getByRole('alert'),
  ).toContainText('자료 목록을 불러오지 못했습니다.');
  await expect(page.getByText('아직 저장한 자료가 없습니다')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '새 자료', exact: true })).toBeEnabled();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: 'test-results/browser/library-error-320.png', fullPage: true });
  await page.unroute('**/api/v1/materials?*');
  await page.getByRole('button', { name: '목록 다시 불러오기' }).click();
  await expect(page.getByText('아직 저장한 자료가 없습니다')).toBeVisible();
});

test('만료 access의 등록 재전송과 읽기 오류 복구', async ({ page, context }) => {
  await signIn(page);
  await page.getByRole('button', { name: '새 자료', exact: true }).click();
  await context.clearCookies({ name: 'devfootnote_access' });
  await page.getByLabel('원문', { exact: true }).fill('재발급 후 저장');
  await page.getByRole('button', { name: '자료 저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('저장했습니다.');
  await page.route('**/api/v1/materials/*', (route) =>
    route.fulfill({
      status: 503,
      json: { success: false, error: 'SERVICE_UNAVAILABLE', message: '실패' },
    }),
  );
  await page.getByRole('link', { name: '저장한 자료 읽기' }).click();
  await expect(page.getByRole('heading', { name: '자료를 불러오지 못했습니다' })).toBeVisible();
  await page.unroute('**/api/v1/materials/*');
  await page.getByRole('button', { name: '원문 다시 불러오기' }).click();
  await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText('재발급 후 저장');
  await page.goto('/documents/00000000-0000-4000-8000-000000000000');
  await expect(page.getByRole('heading', { name: '자료를 찾을 수 없습니다' })).toBeVisible();
});
