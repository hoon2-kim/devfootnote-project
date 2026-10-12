import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';
import { signIn } from './sign-in';
import { GOOGLE_SUBJECT_A } from '../auth-environment';

test.beforeEach(async ({ auth, page }) => {
  await auth.pool.query(
    'truncate answer_call_attempts, answer_requests, usage_answer_consents, indexing_embedding_vectors, usage_embedding_call_receipts, auth_refresh_tokens, accounts, auth_oauth_states, materials, material_revisions, material_chunks, material_keywords, material_request_receipts, embedding_intents, indexing_embedding_attempts, indexing_embedding_works, indexing_embedding_activations, indexing_activation_receipts, usage_embedding_consents, usage_embedding_budgets, usage_embedding_reservations',
  );
  auth.setSubject(GOOGLE_SUBJECT_A);
  auth.setGoogleFailure(undefined);
  await signIn(page);
  await page.getByRole('button', { name: '새 자료', exact: true }).click();
  await page.getByLabel('제목 (선택)').fill('저장부터 재검색까지');
  await page.getByLabel('원문', { exact: true }).fill('PostgreSQL 트랜잭션의 이전원문');
  await page.getByRole('button', { name: '자료 저장', exact: true }).click();
  await page.getByRole('link', { name: '저장부터 재검색까지', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '저장부터 재검색까지', exact: true }),
  ).toBeVisible();
});

test('변경 없이 수정 저장하면 버전·수정 시각을 유지하고 실제 수정만 새 버전이 된다', async ({
  page,
}) => {
  const apiPath = new URL(page.url()).pathname.replace('/documents/', '/api/v1/materials/');
  const before = (await (await page.request.get(apiPath)).json()).data;

  await page.getByRole('button', { name: '자료 수정', exact: true }).click();
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
  const unchanged = (await (await page.request.get(apiPath)).json()).data;

  expect(unchanged).toEqual(before);
  await page.getByRole('button', { name: '자료 수정', exact: true }).click();
  await page.getByLabel('원문', { exact: true }).fill(`${before.body}!`);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
  const changed = (await (await page.request.get(apiPath)).json()).data;

  expect(changed.revision).toBe(before.revision + 1);
  expect(changed.revisionId).not.toBe(before.revisionId);
  await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText(`${before.body}!`);
});

