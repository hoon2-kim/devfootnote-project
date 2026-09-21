import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { TokenClaims } from '../auth.types.js';
import { AuthError } from '../auth.error.js';
import { AuthRepository } from '../repositories/auth.repository.js';
import { TokenService, hashToken } from './token.service.js';

// base64url 로 항상 43자다 — consumeOAuthState 의 길이 검사가 이 값에 맞춰져 있다.
const random = () => randomBytes(32).toString('base64url');
const STATE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly tokens: TokenService,
  ) {}

  async beginLogin(returnTo = '/library') {
    const state = random();
    const binding = random();

    await this.repository.saveOAuthState({
      stateHash: hashToken(state),
      bindingHash: hashToken(binding),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
      returnTo,
    });

    return { state, binding };
  }

  async consumeOAuthState(state: string, binding: string): Promise<string> {
    if (!/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(binding)) {
      throw new AuthError('denied');
    }

    const oauthState = await this.repository.consumeOAuthState(
      hashToken(state),
      hashToken(binding),
    );

    if (!oauthState) {
      throw new AuthError('denied');
    }

    return oauthState.returnTo;
  }

  // 타입은 string 이지만 provider 응답에 따라 비어 올 수 있다 — 빈 subject 로는 여럿이 한 계정을 쓰게 된다.
  async completeLogin(googleProfileId: string) {
    if (typeof googleProfileId !== 'string' || googleProfileId.length === 0) {
      throw new AuthError('denied');
    }

    return this.repository.establishSession(
      'https://accounts.google.com',
      googleProfileId,
      (ownerId) => this.tokens.issue(ownerId),
    );
  }

  // 서명은 Guard 가 봤다. 여기서는 그 사이 바뀔 수 있는 현재 refresh 상태만 확인한다.
  async refresh(token: string, claims: TokenClaims) {
    const tokens = this.tokens.issue(claims.sub, claims.exp);
    const rotated = await this.repository.rotateRefresh(
      claims.sub,
      hashToken(token),
      hashToken(tokens.refresh),
      new Date(claims.exp * 1000),
    );

    if (!rotated) {
      throw new AuthError('denied');
    }

    return tokens;
  }

  // Guard 를 안 거치는 진입점이라 여기서 검증한다 — 통과 못 하면 남의 행을 지우지 않고 끝낸다.
  async logout(token?: string) {
    if (!token) {
      return;
    }

    let ownerId: string;

    try {
      ownerId = this.tokens.verifyRefresh(token).sub;
    } catch (error) {
      if (error instanceof AuthError && error.kind === 'denied') {
        return;
      }

      throw error;
    }

    // 회전 전 유효한 토큰도 현재 행을 철회해야 logout/refresh 경쟁 뒤 0건이다.
    await this.repository.revokeRefresh(ownerId);
  }
}
