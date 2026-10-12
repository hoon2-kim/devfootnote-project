import { Injectable } from '@nestjs/common';
import { TransactionHost, Transactional, Propagation } from '@nestjs-cls/transactional';
import { and, eq, sql } from 'drizzle-orm';
import { answerRequests, type AnswerEvidenceSnapshot } from '@devfootnote/db/schema/answers';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import type { AnswerPolicy } from '@devfootnote/ai';

@Injectable()
export class AnswersRepository {
  constructor(private readonly transactions: TransactionHost<PostgresTransactionAdapter>) {}

  async read(ownerId: string, requestId: string) {
    const [row] = await this.transactions.tx
      .select({
        request: answerRequests,
        executionLive: sql<boolean>`${answerRequests.expiresAt} > clock_timestamp()`,
        answerLive: sql<boolean>`${answerRequests.answerExpiresAt} > clock_timestamp()`,
      })
      .from(answerRequests)
      .where(and(eq(answerRequests.ownerId, ownerId), eq(answerRequests.requestId, requestId)));

    return row ?? null;
  }

  @Transactional(Propagation.Mandatory)
  async reserve(input: {
    ownerId: string;
    requestId: string;
    fingerprint: string;
    question: string;
    evidence: AnswerEvidenceSnapshot[];
    reservationId: string;
    consentEpoch: number;
    policy: AnswerPolicy;
  }) {
    await this.transactions.tx.insert(answerRequests).values({
      ownerId: input.ownerId,
      requestId: input.requestId,
      fingerprint: input.fingerprint,
      configFingerprint: input.policy.fingerprint,
      consentEpoch: input.consentEpoch,
      reservationId: input.reservationId,
      state: 'RESERVED',
      question: input.question,
      evidence: input.evidence,
      expiresAt: sql`clock_timestamp() + ${input.policy.reservationSeconds} * interval '1 second'`,
      dedupeExpiresAt: sql`clock_timestamp() + ${input.policy.receiptRetentionDays} * interval '1 day'`,
      answerRetentionSeconds: input.policy.answerRetentionSeconds,
    });
  }
}
