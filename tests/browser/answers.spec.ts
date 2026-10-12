import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { signIn } from './sign-in';

const materialId = '00000000-0000-4000-8000-000000000301';
const revisionId = '00000000-0000-4000-8000-000000000302';
const evidenceId = '00000000-0000-4000-8000-000000000303';
const href = `/documents/${materialId}?revision=${revisionId}#source-title`;
const policy = {
  fingerprint: 'fixture-public-answer-v1',
  provider: 'fixture-no-network',
  model: 'fixture',
  retentionNotice:
    '무료 등급의 질문과 본문은 제품 개선과 사람의 검토에 사용될 수 있습니다. 민감한 정보는 보내지 마세요.',
  answerRetentionSeconds: 7 * 86400,
  receiptRetentionDays: 90,
  budgetLimit: '450000000',
  currency: 'USD',
  unitScale: 1_000_000_000,
};

async function setupAnswerScreen(page: Page, alreadyConsented = false) {
  let consented = alreadyConsented;
  let epoch = alreadyConsented ? 1 : 0;

  // 외부 AI 없이 화면 상태·동의·응답 유실만 검사한다. 게시와 비용 정합성은 실제 DB 통합 검사가 맡는다.
  await page.route(`**/api/v1/materials/${materialId}`, (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: materialId,
          revisionId,
          revision: 1,
          title: '트랜잭션 학습 자료',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          body: '트랜잭션은 작업을 모두 반영하거나 취소합니다.',
          note: null,
          context: null,
          sourceUrl: null,
        },
      },
    }),
  );
  await page.route('**/api/v1/answers/configuration', (route) =>
    route.fulfill({
      json: { success: true, data: { configured: true, consented, consentEpoch: epoch, policy } },
    }),
  );
  await page.route('**/api/v1/answers/consent', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      expectedConsentEpoch: epoch,
      policyFingerprint: policy.fingerprint,
      accepted: true,
    });
    epoch += 1;
    consented = true;
    await route.fulfill({ json: { success: true, data: { consentEpoch: epoch } } });
  });
  await page.route('**/api/v1/answers/consent/revoke', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ expectedConsentEpoch: epoch });
    epoch += 1;
    consented = false;
    await route.fulfill({ json: { success: true, data: { consentEpoch: epoch } } });
  });
}

function answerResult(requestId: string, state: string) {
  return {
    requestId,
    state,
    failure: null,
    claims:
      state === 'PUBLISHED'
        ? [{ text: '트랜잭션은 작업을 모두 반영하거나 취소합니다.', evidenceIds: [evidenceId] }]
        : [],
    citations:
      state === 'PUBLISHED'
        ? [
            {
              evidenceId,
              materialId,
              revisionId,
              chunkId: evidenceId,
              startOffset: 0,
              endOffset: 20,
              href,
            },
          ]
        : [],
    answerExpiresAt: state === 'PUBLISHED' ? '2100-01-01T00:00:00.000Z' : null,
  };
}

async function askQuestion(page: Page) {
  const panel = page.getByRole('region', { name: '자료에 질문하기' });

  if (!(await panel.isVisible())) {
    await page.getByRole('button', { name: '자료에 질문하기', exact: true }).click();
  }

  await panel.getByLabel('자료에 관해 궁금한 점').fill('트랜잭션은 어떤 동작인가요?');
  await panel.getByRole('button', { name: /^(질문 보내기|Google에 보내 질문하기)$/ }).click();
}

test.beforeEach(async ({ auth }) => {
  await auth.pool.query('truncate accounts cascade');
});

