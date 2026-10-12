import { ConfigService } from '@nestjs/config';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { signIn } from './sign-in';

const policy = {
  provider: 'fixture-no-network',
  model: 'fixture',
  modelVersion: '1',
  dimensions: 1536,
  inputVersion: 'fixture-body-v1',
  policyVersion: 'fixture-consent-v1',
  retentionNotice:
    '무료 등급 입력은 제품 개선에 사용되고 사람이 검토할 수 있습니다. 개인정보와 기밀은 보내지 마세요.',
  pricingVersion: 'fixture-price-v1',
  currency: 'USD',
  unitScale: 1_000_000_000,
  maximumPerChunk: '8192000',
  pricePerToken: '200',
  budgetId: '00000000-0000-4000-8000-000000000100',
  budgetLimit: '900000000',
  periodStart: '2020-01-01T00:00:00.000Z',
  periodEnd: '2100-01-01T00:00:00.000Z',
  reservationSeconds: 600,
};

async function createNote(page: Page) {
  await page.getByRole('button', { name: '새 자료', exact: true }).click();
  await page.getByLabel('제목 (선택)').fill('공개 학습 메모');
  await page
    .getByLabel('원문', { exact: true })
    .fill('PostgreSQL 트랜잭션은 작업을 원자적으로 처리합니다.');
  await page.getByRole('button', { name: '자료 저장', exact: true }).click();
  await expect(page.getByRole('link', { name: '공개 학습 메모', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '작성 패널 닫기' }).click();
}

test.beforeEach(async ({ auth }) => {
  await auth.pool.query(
    'truncate answer_call_attempts, answer_requests, usage_answer_consents, indexing_embedding_vectors, usage_embedding_call_receipts, auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_attempts, indexing_embedding_works, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations cascade',
  );
  auth.app.get(ConfigService).set('embeddingPolicy', policy);
});

test.afterEach(async ({ auth }) => {
  auth.app.get(ConfigService).set('embeddingPolicy', undefined);
});

for (const width of [320, 1280]) {
  test(`전송 동의·실제 활성화·철회와 키보드 접근성 ${width}px`, async ({ page, auth }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await createNote(page);
    await page.getByRole('button', { name: 'AI 검색 설정' }).click();
    const panel = page.getByRole('region', { name: '의미 검색 준비' });

    await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await panel.getByRole('button', { name: 'AI 검색 안내' }).click();
    await expect(page.getByRole('tooltip')).toContainText('기존 자료와 이후');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).not.toBeVisible();
    await expect(
      panel.getByText('현재 이 서비스는 Gemini API 무료 등급을 사용합니다.', { exact: false }),
    ).toBeVisible();
    await expect(
      panel.getByText('한 번 켜면 기존 자료와 새로 저장·수정한 본문을 자동으로 준비합니다.'),
    ).toBeVisible();
    await expect(panel.getByText(policy.retentionNotice)).not.toBeVisible();
    await panel.getByText('AI 사용 안내', { exact: true }).click();
    await expect(panel.getByText(policy.retentionNotice)).toBeVisible();
    await panel.getByText('AI 사용 안내', { exact: true }).click();
    await expect(panel.getByText(/USD|참고 예산/)).toHaveCount(0);
    expect((await auth.pool.query('select * from indexing_embedding_works')).rowCount).toBe(0);
    await panel.getByRole('button', { name: 'AI 검색 사용하기' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      panel.getByText('사용 중 · 기존 자료와 새로 저장·수정한 본문을 자동으로 준비합니다.'),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: 'AI 검색 사용하기', exact: true })).toHaveCount(
      0,
    );
    expect(
      (await auth.pool.query('select include_existing from indexing_embedding_activations')).rows,
    ).toEqual([{ include_existing: true }]);
    expect((await auth.pool.query('select * from indexing_embedding_works')).rowCount).toBe(0);
    await page.screenshot({
      path: `test-results/browser/phase2-consent-${width}.png`,
      fullPage: true,
    });
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
    const revoke = panel.getByRole('button', { name: 'AI 검색 끄기', exact: true });

    await revoke.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: '취소', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(revoke).toBeFocused();
    await revoke.click();
    await page.getByRole('button', { name: 'AI 검색 끄기 확인' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(revoke).not.toBeVisible();
    expect(
      (
        await auth.pool.query(
          'select revoked_at is not null as revoked from usage_embedding_consents',
        )
      ).rows,
    ).toEqual([{ revoked: true }]);
    await page.goto('/search?q=PostgreSQL');
    await expect(page.getByRole('link', { name: '공개 학습 메모', exact: true })).toBeVisible();
  });
}

test('의미 검색은 명시 제출만 전송하고 한도 오류에는 키워드 저하를 표시한다', async ({ page }) => {
  await signIn(page);
  await createNote(page);
  await page.getByRole('button', { name: 'AI 검색 설정' }).click();
  await page.getByRole('button', { name: 'AI 검색 사용하기' }).click();
  await expect(
    page.getByText('사용 중 · 기존 자료와 새로 저장·수정한 본문을 자동으로 준비합니다.'),
  ).toBeVisible();
  const requests: { q: string; mode: string; requestId: string }[] = [];

  await page.route('**/api/v1/search/semantic', async (route) => {
    requests.push(route.request().postDataJSON());
    // UI 저하 표현만 고정한다. 실제 provider·게시 정합성은 별도 worker 통합 검사가 맡는다.
    await route.fulfill({
      json: {
        success: true,
        data: {
          requestedMode: 'hybrid',
          effectiveMode: 'keyword',
          degradedReason: 'provider_unavailable',
          page: 1,
          hasNext: false,
          resultLimit: 50,
          truncated: false,
          items: [],
        },
      },
    });
  });
  await page.goto('/search?q=PostgreSQL&mode=hybrid');
  await expect(
    page.getByText('검색 버튼을 누르면 뜻도 함께 비교합니다.', { exact: false }),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await page.getByRole('button', { name: '검색 방법 안내' }).hover();
  await expect(page.getByRole('tooltip')).toContainText('입력 중에는 전송하지 않습니다.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  await page.getByRole('button', { name: '검색 방법 안내' }).focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(
    page.getByText('Gemini에 연결하지 못했거나 무료 한도에 도달했습니다.', { exact: false }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.mode).toBe('hybrid');
  // disabled 해제 중 회색→파랑 중간색으로 대비가 낮아졌던 회귀를 시간 대기 없이 막는다.
  expect(
    await page
      .getByRole('button', { name: '검색', exact: true })
      .evaluate((button) => getComputedStyle(button).transitionProperty),
  ).toBe('none');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByLabel('검색어').focus();
  await page.screenshot({
    path: 'test-results/browser/phase2-search-degraded.png',
    fullPage: true,
  });
  expect(requests).toHaveLength(1);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.reload();
  await expect(
    page.getByText('검색 버튼을 누르면 뜻도 함께 비교합니다.', { exact: false }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.requestId).not.toBe(requests[0]?.requestId);
});

test('의미 검색 응답 유실 재시도는 같은 요청 ID를 보존한다', async ({ page }) => {
  await signIn(page);
  await createNote(page);
  await page.getByRole('button', { name: 'AI 검색 설정' }).click();
  await page.getByRole('button', { name: 'AI 검색 사용하기' }).click();
  await expect(
    page.getByText('사용 중 · 기존 자료와 새로 저장·수정한 본문을 자동으로 준비합니다.'),
  ).toBeVisible();
  const requests: { q: string; mode: string; requestId: string }[] = [];

  await page.route('**/api/v1/search/semantic', async (route) => {
    requests.push(route.request().postDataJSON());

    if (requests.length === 1) {
      await route.abort('failed');

      return;
    }

    await route.fulfill({
      json: {
        success: true,
        data: {
          requestedMode: 'hybrid',
          effectiveMode: 'keyword',
          degradedReason: 'request_used',
          page: 1,
          hasNext: false,
          resultLimit: 50,
          truncated: false,
          items: [],
        },
      },
    });
  });
  await page.goto('/search?q=PostgreSQL&mode=vector');
  await expect(
    page.getByText('검색 버튼을 누르면 뜻도 함께 비교합니다.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByRole('button', { name: 'AI 검색 다시 확인' })).toBeVisible();
  await expect(page.getByRole('link', { name: '공개 학습 메모', exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: 'AI 검색 다시 확인' }).click();
  await expect(page.getByText('이미 처리한 요청입니다.', { exact: false })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('준비 상태 재조회 실패는 이전 동의로 검색하지 않고 키워드 복귀와 재확인을 제공한다', async ({
  page,
}) => {
  await signIn(page);
  let previewUnavailable = false;
  let semanticCalls = 0;

  // UI의 동의 재확인 실패만 제어한다. 실제 동의·owner fence는 API 통합 검사가 맡는다.
  await page.route('**/api/v1/indexing/embedding/preview*', async (route) => {
    if (previewUnavailable) {
      await route.fulfill({
        status: 503,
        json: {
          success: false,
          error: 'SERVICE_UNAVAILABLE',
          message: '잠시 후 다시 시도해 주세요.',
        },
      });

      return;
    }

    await route.fulfill({
      json: {
        success: true,
        data: {
          configured: true,
          consented: true,
          consentEpoch: 1,
          states: [],
          items: [],
          policy: null,
          nextCursor: null,
          reservedMaximum: '0',
        },
      },
    });
  });
  await page.route('**/api/v1/search/semantic', async (route) => {
    semanticCalls += 1;
    await route.fulfill({
      json: {
        success: true,
        data: {
          requestedMode: 'hybrid',
          effectiveMode: 'hybrid',
          degradedReason: null,
          page: 1,
          hasNext: false,
          resultLimit: 50,
          truncated: false,
          items: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              revisionId: '00000000-0000-4000-8000-000000000002',
              revision: 1,
              title: '준비된 자료',
              snippet: '이전 의미 검색 결과',
              matchedField: 'body',
            },
          ],
        },
      },
    });
  });
  await page.goto('/search?q=트랜잭션&mode=vector');
  await expect(
    page.getByText('검색 버튼을 누르면 뜻도 함께 비교합니다.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect(page.getByRole('link', { name: '준비된 자료', exact: true })).toBeVisible();

  previewUnavailable = true;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'visibilityState');
    window.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    page.getByText('의미 검색 준비 상태를 확인하지 못했습니다.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '준비된 자료', exact: true })).not.toBeVisible();
  await expect(
    page.getByText('지금은 단어가 일치하는 자료만 찾았어요.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '검색', exact: true }).click();
  expect(semanticCalls).toBe(1);

  previewUnavailable = false;
  await page.getByRole('button', { name: '준비 상태 다시 확인', exact: true }).click();
  await expect(
    page.getByText('의미 검색 준비 상태를 확인하지 못했습니다.', { exact: false }),
  ).not.toBeVisible();
  expect(semanticCalls).toBe(1);
  await expect(page.getByRole('link', { name: '준비된 자료', exact: true })).not.toBeVisible();
  await page.screenshot({
    path: 'test-results/browser/phase4-search-readiness-recovered.png',
    fullPage: true,
  });
});
