import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { validateTokenClaims } from '../services/token.service.js';
import type { Request } from 'express';
import { REFRESH_COOKIE, readCookie } from '../auth.cookies.js';

@Injectable()
export class RefreshTokenStrategy extends PassportStrategy(Strategy, 'refresh-token') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: (req: Request) => readCookie(req, REFRESH_COOKIE) ?? null,
      secretOrKey: config.getOrThrow<string>('auth.refreshSecret'),
      algorithms: ['HS256'],
      issuer: 'devfootnote',
      audience: 'devfootnote-web',
    });
  }

  validate(payload: unknown) {
    try {
      return validateTokenClaims(payload, 'refresh');
    } catch {
      throw new UnauthorizedException();
    }
  }
}