for (const width of [320, 1280]) {
  test(`별도 답변 동의·명시적 질문·출처·철회와 접근성 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await setupAnswerScreen(page);
    const requests: { requestId: string; question: string; evidence: unknown[] }[] = [];
    let requestId = '';
    let releaseEvents: (() => void) | undefined;
    const eventsReady = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });

    await page.route('**/api/v1/answers', async (route) => {
      const body = route.request().postDataJSON();

      requests.push(body);
      requestId = body.requestId;
      await route.fulfill({
        status: 202,
        json: { success: true, data: answerResult(body.requestId, 'RESERVED') },
      });
    });
    await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}$/, async (route) => {
      await route.fulfill({
        json: {
          success: true,
          data: answerResult(requestId, 'RUNNING'),
        },
      });
    });
    await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}\/events$/, async (route) => {
      await eventsReady;
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `event: answer\ndata: ${JSON.stringify(answerResult(requestId, 'PUBLISHED'))}\n\n`,
      });
    });
    await page.goto(`/documents/${materialId}`);
    const panel = page.getByRole('region', { name: '자료에 질문하기' });

    await expect(panel.getByLabel('자료에 관해 궁금한 점')).not.toBeVisible();
    await page.getByRole('button', { name: '자료에 질문하기', exact: true }).click();
    await expect(
      panel.getByText('본문과 질문을 Google에 전송합니다.', { exact: false }),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: '답변 생성에 동의', exact: true })).toHaveCount(
      0,
    );
    await expect(panel.getByRole('checkbox')).toHaveCount(0);
    await expect(panel.getByLabel('자료에 관해 궁금한 점')).toBeEnabled();
    expect(requests).toHaveLength(0);
    await askQuestion(page);
    await expect(panel.getByText('자료를 읽고 답변을 작성하고 있습니다.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '자료에 질문하기', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '자료에 질문하기', exact: true }).click();
    releaseEvents?.();
    await expect(panel.getByText('트랜잭션은 작업을 모두 반영하거나 취소합니다.')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.evidence).toEqual([{ materialId, revisionId }]);
    await expect(panel.getByRole('link', { name: '출처 1 원문 보기' })).toHaveAttribute(
      'href',
      href,
    );
    await page.screenshot({
      path: `test-results/browser/phase3-answer-${width}.png`,
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
    const revoke = panel.getByRole('button', { name: 'AI 답변 끄기', exact: true });

    await revoke.click();
    await expect(page.getByRole('button', { name: '취소', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(revoke).toBeFocused();
    await revoke.click();
    await page.getByRole('button', { name: 'AI 답변 끄기 확인', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'AI 답변을 끌까요?' })).not.toBeVisible();
    await expect(
      panel.getByText('트랜잭션은 작업을 모두 반영하거나 취소합니다.'),
    ).not.toBeVisible();
    await panel.getByRole('button', { name: '질문 접기', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '트랜잭션 학습 자료', exact: true }),
    ).toBeVisible();
    expect(requests).toHaveLength(1);
  });
}

test('자료 질문을 접었다 펼쳐도 초안을 유지하고 AI를 호출하지 않는다', async ({ page }) => {
  await signIn(page);
  await setupAnswerScreen(page, true);
  let requests = 0;

  await page.route('**/api/v1/answers', async (route) => {
    requests += 1;
    await route.abort();
  });
  await page.goto(`/documents/${materialId}`);
  const panel = page.getByRole('region', { name: '자료에 질문하기' });
  const toggle = page.getByRole('button', { name: '자료에 질문하기', exact: true });

  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({ path: 'test-results/browser/document-chat-closed.png', fullPage: true });
  await toggle.focus();
  await page.keyboard.press('Enter');
  const question = panel.getByLabel('자료에 관해 궁금한 점');

  await question.fill('작성 중인 질문');
  await panel.getByRole('button', { name: '질문 접기', exact: true }).click();
  await expect(question).not.toBeVisible();
  await toggle.click();
  await expect(question).toHaveValue('작성 중인 질문');
  expect(requests).toBe(0);
});

test('첫 답변의 전송 승인 실패는 생성을 막고 명시적 재시도만 허용한다', async ({ page }) => {
  await signIn(page);
  await setupAnswerScreen(page);
  const approvals: unknown[] = [];
  let generates = 0;
  let requestId = '';

  await page.route('**/api/v1/answers/consent', async (route) => {
    approvals.push(route.request().postDataJSON());

    if (approvals.length === 1) {
      await route.abort('failed');

      return;
    }

    await route.fallback();
  });
  await page.route('**/api/v1/answers', async (route) => {
    generates += 1;
    requestId = route.request().postDataJSON().requestId;
    await route.fulfill({
      status: 202,
      json: { success: true, data: answerResult(requestId, 'PUBLISHED') },
    });
  });
  await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}$/, (route) =>
    route.fulfill({ json: { success: true, data: answerResult(requestId, 'PUBLISHED') } }),
  );
  await page.goto(`/documents/${materialId}`);
  const panel = page.getByRole('region', { name: '자료에 질문하기' });

  await page.getByRole('button', { name: '자료에 질문하기', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Google에 보내 질문하기' })).toBeEnabled();
  expect(approvals).toHaveLength(0);
  expect(generates).toBe(0);
  await askQuestion(page);
  await expect(panel.getByRole('button', { name: '같은 요청 다시 확인' })).toBeVisible();
  expect(generates).toBe(0);
  await expect(panel.getByLabel('자료에 관해 궁금한 점')).toHaveValue(
    '트랜잭션은 어떤 동작인가요?',
  );
  await panel.getByRole('button', { name: '같은 요청 다시 확인' }).click();
  await expect(panel.getByText('트랜잭션은 작업을 모두 반영하거나 취소합니다.')).toBeVisible();
  expect(approvals).toHaveLength(2);
  expect(approvals[1]).toEqual(approvals[0]);
  expect(generates).toBe(1);
});

test('답변 응답 유실은 같은 요청을 재전송하고 새 질문만 새 요청 ID를 만든다', async ({ page }) => {
  await signIn(page);
  await setupAnswerScreen(page, true);
  const requests: { requestId: string; question: string; evidence: unknown[] }[] = [];
  let requestId = '';

  await page.route('**/api/v1/answers', async (route) => {
    const body = route.request().postDataJSON();

    requests.push(body);
    requestId = body.requestId;

    if (requests.length === 1) {
      await route.abort('failed');

      return;
    }

    await route.fulfill({
      status: 202,
      json: { success: true, data: answerResult(body.requestId, 'NO_ANSWER') },
    });
  });
  await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}$/, async (route) => {
    await route.fulfill({
      json: { success: true, data: answerResult(requestId, 'NO_ANSWER') },
    });
  });
  await page.goto(`/documents/${materialId}`);
  await askQuestion(page);
  const panel = page.getByRole('region', { name: '자료에 질문하기' });

  await expect(panel.getByRole('button', { name: '같은 요청 다시 확인' })).toBeVisible();
  await panel.getByRole('button', { name: '같은 요청 다시 확인' }).click();
  await expect(
    panel.getByText('이 자료에서는 답을 찾을 수 없어요.', { exact: false }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await panel.getByRole('button', { name: '새 대화' }).click();
  await panel.getByLabel('자료에 관해 궁금한 점').fill('다시 설명해 주세요.');
  await panel.getByRole('button', { name: '질문 보내기' }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]?.requestId).not.toBe(requests[0]?.requestId);
});

for (const { state, message } of [
  { state: 'FAILED', message: '답변을 만들지 못했습니다.' },
  { state: 'EXPIRED', message: '답변의 보관 또는 처리 기한이 끝났습니다.' },
  { state: 'INVALIDATED', message: '자료나 동의 상태가 바뀌어' },
]) {
  test(`답변 ${state} 상태는 본문을 표시하거나 자동으로 다시 생성하지 않는다`, async ({ page }) => {
    await signIn(page);
    await setupAnswerScreen(page, true);
    let calls = 0;
    let requestId = '';

    await page.route('**/api/v1/answers', async (route) => {
      calls += 1;
      requestId = route.request().postDataJSON().requestId;
      await route.fulfill({
        status: 202,
        json: { success: true, data: answerResult(requestId, state) },
      });
    });
    await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}$/, (route) =>
      route.fulfill({ json: { success: true, data: answerResult(requestId, state) } }),
    );
    await page.goto(`/documents/${materialId}`);
    await askQuestion(page);
    const panel = page.getByRole('region', { name: '자료에 질문하기' });

    await expect(panel.getByText(message, { exact: false })).toBeVisible();
    await expect(panel.getByRole('link', { name: '출처 1 원문 보기' })).not.toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      window.dispatchEvent(new Event('visibilitychange'));
      Reflect.deleteProperty(document, 'visibilityState');
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(panel.getByRole('button', { name: '새 대화' })).toBeVisible();
    expect(calls).toBe(1);
  });
}

test('답변 조회 실패는 이전 본문을 숨기고 읽기 재시도로만 복구한다', async ({ page }) => {
  await signIn(page);
  await setupAnswerScreen(page, true);
  let requestId = '';
  let creates = 0;
  let unavailable = false;

  await page.route('**/api/v1/answers', async (route) => {
    creates += 1;
    requestId = route.request().postDataJSON().requestId;
    await route.fulfill({
      status: 202,
      json: { success: true, data: answerResult(requestId, 'PUBLISHED') },
    });
  });
  await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}$/, async (route) => {
    if (unavailable) {
      await route.fulfill({
        status: 503,
        json: { success: false, error: 'SERVICE_UNAVAILABLE', message: '다시 확인해 주세요.' },
      });

      return;
    }

    await route.fulfill({ json: { success: true, data: answerResult(requestId, 'PUBLISHED') } });
  });
  await page.goto(`/documents/${materialId}`);
  await askQuestion(page);
  const panel = page.getByRole('region', { name: '자료에 질문하기' });
  const claim = panel.getByText('트랜잭션은 작업을 모두 반영하거나 취소합니다.');

  await expect(claim).toBeVisible();
  unavailable = true;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'visibilityState');
    window.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    panel.getByText('답변의 최신 상태를 확인하지 못해 내용을 숨겼습니다.', { exact: false }),
  ).toBeVisible();
  await expect(claim).not.toBeVisible();
  unavailable = false;
  await panel.getByRole('button', { name: '답변 상태 다시 확인' }).click();
  await expect(claim).toBeVisible();
  expect(creates).toBe(1);
});

test('자료별 후속 질문은 최근 세 번의 게시된 요청만 전달하고 새 대화는 이력을 비운다', async ({
  page,
}) => {
  await signIn(page);
  await setupAnswerScreen(page, true);
  const requests: {
    requestId: string;
    question: string;
    evidence: unknown[];
    history: { requestId: string; question: string }[];
  }[] = [];

  await page.route('**/api/v1/answers', async (route) => {
    const body = route.request().postDataJSON();

    requests.push(body);
    await route.fulfill({
      status: 202,
      json: { success: true, data: answerResult(body.requestId, 'PUBLISHED') },
    });
  });
  await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}$/, (route) => {
    const id = route.request().url().split('/').at(-1) ?? '';

    return route.fulfill({ json: { success: true, data: answerResult(id, 'PUBLISHED') } });
  });
  await page.goto(`/documents/${materialId}`);
  await page.getByRole('button', { name: '자료에 질문하기', exact: true }).click();
  const panel = page.getByRole('region', { name: '자료에 질문하기' });

  for (let index = 0; index < 5; index += 1) {
    await expect(panel.getByRole('button', { name: '질문 보내기', exact: true })).toBeEnabled();
    await panel.getByLabel('자료에 관해 궁금한 점').fill(`트랜잭션 후속 질문 ${index + 1}`);
    await panel.getByRole('button', { name: '질문 보내기', exact: true }).click();
    await expect(panel.getByText('자료를 근거로 작성한 답변입니다.', { exact: true })).toHaveCount(
      index + 1,
    );
    expect(requests[index]?.evidence).toEqual([{ materialId, revisionId }]);
    expect(requests[index]?.history).toEqual(
      requests
        .slice(Math.max(0, index - 3), index)
        .map(({ requestId, question }) => ({ requestId, question })),
    );
  }

  await panel.getByRole('button', { name: '새 대화', exact: true }).click();
  await expect(panel.getByText('자료를 근거로 작성한 답변입니다.', { exact: true })).toHaveCount(0);
  await panel.getByLabel('자료에 관해 궁금한 점').fill('다시 처음부터 설명해 주세요.');
  await panel.getByRole('button', { name: '질문 보내기', exact: true }).click();
  await expect.poll(() => requests.length).toBe(6);
  expect(requests[5]?.history).toEqual([]);
});

for (const failure of ['network', 'event']) {
  test(`실시간 ${failure} 실패는 생성을 재요청하지 않고 명시적 조회로만 복구한다`, async ({
    page,
  }) => {
    await signIn(page);
    await setupAnswerScreen(page, true);
    let creates = 0;
    let streams = 0;
    let reads = 0;
    let requestId = '';

    await page.route('**/api/v1/answers', async (route) => {
      creates += 1;
      requestId = route.request().postDataJSON().requestId;
      await route.fulfill({
        status: 202,
        json: { success: true, data: answerResult(requestId, 'RUNNING') },
      });
    });
    await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}$/, (route) => {
      reads += 1;

      return route.fulfill({
        json: {
          success: true,
          data: answerResult(requestId, reads === 1 ? 'RUNNING' : 'PUBLISHED'),
        },
      });
    });
    await page.route(/\/api\/v1\/answers\/[0-9a-f-]{36}\/events$/, async (route) => {
      streams += 1;

      if (failure === 'event') {
        await route.fulfill({
          contentType: 'text/event-stream',
          body: 'event: error\ndata: "SERVICE_UNAVAILABLE"\n\n',
        });

        return;
      }

      await route.abort('failed');
    });
    await page.goto(`/documents/${materialId}`);
    await askQuestion(page);
    const panel = page.getByRole('region', { name: '자료에 질문하기' });

    await expect(panel.getByRole('button', { name: '답변 연결 다시 확인' })).toBeVisible();
    expect(creates).toBe(1);
    expect(streams).toBe(1);
    await panel.getByRole('button', { name: '답변 연결 다시 확인' }).click();
    await expect(panel.getByText('트랜잭션은 작업을 모두 반영하거나 취소합니다.')).toBeVisible();
    expect(creates).toBe(1);
    expect(streams).toBe(1);
  });
}

test('자료 revision이 바뀌면 이전 대화와 초안을 비우고 새 자료에서 시작한다', async ({ page }) => {
  await signIn(page);
  await setupAnswerScreen(page, true);
  let creates = 0;

  await page.route('**/api/v1/answers', async (route) => {
    creates += 1;
    await route.abort();
  });
  await page.goto(`/documents/${materialId}`);
  await page.getByRole('button', { name: '자료에 질문하기', exact: true }).click();
  await page.getByLabel('자료에 관해 궁금한 점').fill('이전 버전의 질문');
  await page.route(`**/api/v1/materials/${materialId}`, (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          id: materialId,
          revisionId: '00000000-0000-4000-8000-000000000304',
          revision: 2,
          title: '수정한 트랜잭션 자료',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-02T00:00:00.000Z',
          body: '자료가 수정되었습니다.',
          note: null,
          context: null,
          sourceUrl: null,
        },
      },
    }),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'visibilityState');
    window.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    page.getByRole('heading', { name: '수정한 트랜잭션 자료', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: '자료에 질문하기', exact: true }),
  ).not.toBeVisible();
  await page.getByRole('button', { name: '자료에 질문하기', exact: true }).click();
  await expect(page.getByLabel('자료에 관해 궁금한 점')).toHaveValue('');
  await expect(page.getByText('수정한 트랜잭션 자료 · 버전 2', { exact: true })).toBeVisible();
  expect(creates).toBe(0);
});
