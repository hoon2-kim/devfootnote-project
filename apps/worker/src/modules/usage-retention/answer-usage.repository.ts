import { Injectable } from '@nestjs/common';
import {
  InjectTransactionHost,
  TransactionHost,
  Transactional,
  Propagation,
} from '@nestjs-cls/transactional';
import { and, eq, sql } from 'drizzle-orm';
import {
  answerConsents,
  embeddingBudgets,
  embeddingReservations,
} from '@devfootnote/db/schema/usage-retention';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';

@Injectable()
export class AnswerUsageRepository {
  constructor(
    @InjectTransactionHost('worker')
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  @Transactional('worker', Propagation.Mandatory)
  async lockConsent(ownerId: string) {
    const [row] = await this.transactions.tx
      .select()
      .from(answerConsents)
      .where(eq(answerConsents.ownerId, ownerId))
      .for('update');

    return row
      ? {
          epoch: row.epoch,
          fingerprint: row.configFingerprint,
          granted: Boolean(row.grantedAt && !row.revokedAt),
        }
      : null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async lockReservation(ownerId: string, id: string) {
    const tx = this.transactions.tx;
    const where = and(
      eq(embeddingReservations.ownerId, ownerId),
      eq(embeddingReservations.id, id),
      eq(embeddingReservations.purpose, 'grounded-answer'),
    );
    const [reference] = await tx
      .select({ budgetId: embeddingReservations.budgetId })
      .from(embeddingReservations)
      .where(where);

    if (!reference) {
      return null;
    }

    await tx
      .select({ id: embeddingBudgets.id })
      .from(embeddingBudgets)
      .where(eq(embeddingBudgets.id, reference.budgetId))
      .for('update');
    await tx
      .select({ id: embeddingReservations.id })
      .from(embeddingReservations)
      .where(where)
      .for('update');
    const [row] = await tx
      .select({
        reservation: embeddingReservations,
        active: sql<boolean>`${embeddingReservations.expiresAt} > clock_timestamp()`,
      })
      .from(embeddingReservations)
      .where(where);

    return row ?? null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async expose(ownerId: string, id: string) {
    const [row] = await this.transactions.tx
      .update(embeddingReservations)
      .set({ exposureStartedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, id),
          eq(embeddingReservations.purpose, 'grounded-answer'),
          eq(embeddingReservations.state, 'reserved'),
          sql`${embeddingReservations.expiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: embeddingReservations.id });

    return Boolean(row);
  }

  @Transactional('worker', Propagation.Mandatory)
  async settle(
    ownerId: string,
    id: string,
    usage: { inputTokens: number; outputTokens: number } | null,
  ) {
    const locked = await this.lockReservation(ownerId, id);

    if (!locked || locked.reservation.state !== 'reserved') {
      return;
    }

    const row = locked.reservation;
    let amount = row.exposureStartedAt ? row.reservedMaximum : 0n;
    const { inputPricePerToken, outputPricePerToken } = row.pricingSnapshot;
    let acceptedUsage: typeof usage = null;

    if (
      usage &&
      row.exposureStartedAt &&
      Number.isSafeInteger(usage.inputTokens) &&
      Number.isSafeInteger(usage.outputTokens) &&
      usage.inputTokens >= 0 &&
      usage.outputTokens >= 0 &&
      inputPricePerToken &&
      outputPricePerToken
    ) {
      const actual =
        BigInt(usage.inputTokens) * BigInt(inputPricePerToken) +
        BigInt(usage.outputTokens) * BigInt(outputPricePerToken);

      // 승인된 최대 입력·출력 범위를 벗어난 usage는 신뢰하지 않고 예약 상한으로 닫는다.
      if (actual <= row.reservedMaximum) {
        amount = actual;
        acceptedUsage = usage;
      }
    }

    await this.transactions.tx
      .update(embeddingReservations)
      .set({
        state: row.exposureStartedAt ? 'settled' : 'released',
        settledAmount: row.exposureStartedAt ? amount : null,
        inputTokens: acceptedUsage?.inputTokens ?? null,
        outputTokens: acceptedUsage?.outputTokens ?? null,
        completedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, id),
          eq(embeddingReservations.state, 'reserved'),
        ),
      );
  }

  @Transactional('worker', Propagation.Mandatory)
  async deleteReceipt(ownerId: string, id: string) {
    await this.transactions.tx
      .delete(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, id),
          eq(embeddingReservations.purpose, 'grounded-answer'),
          sql`${embeddingReservations.state} <> 'reserved'`,
          sql`${embeddingReservations.completedAt} < clock_timestamp() - interval '90 days'`,
        ),
      );
  }

  @Transactional('worker', Propagation.Mandatory)
  async receiptExpired(ownerId: string, id: string) {
    const [row] = await this.transactions.tx
      .select({ id: embeddingReservations.id })
      .from(embeddingReservations)
      .where(
        and(
          eq(embeddingReservations.ownerId, ownerId),
          eq(embeddingReservations.id, id),
          eq(embeddingReservations.purpose, 'grounded-answer'),
          sql`${embeddingReservations.state} <> 'reserved'`,
          sql`${embeddingReservations.completedAt} < clock_timestamp() - interval '90 days'`,
        ),
      );

    return Boolean(row);
  }
}