for (const mode of ['503', 'network', '403'] as const) {
  test(`인증 background 재조회 ${mode}는 일시 장애에서 초안과 재시도 요청을 보존한다`, async ({
    page,
  }) => {
    const keys: string[] = [];

    await page.route('**/api/v1/materials/*', async (route) => {
      if (route.request().method() !== 'PUT') {
        return route.continue();
      }

      keys.push(route.request().postDataJSON().idempotencyKey);
      const response = await route.fetch();

      if (keys.length === 1) {
        await route.abort('failed');
      } else {
        await route.fulfill({ response });
      }
    });
    await page.getByRole('button', { name: '자료 수정', exact: true }).click();
    await page.getByLabel('원문', { exact: true }).fill('인증 재조회에도 보존할 초안');
    await page.getByRole('button', { name: '수정 저장', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '자료 수정', exact: true }).getByRole('alert'),
    ).toContainText('입력은 보존했습니다.');
    await page.route('**/api/v1/auth/me', (route) =>
      mode === 'network'
        ? route.abort('failed')
        : route.fulfill({
            status: Number(mode),
            json: {
              success: false,
              error: mode === '503' ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN',
            },
          }),
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      window.dispatchEvent(new Event('visibilitychange'));
      Reflect.deleteProperty(document, 'visibilityState');
      window.dispatchEvent(new Event('visibilitychange'));
    });

    if (mode === '403') {
      await expect(
        page.getByRole('heading', { name: '로그인 상태를 확인하지 못했습니다' }),
      ).toBeVisible();
      await expect(page.getByLabel('원문', { exact: true })).not.toBeVisible();
      await expect(page.getByRole('region', { name: '저장한 원문' })).not.toBeVisible();

      return;
    }

    await expect(
      page.getByText('로그인 상태를 다시 확인하지 못했습니다. 작성 중인 내용은 유지됩니다.'),
    ).toBeVisible();
    await expect(page.getByLabel('원문', { exact: true })).toHaveValue(
      '인증 재조회에도 보존할 초안',
    );

    if (mode === '503') {
      await page.setViewportSize({ width: 320, height: 900 });
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({ path: 'test-results/browser/auth-stale-320.png', fullPage: true });
    }

    await page.unroute('**/api/v1/auth/me');
    await page.getByRole('button', { name: '로그인 상태 다시 확인' }).click();
    await expect(
      page.getByText('로그인 상태를 다시 확인하지 못했습니다. 작성 중인 내용은 유지됩니다.'),
    ).not.toBeVisible();
    await expect(page.getByLabel('원문', { exact: true })).toHaveValue(
      '인증 재조회에도 보존할 초안',
    );
    await page.getByRole('button', { name: '수정 저장', exact: true }).click();
    await expect(page.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
}

for (const status of [503, 403, 404]) {
  test(`문서 background refetch ${status}는 일시 장애와 접근 불가를 구분한다`, async ({ page }) => {
    await page.getByRole('button', { name: '자료 수정', exact: true }).click();
    await page.getByLabel('원문', { exact: true }).fill('새로고침 실패에도 보존할 초안');
    await page.route('**/api/v1/materials/*', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status,
            json: {
              success: false,
              error:
                status === 503
                  ? 'SERVICE_UNAVAILABLE'
                  : status === 403
                    ? 'FORBIDDEN'
                    : 'MATERIAL_NOT_FOUND',
            },
          })
        : route.continue(),
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      window.dispatchEvent(new Event('visibilitychange'));
      Reflect.deleteProperty(document, 'visibilityState');
      window.dispatchEvent(new Event('visibilitychange'));
    });

    if (status === 503) {
      await expect(
        page.getByText('최신 상태를 확인하지 못했습니다. 이전에 불러온 내용입니다.'),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText('이전원문');
      await expect(page.getByLabel('원문', { exact: true })).toHaveValue(
        '새로고침 실패에도 보존할 초안',
      );
      await page.setViewportSize({ width: 320, height: 900 });
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await page.screenshot({
        path: 'test-results/browser/document-stale-320.png',
        fullPage: true,
      });
      await page.unroute('**/api/v1/materials/*');
      await page.getByRole('button', { name: '최신 상태 다시 확인' }).click();
      await expect(
        page.getByText('최신 상태를 확인하지 못했습니다. 이전에 불러온 내용입니다.'),
      ).not.toBeVisible();
      await expect(page.getByLabel('원문', { exact: true })).toHaveValue(
        '새로고침 실패에도 보존할 초안',
      );
    } else {
      await expect(page.getByRole('heading', { name: '자료를 찾을 수 없습니다' })).toBeVisible();
      await expect(page.getByRole('region', { name: '저장한 원문' })).not.toBeVisible();
      await expect(page.getByLabel('원문', { exact: true })).not.toBeVisible();
    }
  });
}

