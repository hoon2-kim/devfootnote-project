import { randomUUID, createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { AuthError } from '../auth.error.js';
import type { SessionTokens, TokenClaims } from '../auth.types.js';

const tokenClaimsSchema = z.object({
  sub: z.uuid(),
  exp: z.number().int().positive(),
  token_use: z.enum(['access', 'refresh']),
  jti: z.string().min(1),
});

// 서명·issuer·audience·만료는 라이브러리가 본다. token_use 는 키 분리와 별개의 두 번째 방어다
// — 키를 잘못 설정해도 access 를 refresh 로 쓰지 못한다.
export function validateTokenClaims(payload: unknown, use: 'access' | 'refresh'): TokenClaims {
  const result = tokenClaimsSchema.safeParse(payload);

  if (!result.success || result.data.token_use !== use) {
    throw new AuthError('denied');
  }

  return result.data;
}

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    this.accessSecret = config.getOrThrow<string>('auth.accessSecret');
    this.refreshSecret = config.getOrThrow<string>('auth.refreshSecret');
  }

  verifyRefresh(token: string) {
    try {
      const payload: unknown = this.jwt.verify(token, {
        secret: this.refreshSecret,
        algorithms: ['HS256'],
        issuer: 'devfootnote',
        audience: 'devfootnote-web',
      });

      return validateTokenClaims(payload, 'refresh');
    } catch {
      throw new AuthError('denied');
    }
  }

  // 회전해도 refreshExpiresAt 을 그대로 물려받는다 — 안 그러면 계속 갱신돼 7일 만료가 무의미해진다.
  issue(ownerId: string, refreshExpiresAt?: number): SessionTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessExpiresAt = now + ACCESS_TTL_SECONDS;

    refreshExpiresAt ??= now + REFRESH_TTL_SECONDS;
    const sign = (use: 'access' | 'refresh', exp: number) =>
      this.jwt.sign(
        { sub: ownerId, iat: now, exp, jti: randomUUID(), token_use: use },
        {
          secret: use === 'access' ? this.accessSecret : this.refreshSecret,
          algorithm: 'HS256',
          issuer: 'devfootnote',
          audience: 'devfootnote-web',
        },
      );

    return {
      access: sign('access', accessExpiresAt),
      refresh: sign('refresh', refreshExpiresAt),
      accessExpiresAt,
      refreshExpiresAt,
    };
  }
}
