import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { validateTokenClaims } from '../services/token.service.js';
import type { Request } from 'express';
import { readCookie } from '../auth.cookies.js';
import { ACCESS_COOKIE } from '../auth.constants.js';

@Injectable()
export class AccessTokenStrategy extends PassportStrategy(Strategy, 'access-token') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: (req: Request) => readCookie(req, ACCESS_COOKIE) ?? null,
      secretOrKey: config.getOrThrow<string>('auth.accessSecret'),
      algorithms: ['HS256'],
      issuer: 'devfootnote',
      audience: 'devfootnote-web',
    });
  }

  validate(payload: unknown) {
    try {
      return { ownerId: validateTokenClaims(payload, 'access').sub };
    } catch {
      throw new UnauthorizedException();
    }
  }
}
