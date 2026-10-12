import {
  embeddingBudgets,
  embeddingCallReceipts,
  embeddingConsents,
  embeddingReservations,
} from '@devfootnote/db/schema/usage-retention';
import { Injectable } from '@nestjs/common';
import {
  InjectTransactionHost,
  Propagation,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import { and, eq, inArray, isNull, isNotNull, like, lte, sql } from 'drizzle-orm';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import { reserveAiBudget } from '@devfootnote/db/usage-retention/budget-reservation';
import type { ApprovedEmbeddingPolicy } from '@devfootnote/ai';

@Injectable()
export class UsageRepository {
  constructor(
    @InjectTransactionHost('worker')
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  @Transactional('worker', Propagation.Mandatory)
  async reserveCurrent(
    ownerId: string,
    requestId: string,
    fingerprint: string,
    epoch: number,
    amount: bigint,
    policy: ApprovedEmbeddingPolicy,
  ): Promise<string | null> {
    const result = await reserveAiBudget(this.transactions.tx, {
      ownerId,
      requestId,
      fingerprint,
      epoch,
      amount,
      policy,
    });

    return result.accepted ? result.id : null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async lockConsent(ownerId: string) {
    const [consent] = await this.transactions.tx
      .select({
        epoch: embeddingConsents.epoch,
        configFingerprint: embeddingConsents.configFingerprint,
        granted: sql<boolean>`${embeddingConsents.grantedAt} is not null and ${embeddingConsents.revokedAt} is null`,
      })
      .from(embeddingConsents)
      .where(eq(embeddingConsents.ownerId, ownerId))
      .for('update');

    return consent ?? null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async lockReservation(ownerId: string, reservationId: string) {
    const tx = this.transactions.tx;
    const [identity] = await tx
      .select({ budgetId: embeddingReservations.budgetId })
      .from(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
        ),
      );

    if (!identity) {
      return null;
    }

    // API의 새 예약과 같은 예산 행을 먼저 잠근다. 노출 기록의 commit 전에
    // 예약 기한이 지나더라도 API가 그 금액을 다시 사용할 수 없게 한다.
    await tx
      .select({ id: embeddingBudgets.id })
      .from(embeddingBudgets)
      .where(eq(embeddingBudgets.id, identity.budgetId))
      .for('update');

    const [reservation] = await tx
      .select({
        id: embeddingReservations.id,
        configFingerprint: embeddingReservations.configFingerprint,
        consentEpoch: embeddingReservations.consentEpoch,
        state: embeddingReservations.state,
        exposed: sql<boolean>`${embeddingReservations.exposureStartedAt} is not null`,
      })
      .from(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
        ),
      )
      .for('update');

    if (!reservation) {
      return null;
    }

    // 잠금을 기다리는 동안 만료될 수 있어, 잠금 취득 뒤의 DB 시각으로 판단한다.
    const [eligibility] = await tx
      .select({
        active: sql<boolean>`${embeddingReservations.state} = 'reserved' and ${embeddingReservations.expiresAt} > clock_timestamp()`,
      })
      .from(embeddingReservations)
      .where(eq(embeddingReservations.id, reservation.id));

    return { ...reservation, active: eligibility?.active ?? false };
  }

  @Transactional('worker', Propagation.Mandatory)
  async markExposure(ownerId: string, reservationId: string) {
    const [reservation] = await this.transactions.tx
      .update(embeddingReservations)
      .set({
        exposureStartedAt: sql`coalesce(${embeddingReservations.exposureStartedAt}, clock_timestamp())`,
      })
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
          eq(embeddingReservations.state, 'reserved'),
          sql`${embeddingReservations.expiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: embeddingReservations.id });

    return reservation !== undefined;
  }

  @Transactional('worker', Propagation.Mandatory)
  async recordCall(
    ownerId: string,
    reservationId: string,
    attemptId: string,
    tokens: number | null,
  ) {
    const [reservation] = await this.transactions.tx
      .select()
      .from(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
        ),
      );

    const price = reservation?.pricingSnapshot.pricePerToken;

    if (
      !reservation ||
      reservation.pricingSnapshot.currency !== 'USD' ||
      reservation.pricingSnapshot.unitScale !== 1_000_000_000 ||
      !price ||
      !/^[1-9][0-9]*$/.test(price)
    ) {
      throw new Error('임베딩 정산 단위 또는 단가가 없습니다.');
    }

    // 현재 설정이 아니라 예약 당시 단가로 계산한다. 설정이 바뀐 뒤 도착한 응답도 동일하다.
    const amount = tokens === null ? null : BigInt(tokens) * BigInt(price);

    if (amount !== null && amount > reservation.reservedMaximum) {
      throw new Error('임베딩 비용이 예약 상한을 초과했습니다.');
    }

    // 호출 결과 원문은 저장하지 않는다. 같은 attempt의 첫 기록만 비용 근거로 유지한다.
    await this.transactions.tx
      .insert(embeddingCallReceipts)
      .values({
        ownerId,
        reservationId,
        attemptId,
        tokens,
        amount,
      })
      .onConflictDoNothing({ target: embeddingCallReceipts.attemptId });
  }

  @Transactional('worker', Propagation.Mandatory)
  async settle(ownerId: string, reservationId: string, attemptIds: readonly string[]) {
    const tx = this.transactions.tx;
    const [reservation] = await tx
      .select()
      .from(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
        ),
      );

    if (!reservation || reservation.state !== 'reserved') {
      return;
    }

    const receipts = await tx
      .select()
      .from(embeddingCallReceipts)
      .where(
        and(
          eq(embeddingCallReceipts.ownerId, ownerId),
          eq(embeddingCallReceipts.reservationId, reservationId),
        ),
      );
    const amounts = new Map(receipts.map((receipt) => [receipt.attemptId, receipt.amount]));
    const unknown =
      (reservation.exposureStartedAt !== null && attemptIds.length === 0) ||
      attemptIds.some((id) => amounts.get(id) == null);
    const actual = attemptIds.reduce((sum, id) => sum + (amounts.get(id) ?? 0n), 0n);

    if (actual > reservation.reservedMaximum) {
      throw new Error('임베딩 비용이 예약 상한을 초과했습니다.');
    }

    // 실패·crash로 사용량이 빠진 시도가 하나라도 있으면 공유 예약 전체 상한을 보존한다.
    const amount = unknown ? reservation.reservedMaximum : actual;

    await tx
      .update(embeddingReservations)
      .set({ state: 'settled', settledAmount: amount, completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
          eq(embeddingReservations.state, 'reserved'),
        ),
      );
  }

  @Transactional('worker', Propagation.Mandatory)
  async expireUnexposed(limit: number) {
    const tx = this.transactions.tx;
    const eligible = and(
      eq(embeddingReservations.purpose, 'embedding'),
      eq(embeddingReservations.state, 'reserved'),
      isNull(embeddingReservations.exposureStartedAt),
      lte(embeddingReservations.expiresAt, sql`clock_timestamp()`),
    );
    const expired = await tx
      .select({ id: embeddingReservations.id })
      .from(embeddingReservations)
      .where(eligible)
      .orderBy(embeddingReservations.expiresAt, embeddingReservations.id)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (expired.length === 0) {
      return 0;
    }

    // 여러 work가 공유하는 예약은 한 work의 실패만으로 해제하지 않는다.
    // 호출 노출이 전혀 없고 예약 기한까지 지난 경우에만 비용 상한을 비운다.
    const changed = await tx
      .update(embeddingReservations)
      .set({ state: 'expired', completedAt: sql`clock_timestamp()` })
      .where(
        and(
          inArray(
            embeddingReservations.id,
            expired.map((reservation) => reservation.id),
          ),
          eligible,
        ),
      )
      .returning({ id: embeddingReservations.id });

    return changed.length;
  }

  @Transactional('worker', Propagation.Mandatory)
  async settleExpiredQueries(limit: number) {
    const tx = this.transactions.tx;
    const eligible = and(
      eq(embeddingReservations.state, 'reserved'),
      like(embeddingReservations.fingerprint, 'query-v1:%'),
      isNotNull(embeddingReservations.exposureStartedAt),
      lte(embeddingReservations.expiresAt, sql`clock_timestamp()`),
    );
    const expired = await tx
      .select({ id: embeddingReservations.id })
      .from(embeddingReservations)
      .where(eligible)
      .orderBy(embeddingReservations.expiresAt, embeddingReservations.id)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (!expired.length) {
      return 0;
    }

    // 이미 예산에 포함된 노출 상한을 그대로 확정한다. 비용을 늘리지 않고 다른 잠금도 잡지 않는다.
    // chunk의 공유 예약은 work가 모두 종료되어야 하므로 이 경로에서 처리하지 않는다.
    const settled = await tx
      .update(embeddingReservations)
      .set({
        state: 'settled',
        settledAmount: sql`${embeddingReservations.reservedMaximum}`,
        completedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          inArray(
            embeddingReservations.id,
            expired.map((row) => row.id),
          ),
          eligible,
        ),
      )
      .returning({ id: embeddingReservations.id });

    return settled.length;
  }

  @Transactional('worker', Propagation.Mandatory)
  async reserveAuditCleanup(limit: number) {
    const tx = this.transactions.tx;
    const rows = await tx
      .select({ id: embeddingReservations.id, ownerId: embeddingReservations.ownerId })
      .from(embeddingReservations)
      .innerJoin(embeddingBudgets, eq(embeddingBudgets.id, embeddingReservations.budgetId))
      .where(
        and(
          inArray(embeddingReservations.state, ['settled', 'released', 'expired']),
          eq(embeddingReservations.purpose, 'embedding'),
          lte(embeddingReservations.completedAt, sql`clock_timestamp() - interval '90 days'`),
          lte(embeddingBudgets.periodEnd, sql`clock_timestamp()`),
          lte(embeddingReservations.cleanupAfter, sql`clock_timestamp()`),
        ),
      )
      .orderBy(embeddingReservations.cleanupAfter, embeddingReservations.id)
      .limit(limit)
      .for('update', { of: embeddingReservations, skipLocked: true });

    if (rows.length) {
      await tx
        .update(embeddingReservations)
        .set({ cleanupAfter: sql`clock_timestamp() + interval '15 seconds'` })
        .where(
          inArray(
            embeddingReservations.id,
            rows.map((row) => row.id),
          ),
        );
    }

    return rows;
  }

  @Transactional('worker', Propagation.Mandatory)
  async auditExpired(ownerId: string, reservationId: string) {
    const [row] = await this.transactions.tx
      .select({
        eligible: sql<boolean>`
      ${embeddingReservations.purpose} = 'embedding'
      and ${embeddingReservations.state} in ('settled','released','expired')
      and ${embeddingReservations.completedAt} <= clock_timestamp() - interval '90 days'
      and ${embeddingBudgets.periodEnd} <= clock_timestamp()`,
      })
      .from(embeddingReservations)
      .innerJoin(embeddingBudgets, eq(embeddingBudgets.id, embeddingReservations.budgetId))
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
        ),
      );

    return row?.eligible ?? false;
  }

  @Transactional('worker', Propagation.Mandatory)
  async deleteAudit(ownerId: string, reservationId: string) {
    const tx = this.transactions.tx;

    await tx
      .delete(embeddingCallReceipts)
      .where(
        and(
          eq(embeddingCallReceipts.ownerId, ownerId),
          eq(embeddingCallReceipts.reservationId, reservationId),
        ),
      );
    await tx
      .delete(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, reservationId),
        ),
      );
  }

  @Transactional('worker', Propagation.Mandatory)
  async deleteExpiredBudgets(limit: number) {
    const tx = this.transactions.tx;
    const rows = await tx
      .select({ id: embeddingBudgets.id })
      .from(embeddingBudgets)
      .where(
        and(
          lte(embeddingBudgets.periodEnd, sql`clock_timestamp() - interval '90 days'`),
          sql`not exists (select 1 from ${embeddingReservations} where ${embeddingReservations.budgetId} = ${embeddingBudgets.id})`,
        ),
      )
      .orderBy(embeddingBudgets.periodEnd, embeddingBudgets.id)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (rows.length) {
      await tx.delete(embeddingBudgets).where(
        inArray(
          embeddingBudgets.id,
          rows.map((row) => row.id),
        ),
      );
    }

    return rows.length;
  }
}
