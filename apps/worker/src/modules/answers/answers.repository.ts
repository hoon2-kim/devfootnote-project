import { Injectable } from '@nestjs/common';
import {
  InjectTransactionHost,
  TransactionHost,
  Transactional,
  Propagation,
} from '@nestjs-cls/transactional';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  answerAttempts,
  answerRequests,
  type StoredAnswerClaim,
} from '@devfootnote/db/schema/answers';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';

@Injectable()
export class AnswersRepository {
  constructor(
    @InjectTransactionHost('worker')
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  async read(ownerId: string, requestId: string) {
    const [row] = await this.transactions.tx
      .select()
      .from(answerRequests)
      .where(and(eq(answerRequests.ownerId, ownerId), eq(answerRequests.requestId, requestId)));

    return row ?? null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async lock(ownerId: string, requestId: string) {
    await this.transactions.tx
      .select({ id: answerRequests.requestId })
      .from(answerRequests)
      .where(and(eq(answerRequests.ownerId, ownerId), eq(answerRequests.requestId, requestId)))
      .for('update');
    const [row] = await this.transactions.tx
      .select({
        request: answerRequests,
        live: sql<boolean>`${answerRequests.expiresAt} > clock_timestamp()`,
        answerLive: sql<boolean>`${answerRequests.answerExpiresAt} > clock_timestamp()`,
        dedupeLive: sql<boolean>`${answerRequests.dedupeExpiresAt} > clock_timestamp()`,
      })
      .from(answerRequests)
      .where(and(eq(answerRequests.ownerId, ownerId), eq(answerRequests.requestId, requestId)));

    return row ?? null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async start(ownerId: string, requestId: string, attemptId: string) {
    const [row] = await this.transactions.tx
      .update(answerRequests)
      .set({ state: 'RUNNING' })
      .where(
        and(
          eq(answerRequests.ownerId, ownerId),
          eq(answerRequests.requestId, requestId),
          eq(answerRequests.state, 'RESERVED'),
          sql`${answerRequests.expiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: answerRequests.requestId });

    if (!row) {
      return false;
    }

    await this.transactions.tx
      .insert(answerAttempts)
      .values({ id: attemptId, ownerId, requestId, state: 'STARTED' });

    return true;
  }

  @Transactional('worker', Propagation.Mandatory)
  async attempt(ownerId: string, requestId: string, id: string) {
    const [row] = await this.transactions.tx
      .select()
      .from(answerAttempts)
      .where(
        and(
          eq(answerAttempts.ownerId, ownerId),
          eq(answerAttempts.requestId, requestId),
          eq(answerAttempts.id, id),
        ),
      );

    return row ?? null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async finish(
    ownerId: string,
    requestId: string,
    state: 'PUBLISHED' | 'NO_ANSWER' | 'FAILED' | 'EXPIRED' | 'INVALIDATED',
    failure: string | null,
    claims: StoredAnswerClaim[] | null,
    attemptOutcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN',
  ) {
    await this.transactions.tx
      .update(answerRequests)
      .set({
        state,
        failure,
        question: null,
        claims,
        answerExpiresAt:
          state === 'PUBLISHED' || state === 'NO_ANSWER'
            ? sql`clock_timestamp() + ${answerRequests.answerRetentionSeconds} * interval '1 second'`
            : null,
      })
      .where(
        and(
          eq(answerRequests.ownerId, ownerId),
          eq(answerRequests.requestId, requestId),
          inArray(answerRequests.state, ['RESERVED', 'RUNNING']),
        ),
      );
    await this.transactions.tx
      .update(answerAttempts)
      .set({ state: attemptOutcome, completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(answerAttempts.ownerId, ownerId),
          eq(answerAttempts.requestId, requestId),
          eq(answerAttempts.state, 'STARTED'),
        ),
      );
  }

  @Transactional('worker', Propagation.Mandatory)
  async clearContent(ownerId: string, requestId: string, failure: string) {
    await this.transactions.tx
      .update(answerRequests)
      .set({ question: null, claims: null, evidence: [], failure })
      .where(and(eq(answerRequests.ownerId, ownerId), eq(answerRequests.requestId, requestId)));
  }

  @Transactional('worker', Propagation.Mandatory)
  async deleteReceipt(ownerId: string, requestId: string) {
    await this.transactions.tx
      .delete(answerRequests)
      .where(
        and(
          eq(answerRequests.ownerId, ownerId),
          eq(answerRequests.requestId, requestId),
          sql`${answerRequests.dedupeExpiresAt} < clock_timestamp()`,
          sql`${answerRequests.state} not in ('RESERVED','RUNNING')`,
        ),
      );
  }

  @Transactional('worker', Propagation.Mandatory)
  async reserveBatch() {
    const rows = await this.transactions.tx
      .select({ ownerId: answerRequests.ownerId, requestId: answerRequests.requestId })
      .from(answerRequests)
      .where(sql`${answerRequests.scanAfter} <= clock_timestamp()`)
      .orderBy(asc(answerRequests.scanAfter), asc(answerRequests.requestId))
      .limit(20)
      .for('update', { skipLocked: true });

    for (const row of rows) {
      await this.transactions.tx
        .update(answerRequests)
        .set({ scanAfter: sql`clock_timestamp() + interval '15 seconds'` })
        .where(
          and(eq(answerRequests.ownerId, row.ownerId), eq(answerRequests.requestId, row.requestId)),
        );
    }

    return rows;
  }
}
