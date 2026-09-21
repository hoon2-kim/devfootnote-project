import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { AuthError } from '../auth.error.js';
import { AuthService } from '../services/auth.service.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import type { Response } from 'express';
import { BINDING_COOKIE } from '../auth.constants.js';
import { authCookieOptions, readCookie } from '../auth.cookies.js';
import { hasBodyHeaders } from '../auth-request.js';
import type { GoogleAuthenticatedRequest } from '../auth-request.types.js';

@Injectable()
export class GoogleCallbackGuard extends AuthGuard('google') {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<GoogleAuthenticatedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const secureCookies = this.config.getOrThrow<boolean>('auth.secureCookies');

    res.clearCookie(BINDING_COOKIE, authCookieOptions(secureCookies, '/api/v1/auth/google'));

    try {
      const state = req.query.state;
      const code = req.query.code;

      if (
        req.method !== 'GET' ||
        hasBodyHeaders(req) ||
        typeof state !== 'string' ||
        !state ||
        typeof code !== 'string' ||
        !code ||
        req.query.error !== undefined
      ) {
        throw new UnauthorizedException();
      }

      const binding = readCookie(req, BINDING_COOKIE) ?? '';

      req.loginReturnTo = await this.auth.consumeOAuthState(state, binding);
      await super.canActivate(context);

      return true;
    } catch (error) {
      // state 위조 같은 정상 거부는 남기지 않는다 — 장애만 기록해야 로그가 신호로 남는다.
      // provider 오류·code·profile 은 응답에도 로그에도 복사하지 않는다.
      const denied =
        error instanceof UnauthorizedException ||
        (error instanceof AuthError && error.kind === 'denied');

      if (!denied) {
        logger.error('Google 로그인 콜백을 처리하지 못했습니다.');
      }

      res.redirect(302, '/login?error=authentication_failed');

      return false;
    }
  }
}
