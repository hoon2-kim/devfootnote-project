import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { doubleCsrf } from 'csrf-csrf';
import type { Request, RequestHandler, Response } from 'express';
import { authCookieOptions } from '../auth.cookies.js';
import { hasBodyHeaders } from '../auth-request.js';

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class CsrfService {
  private readonly secureCookies: boolean;
  private readonly origin: string;
  private readonly bindingCookie: string;
  private readonly tokenCookie: string;
  private readonly csrf: ReturnType<typeof doubleCsrf>;

  constructor(config: ConfigService) {
    this.secureCookies = config.getOrThrow<boolean>('auth.secureCookies');
    this.origin = config.getOrThrow<string>('auth.origin');
    const csrfSecret = config.getOrThrow<string>('auth.csrfSecret');
    // __Host- 는 HTTPS 에서만 설정된다 — 로컬 http 에서 붙이면 쿠키가 통째로 무시된다.
    const prefix = this.secureCookies ? '__Host-' : '';

    this.bindingCookie = `${prefix}devfootnote_csrf_binding`;
    this.tokenCookie = `${prefix}devfootnote_csrf`;
    this.csrf = doubleCsrf({
      getSecret: () => csrfSecret,
      getSessionIdentifier: (req) => {
        const binding = this.readBinding(req);

        if (!binding) {
          throw new ForbiddenException();
        }

        return binding;
      },
      cookieName: this.tokenCookie,
      cookieOptions: {
        ...authCookieOptions(this.secureCookies, '/'),
        maxAge: COOKIE_MAX_AGE,
      },
      getCsrfTokenFromRequest: (req) => req.get('x-csrf-token'),
    });
  }

  readonly protection: RequestHandler = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();

      return;
    }

    if (
      req.headers.origin !== this.origin ||
      (hasBodyHeaders(req) && !req.is('application/json'))
    ) {
      next(new ForbiddenException());

      return;
    }

    this.csrf.doubleCsrfProtection(req, res, (error?: unknown) => {
      next(error ? new ForbiddenException() : undefined);
    });
  };

  getToken(req: Request, res: Response): string {
    if (!this.readBinding(req)) {
      return this.rotate(req, res);
    }

    // 같은 로그인에서 토큰을 재사용해 탭마다 다른 토큰으로 덮지 않는다.
    // cookie-parser의 JSON cookie는 라이브러리의 문자열 재사용 경로로 넘기지 않는다.
    return this.csrf.generateCsrfToken(req, res, {
      overwrite: typeof req.cookies[this.tokenCookie] !== 'string',
    });
  }

  rotate(req: Request, res: Response): string {
    const binding = randomUUID();

    req.cookies[this.bindingCookie] = binding;
    res.cookie(this.bindingCookie, binding, {
      ...authCookieOptions(this.secureCookies, '/'),
      maxAge: COOKIE_MAX_AGE,
    });

    return this.csrf.generateCsrfToken(req, res, { overwrite: true });
  }

  clear(res: Response) {
    const options = authCookieOptions(this.secureCookies, '/');

    res.clearCookie(this.bindingCookie, options);
    res.clearCookie(this.tokenCookie, options);
  }

  private readBinding(req: Request): string | undefined {
    const binding: unknown = req.cookies[this.bindingCookie];

    return typeof binding === 'string' && binding ? binding : undefined;
  }
}