for (const mode of ['create', 'update'] as const) {
  test(`자료 ${mode}의 서버 필드 오류는 입력을 보존하고 수정 후 재시도할 수 있다`, async ({
    page,
  }) => {
    if (mode === 'create') {
      await page.goto('/library');
      await page.getByRole('button', { name: '새 자료', exact: true }).click();
    } else {
      await page.getByRole('button', { name: '자료 수정', exact: true }).click();
    }

    await page.getByLabel('원문', { exact: true }).fill('입력을 보존할 원문');
    let rejected = false;

    await page.route('**/api/v1/materials**', async (route) => {
      if (!rejected && route.request().method() === (mode === 'create' ? 'POST' : 'PUT')) {
        rejected = true;
        await route.fulfill({
          status: 400,
          json: {
            success: false,
            error: 'VALIDATION_ERROR',
            message: '요청을 확인해 주세요.',
            errors: [
              { field: 'body', code: 'fixture', message: '원문을 다시 확인해 주세요.' },
              { field: 'title', code: 'fixture', message: '제목을 다시 확인해 주세요.' },
            ],
          },
        });
      } else {
        await route.continue();
      }
    });

    const submit = page.getByRole('button', {
      name: mode === 'create' ? '자료 저장' : '수정 저장',
      exact: true,
    });

    await submit.click();
    await expect(page.getByText('원문을 다시 확인해 주세요.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('원문', { exact: true })).toHaveValue('입력을 보존할 원문');
    await expect(page.getByLabel('제목 (선택)')).toBeFocused();
    await page.getByLabel('제목 (선택)').fill('수정한 제목');
    await page.getByLabel('원문', { exact: true }).fill('수정하고 재시도한 원문');
    await submit.click();

    if (mode === 'create') {
      await expect(page.getByRole('status')).toContainText('저장했습니다.');
    } else {
      await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText(
        '수정하고 재시도한 원문',
      );
    }
  });
}

for (const width of [320, 1280]) {
  test(`수정·재검색·삭제와 키보드 취소 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const documentUrl = page.url();

    await page.getByRole('button', { name: '자료 수정', exact: true }).click();
    await page.getByLabel('원문', { exact: true }).fill('PostgreSQL 트랜잭션의 최신원문');
    await page.getByLabel('나의 메모 (선택)').fill('실패하면 전체 rollback');
    await page.getByRole('button', { name: '수정 저장', exact: true }).click();
    await expect(page.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText('최신원문');
    await page.goto('/search?q=이전원문');
    await expect(page.getByRole('region', { name: '검색 결과' }).getByRole('status')).toContainText(
      '일치하는 자료가 없습니다.',
    );
    await page.getByLabel('검색어', { exact: true }).fill('rollback');
    await page.getByRole('button', { name: '검색', exact: true }).click();
    await expect(page.getByRole('link', { name: '저장부터 재검색까지' })).toBeVisible();
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
    await page.screenshot({ path: `test-results/browser/search-${width}.png`, fullPage: true });
    await page.getByRole('link', { name: '저장부터 재검색까지' }).click();
    await expect(page).toHaveURL(/#note-title$/);
    await expect(page.getByRole('region', { name: '나의 메모' })).toContainText('전체 rollback');
    await page.getByRole('button', { name: '자료 삭제', exact: true }).click();
    const dialog = page.getByRole('dialog');

    await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `test-results/browser/delete-confirm-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '자료 삭제', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: '삭제 확인' }).click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByText('아직 저장한 자료가 없습니다')).toBeVisible();
    await page.goto('/search?q=rollback');
    await expect(page.getByRole('region', { name: '검색 결과' }).getByRole('status')).toContainText(
      '일치하는 자료가 없습니다.',
    );
    await page.goto(documentUrl);
    await expect(page.getByRole('heading', { name: '자료를 찾을 수 없습니다' })).toBeVisible();
  });
}

