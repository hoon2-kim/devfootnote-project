import type { SessionTokens } from './auth.types.js';
import { parseCookie } from 'cookie';
import type { CookieOptions, Request, Response } from 'express';

export const ACCESS_COOKIE = 'devfootnote_access';
export const REFRESH_COOKIE = 'devfootnote_refresh';
export const BINDING_COOKIE = 'devfootnote_login';

// cookie-parser의 JSON 쿠키 변환을 거치지 않고 인증 값을 문자열로 읽는다.
export function readCookie(req: Pick<Request, 'headers'>, name: string): string | undefined {
  return parseCookie(req.headers.cookie ?? '')[name];
}

// Lax 여야 Google callback 의 top-level 이동에 쿠키가 실린다. Strict 면 콜백에서 세션이 끊긴다.
export function authCookieOptions(secureCookies: boolean, path: string): CookieOptions {
  return { httpOnly: true, secure: secureCookies, sameSite: 'lax', path };
}

export function setTokenCookies(res: Response, tokens: SessionTokens, secureCookies: boolean) {
  res.cookie(ACCESS_COOKIE, tokens.access, {
    ...authCookieOptions(secureCookies, '/'),
    maxAge: Math.max(0, tokens.accessExpiresAt * 1000 - Date.now()),
  });
  res.cookie(REFRESH_COOKIE, tokens.refresh, {
    ...authCookieOptions(secureCookies, '/api/v1/auth'),
    maxAge: Math.max(0, tokens.refreshExpiresAt * 1000 - Date.now()),
  });
}
