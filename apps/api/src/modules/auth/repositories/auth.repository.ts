import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost, Transactional, Propagation } from '@nestjs-cls/transactional';
import { logger } from '../../../infrastructure/logging/logger.js';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { isDatabaseUnavailable } from '../../../infrastructure/database/database-error.js';
import { DATABASE, type Database } from '../../../infrastructure/database/database.provider.js';
import type { PostgresTransactionAdapter } from '../../../infrastructure/database/transactions.module.js';
import { accounts, oauthStates, refreshTokens } from '@devfootnote/db/schema/auth';
import { AuthError } from '../auth.error.js';
import type { OAuthState } from '../auth.types.js';

const cleanupBatchSize = 100;

@Injectable()
export class AuthRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  // 정리는 insert와 같은 transaction에서 최대 100건만 처리한다. 실패 시 성공으로 응답하지 않는다.
  async saveOAuthState(oauthState: OAuthState) {
    return this.persist(() =>
      this.db.transaction(async (tx) => {
        const expired = tx
          .select({ stateHash: oauthStates.stateHash })
          .from(oauthStates)
          .where(lt(oauthStates.expiresAt, sql`now()`))
          .orderBy(oauthStates.expiresAt)
          .limit(cleanupBatchSize)
          .for('update', { skipLocked: true });

        await tx.delete(oauthStates).where(inArray(oauthStates.stateHash, expired));
        await tx.insert(oauthStates).values(oauthState);
      }),
    );
  }

  async consumeOAuthState(stateHash: string, bindingHash: string) {
    const [oauthState] = await this.persist(() =>
      this.db
        .delete(oauthStates)
        .where(
          and(
            eq(oauthStates.stateHash, stateHash),
            eq(oauthStates.bindingHash, bindingHash),
            gt(oauthStates.expiresAt, sql`now()`),
          ),
        )
        .returning({ returnTo: oauthStates.returnTo }),
    );

    return oauthState;
  }

  @Transactional(Propagation.Mandatory)
  async findOrCreateAccount(issuer: string, subject: string) {
    const tx = this.transactions.tx;

    // 같은 계정의 첫 로그인이 동시에 와도 하나만 남는다 — 충돌은 무시하고 아래 select 로 승자를 읽는다.
    await tx.insert(accounts).values({ issuer, subject }).onConflictDoNothing();
    const [owner] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.issuer, issuer), eq(accounts.subject, subject)));

    if (!owner) {
      throw new AuthError('denied');
    }

    return owner;
  }

  @Transactional(Propagation.Mandatory)
  async replaceRefresh(values: {
    ownerId: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
  }) {
    const tx = this.transactions.tx;
    const expired = tx
      .select({ ownerId: refreshTokens.ownerId })
      .from(refreshTokens)
      .where(lt(refreshTokens.expiresAt, sql`now()`))
      .orderBy(refreshTokens.expiresAt)
      .limit(cleanupBatchSize)
      .for('update', { skipLocked: true });

    await tx.delete(refreshTokens).where(inArray(refreshTokens.ownerId, expired));
    await tx
      .insert(refreshTokens)
      .values(values)
      .onConflictDoUpdate({ target: refreshTokens.ownerId, set: values });
  }

  // 조회 없이 조건부 update 한 번으로 교체한다 — 같은 refresh 로 동시에 들어와도 한 쪽만 1건을 받는다.
  async rotateRefresh(ownerId: string, currentHash: string, nextHash: string, expiresAt: Date) {
    const changed = await this.persist(() =>
      this.db
        .update(refreshTokens)
        .set({ tokenHash: nextHash })
        .where(
          and(
            eq(refreshTokens.ownerId, ownerId),
            eq(refreshTokens.tokenHash, currentHash),
            eq(refreshTokens.expiresAt, expiresAt),
            gt(refreshTokens.expiresAt, sql`now()`),
          ),
        )
        .returning({ ownerId: refreshTokens.ownerId }),
    );

    return changed.length === 1;
  }

  async revokeRefresh(ownerId: string) {
    await this.persist(() =>
      this.db.delete(refreshTokens).where(eq(refreshTokens.ownerId, ownerId)),
    );
  }

  // 분류에는 Drizzle의 직접 cause만 확인하고 SQL·parameter·원본 cause는 밖으로 내보내지 않는다.
  private async persist<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }

      if (isDatabaseUnavailable(error)) {
        logger.error('인증 저장소에 일시적으로 접근할 수 없습니다.');

        throw new AuthError('unavailable');
      }

      logger.error('인증 저장소 작업에 실패했습니다.');

      throw new Error('인증 저장소 내부 오류');
    }
  }
}