for (const mode of ['refresh401', 'replay401', 'refresh503', 'network'] as const) {
  test(`열린 문서의 인증 복구 ${mode}는 최종 인증 실패와 연결 오류를 구분한다`, async ({
    page,
    context,
  }) => {
    const original = new URL(page.url());

    original.searchParams.set('revision', '12345678-1234-4234-8234-123456789abc');
    original.hash = '#source-title';
    await page.goto(original.href);
    await expect(
      page.getByRole('heading', { name: '저장부터 재검색까지', exact: true }),
    ).toBeVisible();
    await context.clearCookies({ name: 'devfootnote_access' });

    if (mode === 'refresh401') {
      await context.clearCookies({ name: 'devfootnote_refresh' });
    } else if (mode === 'replay401') {
      await page.route('**/api/v1/materials/*', async (route) => {
        if (route.request().method() === 'PUT') {
          await route.fulfill({
            status: 401,
            json: { success: false, error: 'AUTHENTICATION_REQUIRED' },
          });
        } else {
          await route.continue();
        }
      });
    } else {
      await page.route('**/api/v1/auth/refresh', async (route) => {
        if (mode === 'network') {
          await route.abort();
        } else {
          await route.fulfill({
            status: 503,
            json: { success: false, error: 'SERVICE_UNAVAILABLE' },
          });
        }
      });
    }

    await page.getByRole('button', { name: '자료 수정', exact: true }).click();
    await page.getByLabel('원문', { exact: true }).fill('보존할 초안');
    await page.getByRole('button', { name: '수정 저장', exact: true }).click();

    if (mode === 'refresh401' || mode === 'replay401') {
      await expect(page).toHaveURL(/\/login\?returnTo=/);
      expect(new URL(page.url()).searchParams.get('returnTo')).toBe(
        original.pathname + original.search + original.hash,
      );
      await expect(page.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
      const loginPath = new URL(page.url()).pathname + new URL(page.url()).search;

      await signIn(page, undefined, loginPath);
      await expect(page).toHaveURL(original.href);
      await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText('이전원문');
    } else {
      await expect(
        page.getByRole('region', { name: '자료 수정', exact: true }).getByRole('alert'),
      ).toContainText('입력은 보존했습니다.');
      await expect(page).toHaveURL(original.href);
      await expect(page.getByLabel('원문', { exact: true })).toHaveValue('보존할 초안');
      await page.unroute('**/api/v1/auth/refresh');
      await page.getByRole('button', { name: '수정 저장', exact: true }).click();
      await expect(page.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
      await expect(page.getByRole('region', { name: '저장한 원문' })).toContainText('보존할 초안');
    }
  });
}

test('두 탭의 수정·삭제 충돌은 덮어쓰지 않고 최신 내용을 명시적으로 불러온다', async ({
  page,
  context,
}) => {
  const other = await context.newPage();

  await other.goto(page.url());
  await page.getByRole('button', { name: '자료 수정', exact: true }).click();
  await page.getByLabel('원문', { exact: true }).fill('보존해야 하는 초안');
  await other.getByRole('button', { name: '자료 수정', exact: true }).click();
  await other.getByLabel('원문', { exact: true }).fill('다른 탭에서 먼저 저장');
  await other.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(other.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '자료 수정', exact: true }).getByRole('alert'),
  ).toContainText('입력은 보존했습니다.');
  await expect(page.getByLabel('원문', { exact: true })).toHaveValue('보존해야 하는 초안');
  await page.route('**/api/v1/materials/*', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 503, json: { success: false, error: 'SERVICE_UNAVAILABLE' } })
      : route.continue(),
  );
  await page.getByRole('button', { name: '입력을 버리고 최신 내용 불러오기' }).click();
  await expect(
    page.getByText('최신 내용을 불러오지 못했습니다. 입력은 그대로 유지됩니다.'),
  ).toBeVisible();
  await expect(page.getByLabel('원문', { exact: true })).toHaveValue('보존해야 하는 초안');
  await page.unroute('**/api/v1/materials/*');
  let release!: () => void;
  let observe!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    observe = resolve;
  });

  await page.route('**/api/v1/materials/*', async (route) => {
    if (route.request().method() === 'GET') {
      observe();
      await pending;
    }

    await route.continue();
  });

  try {
    await page.getByRole('button', { name: '입력을 버리고 최신 내용 불러오기' }).click();
    await started;
    await expect(page.getByLabel('원문', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '최신 내용 불러오는 중…' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '수정 저장', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '편집 취소', exact: true })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('최신 내용을 불러오고 있습니다.');
    await page.screenshot({
      path: 'test-results/browser/document-reload-pending.png',
      fullPage: true,
    });
  } finally {
    release();
  }

  await expect(page.getByLabel('원문', { exact: true })).toHaveValue('다른 탭에서 먼저 저장');
  await expect(page.getByLabel('원문', { exact: true })).toBeEnabled();
  await page.unroute('**/api/v1/materials/*');
  await page.getByLabel('원문', { exact: true }).fill('충돌 복구 후 저장');
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
  await other.getByRole('button', { name: '자료 삭제', exact: true }).click();
  await other.getByRole('button', { name: '삭제 확인' }).click();
  await expect(other.getByRole('dialog').getByRole('alert')).toContainText(
    '자료가 변경되어 삭제하지 않았습니다.',
  );
  await other.route('**/api/v1/materials/*', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 503, json: { success: false, error: 'SERVICE_UNAVAILABLE' } })
      : route.continue(),
  );
  await other.getByRole('button', { name: '취소하고 최신 내용 확인' }).click();
  await expect(other.getByRole('dialog')).toBeVisible();
  await expect(
    other.getByRole('dialog').getByText('최신 내용을 불러오지 못했습니다. 다시 시도해 주세요.'),
  ).toBeVisible();
  await other.unroute('**/api/v1/materials/*');
  await other.getByRole('button', { name: '취소하고 최신 내용 확인' }).click();
  await expect(other.getByRole('dialog')).not.toBeVisible();
  await expect(other.getByRole('region', { name: '저장한 원문' })).toContainText(
    '충돌 복구 후 저장',
  );
  await other.close();
});

