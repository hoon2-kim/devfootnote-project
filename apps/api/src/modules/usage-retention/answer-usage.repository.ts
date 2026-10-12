import { Injectable } from '@nestjs/common';
import { TransactionHost, Transactional, Propagation } from '@nestjs-cls/transactional';
import { eq, sql } from 'drizzle-orm';
import { answerConsents } from '@devfootnote/db/schema/usage-retention';
import { reserveAiBudget } from '@devfootnote/db/usage-retention/budget-reservation';
import type { AnswerPolicy } from '@devfootnote/ai';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import { AnswerUsageError } from './answer-usage.error.js';

@Injectable()
export class AnswerUsageRepository {
  constructor(private readonly transactions: TransactionHost<PostgresTransactionAdapter>) {}

  async consent(ownerId: string) {
    const [row] = await this.transactions.tx
      .select()
      .from(answerConsents)
      .where(eq(answerConsents.ownerId, ownerId));

    return row ?? null;
  }

  @Transactional(Propagation.Mandatory)
  async lockConsent(ownerId: string) {
    await this.transactions.tx.insert(answerConsents).values({ ownerId }).onConflictDoNothing();
    const [row] = await this.transactions.tx
      .select()
      .from(answerConsents)
      .where(eq(answerConsents.ownerId, ownerId))
      .for('update');

    if (!row) {
      throw new AnswerUsageError('unavailable');
    }

    return row;
  }

  @Transactional(Propagation.Mandatory)
  async grant(ownerId: string, epoch: number, policy: AnswerPolicy) {
    await this.transactions.tx
      .update(answerConsents)
      .set({
        epoch,
        configFingerprint: policy.fingerprint,
        policyVersion: policy.policyVersion,
        grantedAt: sql`clock_timestamp()`,
        revokedAt: null,
      })
      .where(eq(answerConsents.ownerId, ownerId));
  }

  @Transactional(Propagation.Mandatory)
  async revoke(ownerId: string, epoch: number) {
    await this.transactions.tx
      .update(answerConsents)
      .set({ epoch, revokedAt: sql`clock_timestamp()` })
      .where(eq(answerConsents.ownerId, ownerId));
  }

  @Transactional(Propagation.Mandatory)
  async reserve(
    ownerId: string,
    requestId: string,
    fingerprint: string,
    epoch: number,
    policy: AnswerPolicy,
  ) {
    const result = await reserveAiBudget(this.transactions.tx, {
      ownerId,
      requestId,
      fingerprint,
      epoch,
      purpose: 'grounded-answer',
      amount: BigInt(policy.requestMaximum),
      policy,
    });

    if (!result.accepted) {
      throw new AnswerUsageError(result.reason);
    }

    return result.id;
  }
}
