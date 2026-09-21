import { BadRequestException, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from '../services/auth.service.js';
import type { Request, Response } from 'express';
import { BINDING_COOKIE } from '../auth.constants.js';
import { authCookieOptions } from '../auth.cookies.js';
import { hasBodyHeaders } from '../auth-request.js';
import { loginReturnTo } from '../auth-return-to.js';

@Injectable()
export class GoogleLoginGuard extends AuthGuard('google') {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async getAuthenticateOptions(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();

    // Passport는 query뿐 아니라 body의 code도 callback으로 처리하므로 시작 경로에서는 받지 않는다.
    if (req.method !== 'GET' || hasBodyHeaders(req) || req.query.code || req.query.error) {
      throw new BadRequestException();
    }

    const secureCookies = this.config.getOrThrow<boolean>('auth.secureCookies');
    const { state, binding } = await this.auth.beginLogin(loginReturnTo(req.query.returnTo));
    const res = context.switchToHttp().getResponse<Response>();

    res.cookie(BINDING_COOKIE, binding, {
      ...authCookieOptions(secureCookies, '/api/v1/auth/google'),
      maxAge: 300_000,
    });

    return { session: false, state };
  }
}