test('삭제 충돌 복구 중 404는 이전 본문과 삭제 대화상자를 숨긴다', async ({ page }) => {
  await page.route('**/api/v1/materials/*', (route) =>
    route.fulfill({
      status: route.request().method() === 'DELETE' ? 409 : 404,
      json: {
        success: false,
        error:
          route.request().method() === 'DELETE'
            ? 'MATERIAL_REVISION_CONFLICT'
            : 'MATERIAL_NOT_FOUND',
      },
    }),
  );
  await page.getByRole('button', { name: '자료 삭제', exact: true }).click();
  await page.getByRole('button', { name: '삭제 확인' }).click();
  await page.getByRole('button', { name: '취소하고 최신 내용 확인' }).click();
  await expect(page.getByRole('heading', { name: '자료를 찾을 수 없습니다' })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('region', { name: '저장한 원문' })).not.toBeVisible();
});

test('수정·삭제의 응답 유실 재시도는 같은 요청 ID로 한 번만 반영한다', async ({ page, auth }) => {
  const keys: Record<string, string[]> = { PUT: [], DELETE: [] };

  await page.route('**/api/v1/materials/*', async (route) => {
    const method = route.request().method();

    if (!keys[method]) {
      return route.continue();
    }

    keys[method].push(route.request().postDataJSON().idempotencyKey);
    const response = await route.fetch();

    if (keys[method].length === 1) {
      await route.abort('failed');
    } else {
      await route.fulfill({ response });
    }
  });
  await page.getByRole('button', { name: '자료 수정', exact: true }).click();
  await page.getByLabel('원문', { exact: true }).fill('중복되지 않는 새 버전');
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '자료 수정', exact: true }).getByRole('alert'),
  ).toContainText('입력은 보존했습니다.');
  await page.getByRole('button', { name: '수정 저장', exact: true }).click();
  await expect(page.getByRole('region', { name: '자료 수정', exact: true })).toHaveCount(0);
  expect(
    (await auth.pool.query('select count(*)::int as count from material_revisions')).rows,
  ).toEqual([{ count: 2 }]);
  await page.getByRole('button', { name: '자료 삭제', exact: true }).click();
  await page.getByRole('button', { name: '삭제 확인' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    '삭제를 확인하지 못했습니다.',
  );
  await page.getByRole('button', { name: '삭제 확인' }).click();
  await expect(page).toHaveURL(/\/library$/);

  for (const requests of Object.values(keys)) {
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
  }
});

