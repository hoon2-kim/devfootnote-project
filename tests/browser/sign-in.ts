import { expect, type Page } from '@playwright/test';

export async function signIn(page: Page, transportOrigin?: string, loginPath = '/login') {
  // Google 동의 화면만 대체한다. 앱의 cookie·state·Passport·DB는 실제 경로다.
  await page.route(/\/api\/v1\/auth\/google(?:\?.*)?$/, async (route) => {
    // APIRequestContext는 Chromium의 테스트용 DNS mapping을 사용하지 않는다.
    const response = await route.fetch({
      maxRedirects: 0,
      ...(transportOrigin
        ? {
            url: new URL(
              new URL(route.request().url()).pathname + new URL(route.request().url()).search,
              transportOrigin,
            ).href,
          }
        : {}),
    });

    expect(response.status()).toBe(302);
    const google = new URL(response.headers().location ?? '');

    expect(google.origin).toBe('https://accounts.google.com');
    const callback = new URL(google.searchParams.get('redirect_uri') ?? '');

    callback.searchParams.set('state', google.searchParams.get('state') ?? '');
    callback.searchParams.set('code', 'fixture-google-code');
    await route.fulfill({ response, headers: { ...response.headers(), location: callback.href } });
  });
  await page.goto(loginPath);
  await page.getByRole('link', { name: '구글 로그인', exact: true }).click();
}
