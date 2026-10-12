import { reserveAiBudget } from '@devfootnote/db/usage-retention/budget-reservation';
import { Injectable } from '@nestjs/common';
import { TransactionHost, Transactional, Propagation } from '@nestjs-cls/transactional';
import { and, eq, sql } from 'drizzle-orm';
import {
  embeddingBudgets,
  embeddingConsents,
  embeddingReservations,
  embeddingCallReceipts,
} from '@devfootnote/db/schema/usage-retention';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import { UsageError, type ApprovedEmbeddingPolicy } from './embedding-policy.js';

@Injectable()
export class UsageRepository {
  constructor(private readonly transactions: TransactionHost<PostgresTransactionAdapter>) {}

  async consent(ownerId: string) {
    const [row] = await this.transactions.tx
      .select()
      .from(embeddingConsents)
      .where(eq(embeddingConsents.ownerId, ownerId));

    return row;
  }

  @Transactional(Propagation.Mandatory)
  async lockConsent(ownerId: string) {
    await this.transactions.tx.insert(embeddingConsents).values({ ownerId }).onConflictDoNothing();
    const [row] = await this.transactions.tx
      .select()
      .from(embeddingConsents)
      .where(eq(embeddingConsents.ownerId, ownerId))
      .for('update');

    if (!row) {
      throw new Error('동의 행을 확인하지 못했습니다.');
    }

    return row;
  }

  @Transactional(Propagation.Mandatory)
  async grant(ownerId: string, epoch: number, policy: ApprovedEmbeddingPolicy) {
    await this.transactions.tx
      .update(embeddingConsents)
      .set({
        epoch,
        configFingerprint: policy.fingerprint,
        policyVersion: policy.policyVersion,
        grantedAt: sql`now()`,
        revokedAt: null,
      })
      .where(eq(embeddingConsents.ownerId, ownerId));
  }

  @Transactional(Propagation.Mandatory)
  async revoke(ownerId: string, epoch: number) {
    await this.transactions.tx
      .update(embeddingConsents)
      .set({ epoch, revokedAt: sql`now()` })
      .where(eq(embeddingConsents.ownerId, ownerId));
    // 철회만으로 비용 예약을 지우면 이미 발생한 비용을 잃을 수 있으므로 여기서는 보존한다.
  }

  @Transactional(Propagation.Mandatory)
  async queryRequestExists(ownerId: string, requestId: string) {
    const [row] = await this.transactions.tx
      .select({ id: embeddingReservations.id })
      .from(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.requestId, requestId),
          eq(embeddingReservations.purpose, 'embedding'),
        ),
      );

    return Boolean(row);
  }

  @Transactional(Propagation.Mandatory)
  async exposeQuery(ownerId: string, reservationId: string) {
    const [row] = await this.transactions.tx
      .update(embeddingReservations)
      .set({ exposureStartedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
          eq(embeddingReservations.state, 'reserved'),
          sql`${embeddingReservations.expiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: embeddingReservations.id });

    if (!row) {
      throw new UsageError('unavailable');
    }
  }

  @Transactional(Propagation.Mandatory)
  async settleQuery(ownerId: string, reservationId: string, tokens: number | null) {
    const tx = this.transactions.tx;
    const [identity] = await tx
      .select({ budgetId: embeddingReservations.budgetId })
      .from(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.id, reservationId),
          eq(embeddingReservations.ownerId, ownerId),
        ),
      );

    if (!identity) {
      throw new UsageError('unavailable');
    }

    // chunk 예약과 동일한 서비스 예산 잠금 순서를 지켜 admission과 정산 합계가 엇갈리지 않게 한다.
    await tx
      .select({ id: embeddingBudgets.id })
      .from(embeddingBudgets)
      .where(eq(embeddingBudgets.id, identity.budgetId))
      .for('update');
    const [reservation] = await tx
      .select()
      .from(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.id, reservationId),
          eq(embeddingReservations.ownerId, ownerId),
        ),
      )
      .for('update');

    if (!reservation || reservation.state !== 'reserved') {
      return false;
    }

    const price = reservation.pricingSnapshot.pricePerToken;

    if (
      reservation.pricingSnapshot.currency !== 'USD' ||
      reservation.pricingSnapshot.unitScale !== 1_000_000_000 ||
      !price ||
      !/^[1-9][0-9]*$/.test(price) ||
      (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 8192))
    ) {
      throw new UsageError('policy_conflict');
    }

    const amount = tokens === null ? reservation.reservedMaximum : BigInt(tokens) * BigInt(price);

    if (amount > reservation.reservedMaximum) {
      throw new UsageError('policy_conflict');
    }

    await tx
      .insert(embeddingCallReceipts)
      .values({
        attemptId: reservation.id,
        ownerId,
        reservationId,
        tokens,
        amount: tokens === null ? null : amount,
      })
      .onConflictDoNothing();
    const [settled] = await tx
      .update(embeddingReservations)
      .set({ state: 'settled', settledAmount: amount, completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(embeddingReservations.id, reservationId),
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.state, 'reserved'),
        ),
      )
      .returning({ current: sql<boolean>`${embeddingReservations.expiresAt} > clock_timestamp()` });

    return settled?.current ?? false;
  }

  @Transactional(Propagation.Mandatory)
  async reserve(
    ownerId: string,
    requestId: string,
    fingerprint: string,
    epoch: number,
    amount: bigint,
    policy: ApprovedEmbeddingPolicy,
  ) {
    const result = await reserveAiBudget(this.transactions.tx, {
      ownerId,
      requestId,
      fingerprint,
      epoch,
      amount,
      policy,
    });

    if (!result.accepted) {
      throw new UsageError(result.reason);
    }

    return result.id;
  }
}
