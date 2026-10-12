import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@devfootnote/db';
import { reserveAiBudget } from '@devfootnote/db/usage-retention/budget-reservation';
import { startAuthHarness } from './auth-harness.js';

describe('API·worker 공유 예산 예약 / 실제 PostgreSQL', () => {
  let harness: Awaited<ReturnType<typeof startAuthHarness>>;
  let db: ReturnType<typeof createDatabase>;
  let ownerId: string;
  const fixedPolicy = {
    fingerprint: 'fixture-vector-consent',
    budgetId: '00000000-0000-4000-8000-000000000100',
    periodStart: '2020-01-01T00:00:00.000Z',
    periodEnd: '2100-01-01T00:00:00.000Z',
    currency: 'USD',
    unitScale: 1000000,
    budgetLimit: '100',
    pricingVersion: 'fixture-price',
    maximumPerChunk: '10',
    reservationSeconds: 600,
  };
  const reserve = (
    amount: bigint,
    policy: typeof fixedPolicy & {
      purposeBudgetLimit?: string;
      budgetPeriod?: 'utc-month';
    } = fixedPolicy,
    purpose: 'embedding' | 'grounded-answer' = 'embedding',
  ) =>
    db.transaction((tx) =>
      reserveAiBudget(tx, {
        ownerId,
        requestId: randomUUID(),
        fingerprint: randomUUID(),
        epoch: 1,
        amount,
        policy,
        purpose,
      }),
    );

  beforeAll(async () => {
    harness = await startAuthHarness();
    db = createDatabase(harness.pool);
  });

  beforeEach(async () => {
    await harness.pool.query('truncate accounts cascade');
    ownerId = randomUUID();
    await harness.pool.query(
      "insert into accounts(id, issuer, subject) values ($1, 'fixture', $2)",
      [ownerId, randomUUID()],
    );
    // 예산은 서비스 공유 행이므로 owner cascade와 별개다.
    await harness.pool.query('delete from usage_embedding_budgets');
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('예산 행에서 실제로 경쟁하는 두 예약 중 하나만 상한 안에서 commit한다', async () => {
    expect((await reserve(1n)).accepted).toBe(true);
    await harness.pool.query('delete from usage_embedding_reservations');
    const blocker = await harness.pool.connect();
    let pending = Promise.resolve<PromiseSettledResult<Awaited<ReturnType<typeof reserve>>>[]>([]);

    try {
      await blocker.query('begin');
      await blocker.query('select id from usage_embedding_budgets for update');
      pending = Promise.allSettled([reserve(60n), reserve(60n)]);
      await vi.waitFor(async () => {
        const { rows } = await harness.pool.query(`select count(*)::int as count
          from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query like '%usage_embedding_budgets%'`);

        expect(rows[0].count).toBe(2);
      });
    } finally {
      try {
        await blocker.query('rollback');
      } finally {
        blocker.release();
        await pending;
      }
    }

    const results = (await pending).map((result) => {
      if (result.status === 'rejected') {
        throw result.reason;
      }

      return result.value;
    });

    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results).toContainEqual({ accepted: false, reason: 'budget_exhausted' });
    const { rows } = await harness.pool.query(`select count(*)::int as count,
      sum(reserved_maximum)::text as amount from usage_embedding_reservations`);

    expect(rows[0]).toEqual({ count: 1, amount: '60' });
  });

  it('만료된 미노출 예약은 제외하지만 노출된 미정산 예약은 상한에서 빼지 않는다', async () => {
    const exposed = await reserve(70n);

    expect(exposed.accepted).toBe(true);
    await harness.pool.query(`update usage_embedding_reservations
      set created_at = clock_timestamp() - interval '2 hours',
          expires_at = clock_timestamp() - interval '1 hour',
          exposure_started_at = clock_timestamp() - interval '90 minutes'`);
    expect(await reserve(31n)).toEqual({ accepted: false, reason: 'budget_exhausted' });
    await harness.pool.query('update usage_embedding_reservations set exposure_started_at = null');
    expect((await reserve(100n)).accepted).toBe(true);
    expect(await reserve(1n)).toEqual({ accepted: false, reason: 'budget_exhausted' });
  });

  it('지난달에 시작한 앱의 설정도 DB의 현재 UTC 월 예산을 선택한다', async () => {
    const policy = {
      ...fixedPolicy,
      budgetPeriod: 'utc-month' as const,
      periodStart: '2020-01-01T00:00:00.000Z',
      periodEnd: '2020-02-01T00:00:00.000Z',
    };

    expect((await reserve(60n, policy)).accepted).toBe(true);
    expect(await reserve(41n, policy)).toEqual({ accepted: false, reason: 'budget_exhausted' });
    const { rows } = await harness.pool.query(`select id::text,
      period_start = date_trunc('month', clock_timestamp() at time zone 'UTC') at time zone 'UTC' as current,
      id::text = 'df000000-0000-4000-8000-000000' || to_char(clock_timestamp() at time zone 'UTC', 'YYYYMM') as identity
      from usage_embedding_budgets`);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ current: true, identity: true });
    expect(rows[0].id).not.toBe(policy.budgetId);
  });

  it('기간 중 예산을 줄여도 이전 사용량을 지우거나 이전 앱 설정으로 한도를 되돌리지 않는다', async () => {
    expect((await reserve(60n)).accepted).toBe(true);
    expect(await reserve(1n, { ...fixedPolicy, budgetLimit: '50' })).toEqual({
      accepted: false,
      reason: 'budget_exhausted',
    });
    expect(await reserve(1n)).toEqual({ accepted: false, reason: 'policy_conflict' });
    const { rows } = await harness.pool.query('select "limit"::text from usage_embedding_budgets');

    expect(rows[0]?.limit).toBe('50');
  });

  it('두 목적이 같은 월 예산을 공유하고 목적별 한도와 전체 한도를 함께 지킨다', async () => {
    const policy = { ...fixedPolicy, budgetPeriod: 'utc-month' as const, purposeBudgetLimit: '50' };

    expect((await reserve(50n, policy, 'embedding')).accepted).toBe(true);
    expect(await reserve(1n, policy, 'embedding')).toEqual({
      accepted: false,
      reason: 'budget_exhausted',
    });
    expect((await reserve(50n, policy, 'grounded-answer')).accepted).toBe(true);
    expect(await reserve(1n, policy, 'grounded-answer')).toEqual({
      accepted: false,
      reason: 'budget_exhausted',
    });
    const { rows } = await harness.pool.query(
      'select count(distinct budget_id)::int as budgets, sum(reserved_maximum)::text as total from usage_embedding_reservations',
    );

    expect(rows[0]).toEqual({ budgets: 1, total: '100' });
  });

  it('배분 전 임베딩 사용액이 목적별 한도를 넘었어도 답변 추가로 전체 상한을 넘기지 않는다', async () => {
    expect((await reserve(70n)).accepted).toBe(true);
    const policy = { ...fixedPolicy, purposeBudgetLimit: '50' };

    expect(await reserve(31n, policy, 'grounded-answer')).toEqual({
      accepted: false,
      reason: 'budget_exhausted',
    });
    expect((await reserve(30n, policy, 'grounded-answer')).accepted).toBe(true);
  });

  it('예산 잠금을 기다리는 사이 기간이 끝나면 시작 시각이 유효했어도 예약하지 않는다', async () => {
    const { rows } = await harness.pool.query(`select
      (clock_timestamp() + interval '1 second')::text as ending`);
    const policy = { ...fixedPolicy, periodEnd: new Date(rows[0].ending).toISOString() };

    expect((await reserve(1n, policy)).accepted).toBe(true);
    await harness.pool.query('delete from usage_embedding_reservations');
    const blocker = await harness.pool.connect();
    let pending = Promise.resolve<PromiseSettledResult<Awaited<ReturnType<typeof reserve>>>[]>([]);

    try {
      await blocker.query('begin');
      await blocker.query('select id from usage_embedding_budgets for update');
      pending = Promise.allSettled([reserve(1n, policy)]);
      await vi.waitFor(async () => {
        const { rows: waiting } = await harness.pool.query(`select count(*)::int as count
          from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query like '%usage_embedding_budgets%'`);

        expect(waiting[0].count).toBe(1);
      });
      // 고정 sleep 대신 실제 DB 시각이 fixture 만료 경계를 넘었는지 관찰한다.
      await vi.waitFor(
        async () => {
          const { rows: clock } = await harness.pool.query(
            'select clock_timestamp() >= $1::timestamptz as expired',
            [policy.periodEnd],
          );

          expect(clock[0].expired).toBe(true);
        },
        { timeout: 2000 },
      );
    } finally {
      try {
        await blocker.query('rollback');
      } finally {
        blocker.release();
        await pending;
      }
    }

    expect(await pending).toEqual([
      { status: 'fulfilled', value: { accepted: false, reason: 'policy_conflict' } },
    ]);
    const { rows: reservations } = await harness.pool.query(
      'select id from usage_embedding_reservations',
    );

    expect(reservations).toHaveLength(0);
  });
});