test('검색 오류는 빈 결과와 구분하고 재시도로 복구한다', async ({ page }) => {
  await page.route('**/api/v1/search?*', (route) =>
    route.fulfill({ status: 503, json: { success: false, error: 'SERVICE_UNAVAILABLE' } }),
  );
  await page.goto('/search?q=트랜잭션');
  await expect(page.getByRole('region', { name: '검색 결과' }).getByRole('alert')).toContainText(
    '검색하지 못했습니다.',
  );
  await expect(page.getByText('일치하는 자료가 없습니다.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '검색어' })).toHaveAccessibleDescription(
    '단어가 같거나 뜻이 비슷한 자료를 찾습니다.',
  );
  await page.unroute('**/api/v1/search?*');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route('**/api/v1/search?*', async (route) => {
    await pending;
    await route.continue();
  });

  try {
    await page.getByRole('button', { name: '검색 다시 시도' }).click();
    await expect(page.getByRole('region', { name: '검색 결과' }).getByRole('status')).toHaveText(
      '검색 중…',
    );
    // data 없는 실패의 재시도는 Query가 pending으로 돌아가므로 오류 버튼 대신 진행 안내가 나온다.
    await expect(page.getByRole('button', { name: '검색 다시 시도' })).not.toBeVisible();
  } finally {
    release();
  }

  await expect(page.getByRole('link', { name: '저장부터 재검색까지' })).toBeVisible();
});

test('목록·검색의 다음 페이지와 이전 페이지는 URL과 실제 결과를 함께 바꾼다', async ({ page }) => {
  const csrf = await (await page.request.get('/api/v1/auth/csrf')).json();

  for (let index = 1; index <= 41; index++) {
    const response = await page.request.post('/api/v1/materials', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': csrf.data.csrfToken },
      data: {
        title: `페이지 자료 ${index}`,
        body: '페이지검증 원문',
        idempotencyKey: crypto.randomUUID(),
      },
    });

    expect(response.status()).toBe(201);
  }

  await page.goto('/library');
  const library = page.getByRole('region', { name: '저장한 자료', exact: true });

  await expect(library.getByRole('listitem')).toHaveCount(20);
  const navigation = page.getByRole('navigation', { name: '자료 목록 페이지' });

  await expect(navigation.getByRole('link', { name: '1페이지', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(navigation.getByRole('button', { name: '이전 페이지' })).toBeDisabled();
  await expect(navigation.getByRole('link', { name: '3페이지', exact: true })).toBeVisible();
  await navigation.getByRole('link', { name: '2페이지', exact: true }).click();
  await expect(page).toHaveURL(/\/library\?page=2$/);
  await expect(library.getByRole('listitem')).toHaveCount(20);
  await expect(navigation.getByRole('link', { name: '2페이지', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await navigation.getByRole('link', { name: '3페이지', exact: true }).click();
  await expect(page).toHaveURL(/\/library\?page=3$/);
  await expect(library.getByRole('listitem')).toHaveCount(2);
  await expect(navigation.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
  await page.getByRole('link', { name: '이전 페이지' }).click();
  await expect(library.getByRole('listitem')).toHaveCount(20);
  await page.goto('/search?q=페이지검증');
  const search = page.getByRole('region', { name: '검색 결과' });

  await expect(search.getByRole('listitem')).toHaveCount(20);
  await page.getByRole('link', { name: '다음 페이지' }).click();
  await expect(page).toHaveURL(/page=2$/);
  await expect(page.getByLabel('검색어', { exact: true })).toHaveValue('페이지검증');
  await expect(search.getByRole('listitem')).toHaveCount(20);
  await page.getByRole('link', { name: '다음 페이지' }).click();
  await expect(search.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('link', { name: '이전 페이지' }).click();
  await expect(search.getByRole('listitem')).toHaveCount(20);
});
