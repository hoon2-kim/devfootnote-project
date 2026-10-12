import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { embeddingBudgets, embeddingReservations } from '../schema/usage-retention.js';

// CLS adapter의 tx 타입도 이 API를 제공한다. 실제 transaction 강제는 앱의 Mandatory 경계다.
type Transaction = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>;

/** 가격과 기간만 받는다. provider 선택·동의 판정과 transaction 수명은 호출 앱이 소유한다. */
interface ReservationPolicy {
  fingerprint: string;
  budgetPeriod?: 'utc-month';
  budgetId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  unitScale: number;
  budgetLimit: string;
  purposeBudgetLimit?: string;
  pricingVersion: string;
  maximumPerChunk?: string;
  inputPricePerToken?: string;
  outputPricePerToken?: string;
  requestMaximum?: string;
  pricePerToken?: string;
  reservationSeconds: number;
}

type ReservationResult =
  | { accepted: true; id: string }
  | { accepted: false; reason: 'policy_conflict' | 'budget_exhausted' };

/** API admission과 worker 자동 활성화가 같은 잠금·합산 불변식을 사용한다. */
export async function reserveAiBudget(
  tx: Transaction,
  input: {
    ownerId: string;
    requestId: string;
    fingerprint: string;
    epoch: number;
    amount: bigint;
    policy: ReservationPolicy;
    purpose?: 'embedding' | 'grounded-answer';
  },
): Promise<ReservationResult> {
  const { policy } = input;
  const purpose = input.purpose ?? 'embedding';
  let budgetId = policy.budgetId;
  let periodStart = new Date(policy.periodStart);
  let periodEnd = new Date(policy.periodEnd);

  if (policy.budgetPeriod === 'utc-month') {
    const {
      rows: [clock],
    } = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);

    if (!clock) {
      throw new Error('예산 기간의 DB 시각을 확인하지 못했습니다.');
    }

    const now = new Date(clock.now);
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();

    budgetId = `df000000-0000-4000-8000-${`${year}${String(month + 1).padStart(2, '0')}`.padStart(12, '0')}`;
    periodStart = new Date(Date.UTC(year, month, 1));
    periodEnd = new Date(Date.UTC(year, month + 1, 1));
  }

  await tx
    .insert(embeddingBudgets)
    .values({
      id: budgetId,
      periodStart,
      periodEnd,
      currency: policy.currency,
      unitScale: policy.unitScale,
      limit: BigInt(policy.budgetLimit),
    })
    .onConflictDoNothing();
  const [budget] = await tx
    .select()
    .from(embeddingBudgets)
    .where(eq(embeddingBudgets.id, budgetId))
    .for('update');

  if (
    !budget ||
    budget.periodStart.getTime() !== periodStart.getTime() ||
    budget.periodEnd.getTime() !== periodEnd.getTime() ||
    budget.currency !== policy.currency ||
    budget.unitScale !== policy.unitScale ||
    budget.limit < BigInt(policy.budgetLimit)
  ) {
    return { accepted: false, reason: 'policy_conflict' };
  }

  // 승인된 한도 축소는 기존 사용액·예약을 보존한다. 다른 앱의 이전 설정으로 다시 올리지 않는다.
  if (budget.limit > BigInt(policy.budgetLimit)) {
    await tx
      .update(embeddingBudgets)
      .set({ limit: BigInt(policy.budgetLimit) })
      .where(eq(embeddingBudgets.id, budgetId));
  }

  // 잠금 대기 전 now()로 계산하면 월 경계 뒤에도 지난달 예산을 사용할 수 있다.
  // 잠금 취득 후 DB 시각 하나로 기간·유효 예약·새 예약 TTL을 함께 계산한다.
  const {
    rows: [clock],
  } = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);

  if (!clock) {
    throw new Error('예산 예약의 DB 시각을 확인하지 못했습니다.');
  }

  const now = new Date(clock.now);

  if (now < periodStart || now >= periodEnd) {
    return { accepted: false, reason: 'policy_conflict' };
  }

  const committedAmount = sql`case
        when ${embeddingReservations.state} = 'settled' then ${embeddingReservations.settledAmount}
        when ${embeddingReservations.state} = 'reserved'
          and (${embeddingReservations.expiresAt} > ${clock.now}::timestamptz
            or ${embeddingReservations.exposureStartedAt} is not null)
          then ${embeddingReservations.reservedMaximum}
        else 0 end`;
  const [total] = await tx
    .select({
      amount: sql<string>`coalesce(sum(${committedAmount}), 0)::text`,
      purposeAmount: sql<string>`coalesce(sum(case when ${embeddingReservations.purpose} = ${purpose} then ${committedAmount} else 0 end), 0)::text`,
    })
    .from(embeddingReservations)
    .where(eq(embeddingReservations.budgetId, budgetId));

  if (
    !total ||
    BigInt(total.amount) + input.amount > BigInt(policy.budgetLimit) ||
    (policy.purposeBudgetLimit !== undefined &&
      BigInt(total.purposeAmount) + input.amount > BigInt(policy.purposeBudgetLimit))
  ) {
    return { accepted: false, reason: 'budget_exhausted' };
  }

  const id = randomUUID();

  await tx.insert(embeddingReservations).values({
    id,
    ownerId: input.ownerId,
    budgetId,
    requestId: input.requestId,
    fingerprint: input.fingerprint,
    configFingerprint: policy.fingerprint,
    purpose,
    consentEpoch: input.epoch,
    reservedMaximum: input.amount,
    pricingSnapshot: {
      version: policy.pricingVersion,
      currency: policy.currency,
      unitScale: policy.unitScale,
      ...(policy.maximumPerChunk === undefined ? {} : { maximumPerChunk: policy.maximumPerChunk }),
      ...(policy.pricePerToken === undefined ? {} : { pricePerToken: policy.pricePerToken }),
      ...(policy.inputPricePerToken === undefined
        ? {}
        : { inputPricePerToken: policy.inputPricePerToken }),
      ...(policy.outputPricePerToken === undefined
        ? {}
        : { outputPricePerToken: policy.outputPricePerToken }),
      ...(policy.requestMaximum === undefined ? {} : { requestMaximum: policy.requestMaximum }),
    },
    expiresAt: sql`least(${clock.now}::timestamptz + ${policy.reservationSeconds} * interval '1 second', ${periodEnd.toISOString()}::timestamptz)`,
  });

  return { accepted: true, id };
}
