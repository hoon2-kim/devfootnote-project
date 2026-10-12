import { randomUUID } from 'node:crypto';
import type { Database } from '@devfootnote/db';
import { embeddingMaxAttempts } from '@devfootnote/db/indexing-policy';
import {
  embeddingAttempts,
  embeddingActivations,
  embeddingVectors,
  embeddingWorks,
} from '@devfootnote/db/schema/indexing';
import { Inject, Injectable } from '@nestjs/common';
import {
  InjectTransactionHost,
  Propagation,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { WORKER_DATABASE } from '../../infrastructure/database/database.module.js';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import type {
  EmbeddingCallFailure,
  EmbeddingFailure,
  EmbeddingFenceFailure,
  EmbeddingWorkSnapshot,
  LockedEmbeddingWork,
} from './embedding-execution.types.js';

const activeStates = ['PENDING', 'LEASED', 'CALLING', 'RETRY_WAIT'] as const;

export type FinishTransition =
  | {
      state: 'RETRY_WAIT';
      failure: EmbeddingCallFailure | 'lease_expired';
      outcome: 'RETRYABLE_FAILED' | 'UNKNOWN';
      retryDelayMs: number;
      requireLiveLease: boolean;
    }
  | {
      state: 'FINAL_FAILED';
      failure: EmbeddingFailure;
      outcome: 'FINAL_FAILED' | 'UNKNOWN';
      requireLiveLease: boolean;
    }
  | {
      state: 'OBSOLETE';
      failure: EmbeddingFenceFailure;
      outcome: 'OBSOLETE';
      requireLiveLease: boolean;
    };

@Injectable()
export class EmbeddingWorkRepository {
  constructor(
    @Inject(WORKER_DATABASE) private readonly db: Database,
    @InjectTransactionHost('worker')
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  async reserveActivationBatch(limit = 20) {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ ownerId: embeddingActivations.ownerId })
        .from(embeddingActivations)
        .where(lte(embeddingActivations.scanAfter, sql`clock_timestamp()`))
        .orderBy(embeddingActivations.scanAfter, embeddingActivations.ownerId)
        .limit(limit)
        .for('update', { skipLocked: true });

      if (rows.length) {
        await tx
          .update(embeddingActivations)
          .set({ scanAfter: sql`clock_timestamp() + interval '15 seconds'` })
          .where(
            inArray(
              embeddingActivations.ownerId,
              rows.map((row) => row.ownerId),
            ),
          );
      }

      return rows.map((row) => row.ownerId);
    });
  }

  @Transactional('worker', Propagation.Mandatory)
  async activation(ownerId: string) {
    const [row] = await this.transactions.tx
      .select({
        activation: embeddingActivations,
        enabledAt: sql<string>`${embeddingActivations.enabledAt}::text`,
      })
      .from(embeddingActivations)
      .where(eq(embeddingActivations.ownerId, ownerId));

    // JS Date의 밀리초 반올림으로 활성화 직전 자료까지 포함하지 않도록 DB 정밀도를 보존한다.
    return row ? { ...row.activation, enabledAt: row.enabledAt } : null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async advanceActivation(ownerId: string, intentCursor: string | null) {
    await this.transactions.tx
      .update(embeddingActivations)
      .set({ intentCursor })
      .where(eq(embeddingActivations.ownerId, ownerId));
  }

  @Transactional('worker', Propagation.Mandatory)
  async existingIntents(
    ownerId: string,
    intentIds: string[],
    configFingerprint: string,
    consentEpoch: number,
  ) {
    if (!intentIds.length) {
      return new Set<string>();
    }

    const rows = await this.transactions.tx
      .select({ intentId: embeddingWorks.intentId })
      .from(embeddingWorks)
      .where(
        and(
          eq(embeddingWorks.ownerId, ownerId),
          inArray(embeddingWorks.intentId, intentIds),
          eq(embeddingWorks.configFingerprint, configFingerprint),
          eq(embeddingWorks.consentEpoch, consentEpoch),
        ),
      );

    // 최종 실패·폐기된 generation도 자동 재생성하지 않는다. 재시도는 사용자 command만 허용한다.
    return new Set(rows.map((row) => row.intentId));
  }

  @Transactional('worker', Propagation.Mandatory)
  async createMissingWorks(
    ownerId: string,
    activationId: string,
    intentIds: string[],
    configFingerprint: string,
    consentEpoch: number,
    reservationId: string,
  ) {
    await this.transactions.tx.insert(embeddingWorks).values(
      intentIds.map((intentId) => ({
        id: randomUUID(),
        ownerId,
        intentId,
        configFingerprint,
        consentEpoch,
        reservationId,
        activationId,
        generation: 1,
      })),
    );
  }

  async reserveVectorCleanup(limit = 100) {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          workId: embeddingVectors.workId,
          chunkId: embeddingVectors.chunkId,
          ownerId: embeddingVectors.ownerId,
          materialId: embeddingVectors.materialId,
          configFingerprint: embeddingWorks.configFingerprint,
          consentEpoch: embeddingWorks.consentEpoch,
        })
        .from(embeddingVectors)
        .innerJoin(embeddingWorks, eq(embeddingWorks.id, embeddingVectors.workId))
        .where(lte(embeddingVectors.cleanupAfter, sql`clock_timestamp()`))
        .orderBy(embeddingVectors.cleanupAfter, embeddingVectors.workId, embeddingVectors.chunkId)
        .limit(limit)
        .for('update', { of: embeddingVectors, skipLocked: true });

      // 검증 대상 선점만 commit한다. 이후 동의→자료→vector 순서의 짧은 transaction에서 삭제한다.
      for (const row of rows) {
        await tx
          .update(embeddingVectors)
          .set({ cleanupAfter: sql`clock_timestamp() + interval '15 seconds'` })
          .where(
            and(eq(embeddingVectors.workId, row.workId), eq(embeddingVectors.chunkId, row.chunkId)),
          );
      }

      return rows;
    });
  }

  @Transactional('worker', Propagation.Mandatory)
  async deleteVector(workId: string, chunkId: string) {
    await this.transactions.tx
      .delete(embeddingVectors)
      .where(and(eq(embeddingVectors.workId, workId), eq(embeddingVectors.chunkId, chunkId)));
  }

  @Transactional('worker', Propagation.Mandatory)
  async detachExpiredAudit(ownerId: string, reservationId: string): Promise<boolean> {
    const tx = this.transactions.tx;
    const works = await tx
      .select({
        id: embeddingWorks.id,
        expired: sql<boolean>`${embeddingWorks.state} in ('PUBLISHED','FINAL_FAILED','OBSOLETE')
        and ${embeddingWorks.terminalAt} <= clock_timestamp() - interval '90 days'`,
      })
      .from(embeddingWorks)
      .where(
        and(eq(embeddingWorks.ownerId, ownerId), eq(embeddingWorks.reservationId, reservationId)),
      )
      .orderBy(embeddingWorks.id)
      .for('update');

    if (works.some((work) => !work.expired)) {
      return false;
    }

    if (works.length) {
      const ids = works.map((work) => work.id);
      const [recent] = await tx
        .select({ id: embeddingAttempts.id })
        .from(embeddingAttempts)
        .where(
          and(
            inArray(embeddingAttempts.workId, ids),
            sql`(${embeddingAttempts.finishedAt} is null or ${embeddingAttempts.finishedAt} > clock_timestamp() - interval '90 days')`,
          ),
        )
        .limit(1);

      if (recent) {
        return false;
      }

      await tx.delete(embeddingAttempts).where(inArray(embeddingAttempts.workId, ids));
      // terminal identity와 generation은 남긴다. 상세 정리로 자동 재호출이 가능해져서는 안 된다.
      await tx
        .update(embeddingWorks)
        .set({ reservationId: null })
        .where(inArray(embeddingWorks.id, ids));
    }

    return true;
  }

  async claim(workId: string) {
    return (await this.claimLease(workId)) !== null;
  }

  async claimLease(workId: string) {
    // 큐 중복 전달은 이 CAS에서 걸러낸다. 외부 실행 시도 수는 claim이 아닌 STARTED에서 증가한다.
    const [claimed] = await this.db
      .update(embeddingWorks)
      .set({
        state: 'LEASED',
        leaseToken: randomUUID(),
        leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
      })
      .where(
        and(
          eq(embeddingWorks.id, workId),
          eq(embeddingWorks.state, 'PENDING'),
          lte(embeddingWorks.nextAttemptAt, sql`clock_timestamp()`),
        ),
      )
      .returning({ token: embeddingWorks.leaseToken });

    return claimed?.token ?? null;
  }

  async snapshot(workId: string): Promise<EmbeddingWorkSnapshot | null> {
    const [work] = await this.db.select().from(embeddingWorks).where(eq(embeddingWorks.id, workId));

    return work ?? null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async lock(workId: string): Promise<LockedEmbeddingWork | null> {
    const [locked] = await this.transactions.tx
      .select({ id: embeddingWorks.id })
      .from(embeddingWorks)
      .where(eq(embeddingWorks.id, workId))
      .for('update');

    if (!locked) {
      return null;
    }

    // lock 대기 이전에 평가한 만료 여부를 쓰지 않고, 점유한 뒤 DB 현재 시각으로 다시 읽는다.
    const [work] = await this.transactions.tx
      .select({
        work: embeddingWorks,
        leaseActive: sql<boolean>`coalesce(${embeddingWorks.leaseExpiresAt} > clock_timestamp(), false)`,
        due: sql<boolean>`${embeddingWorks.nextAttemptAt} <= clock_timestamp()`,
      })
      .from(embeddingWorks)
      .where(eq(embeddingWorks.id, workId));

    return work ? { ...work.work, leaseActive: work.leaseActive, due: work.due } : null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async start(work: LockedEmbeddingWork, leaseToken: string) {
    const [started] = await this.transactions.tx
      .update(embeddingWorks)
      .set({ state: 'CALLING', attemptCount: sql`${embeddingWorks.attemptCount} + 1` })
      .where(
        and(
          eq(embeddingWorks.id, work.id),
          eq(embeddingWorks.state, 'LEASED'),
          eq(embeddingWorks.leaseToken, leaseToken),
          gt(embeddingWorks.leaseExpiresAt, sql`clock_timestamp()`),
          sql`${embeddingWorks.attemptCount} < ${embeddingMaxAttempts}`,
        ),
      )
      .returning({ number: embeddingWorks.attemptCount });

    if (!started) {
      return null;
    }

    const attemptId = randomUUID();

    await this.transactions.tx.insert(embeddingAttempts).values({
      id: attemptId,
      ownerId: work.ownerId,
      workId: work.id,
      number: started.number,
      leaseToken,
      outcome: 'STARTED',
    });

    return { attemptId, number: started.number };
  }

  @Transactional('worker', Propagation.Mandatory)
  async hasActiveAttempt(workId: string, leaseToken: string, attemptId: string) {
    const [attempt] = await this.transactions.tx
      .select({ id: embeddingAttempts.id })
      .from(embeddingAttempts)
      .where(
        and(
          eq(embeddingAttempts.id, attemptId),
          eq(embeddingAttempts.workId, workId),
          eq(embeddingAttempts.leaseToken, leaseToken),
          eq(embeddingAttempts.outcome, 'STARTED'),
        ),
      );

    return attempt !== undefined;
  }

  @Transactional('worker', Propagation.Mandatory)
  async reusableVector(work: LockedEmbeddingWork, chunkIds: string[]) {
    if (!chunkIds.length) {
      return null;
    }

    const [row] = await this.transactions.tx
      .select({ values: embeddingVectors.embedding })
      .from(embeddingVectors)
      .innerJoin(
        embeddingWorks,
        and(
          eq(embeddingWorks.id, embeddingVectors.workId),
          eq(embeddingWorks.ownerId, embeddingVectors.ownerId),
        ),
      )
      .where(
        and(
          eq(embeddingVectors.ownerId, work.ownerId),
          inArray(embeddingVectors.chunkId, chunkIds),
          eq(embeddingWorks.state, 'PUBLISHED'),
          eq(embeddingWorks.configFingerprint, work.configFingerprint),
          eq(embeddingWorks.consentEpoch, work.consentEpoch),
        ),
      )
      .orderBy(desc(embeddingVectors.publishedAt), desc(embeddingVectors.workId))
      .limit(1);

    return row?.values ?? null;
  }

  @Transactional('worker', Propagation.Mandatory)
  async publishReused(
    work: LockedEmbeddingWork,
    materialId: string,
    revisionId: string,
    vectors: { chunkId: string; values: number[] }[],
  ) {
    const tx = this.transactions.tx;
    const [changed] = await tx
      .update(embeddingWorks)
      .set({
        state: 'PUBLISHED',
        terminalAt: sql`clock_timestamp()`,
        leaseToken: null,
        leaseExpiresAt: null,
        lastFailure: null,
      })
      .where(
        and(
          eq(embeddingWorks.id, work.id),
          eq(embeddingWorks.ownerId, work.ownerId),
          eq(embeddingWorks.state, 'LEASED'),
          eq(embeddingWorks.leaseToken, work.leaseToken ?? ''),
          gt(embeddingWorks.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: embeddingWorks.id });

    if (!changed) {
      return false;
    }

    await tx.insert(embeddingVectors).values(
      vectors.map((vector) => ({
        ownerId: work.ownerId,
        workId: work.id,
        materialId,
        revisionId,
        chunkId: vector.chunkId,
        embedding: vector.values,
      })),
    );

    return true;
  }

  @Transactional('worker', Propagation.Mandatory)
  async publish(
    work: LockedEmbeddingWork,
    attemptId: string,
    materialId: string,
    revisionId: string,
    vectors: readonly { chunkId: string; values: number[] }[],
  ) {
    const tx = this.transactions.tx;
    const [published] = await tx
      .update(embeddingWorks)
      .set({
        state: 'PUBLISHED',
        terminalAt: sql`clock_timestamp()`,
        lastFailure: null,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(embeddingWorks.id, work.id),
          eq(embeddingWorks.ownerId, work.ownerId),
          eq(embeddingWorks.state, 'CALLING'),
          work.leaseToken ? eq(embeddingWorks.leaseToken, work.leaseToken) : sql`false`,
          gt(embeddingWorks.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: embeddingWorks.id });

    if (!published) {
      return false;
    }

    await tx.insert(embeddingVectors).values(
      vectors.map(({ chunkId, values }) => ({
        ownerId: work.ownerId,
        workId: work.id,
        materialId,
        revisionId,
        chunkId,
        embedding: values,
      })),
    );
    const finished = await tx
      .update(embeddingAttempts)
      .set({
        outcome: 'SUCCEEDED',
        failure: null,
        finishedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(embeddingAttempts.id, attemptId),
          eq(embeddingAttempts.workId, work.id),
          eq(embeddingAttempts.outcome, 'STARTED'),
        ),
      )
      .returning({ id: embeddingAttempts.id });

    if (finished.length !== 1) {
      throw new Error('임베딩 게시 시도 상태가 변경되었습니다.');
    }

    return true;
  }

  @Transactional('worker', Propagation.Mandatory)
  async completedReservationAttempts(
    ownerId: string,
    reservationId: string,
  ): Promise<string[] | null> {
    const tx = this.transactions.tx;
    const works = await tx
      .select({ id: embeddingWorks.id, state: embeddingWorks.state })
      .from(embeddingWorks)
      .where(
        and(eq(embeddingWorks.ownerId, ownerId), eq(embeddingWorks.reservationId, reservationId)),
      );

    if (
      !works.length ||
      works.some(({ state }) => activeStates.some((active) => active === state))
    ) {
      return null;
    }

    const attempts = await tx
      .select({ id: embeddingAttempts.id })
      .from(embeddingAttempts)
      .where(
        and(
          eq(embeddingAttempts.ownerId, ownerId),
          inArray(
            embeddingAttempts.workId,
            works.map(({ id }) => id),
          ),
        ),
      );

    return attempts.map(({ id }) => id);
  }

  @Transactional('worker', Propagation.Mandatory)
  async finish(work: LockedEmbeddingWork, transition: FinishTransition) {
    const [finished] = await this.transactions.tx
      .update(embeddingWorks)
      .set({
        state: transition.state,
        terminalAt: transition.state === 'RETRY_WAIT' ? null : sql`clock_timestamp()`,
        lastFailure: transition.failure,
        leaseToken: null,
        leaseExpiresAt: null,
        ...(transition.state === 'RETRY_WAIT'
          ? {
              nextAttemptAt: sql`clock_timestamp() + ${transition.retryDelayMs} * interval '1 millisecond'`,
            }
          : {}),
      })
      .where(
        and(
          eq(embeddingWorks.id, work.id),
          eq(embeddingWorks.state, work.state),
          transition.requireLiveLease
            ? gt(embeddingWorks.leaseExpiresAt, sql`clock_timestamp()`)
            : undefined,
        ),
      )
      .returning({ id: embeddingWorks.id });

    if (!finished) {
      return false;
    }

    if (work.state === 'CALLING' && work.leaseToken) {
      await this.transactions.tx
        .update(embeddingAttempts)
        .set({
          outcome: transition.outcome,
          failure: transition.failure,
          finishedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(embeddingAttempts.workId, work.id),
            eq(embeddingAttempts.leaseToken, work.leaseToken),
            eq(embeddingAttempts.outcome, 'STARTED'),
          ),
        );
    }

    return true;
  }

  @Transactional('worker', Propagation.Mandatory)
  async returnToPending(work: LockedEmbeddingWork) {
    const [updated] = await this.transactions.tx
      .update(embeddingWorks)
      .set({ state: 'PENDING', leaseToken: null, leaseExpiresAt: null })
      .where(
        and(
          eq(embeddingWorks.id, work.id),
          eq(embeddingWorks.state, work.state),
          work.state === 'LEASED'
            ? lte(embeddingWorks.leaseExpiresAt, sql`clock_timestamp()`)
            : lte(embeddingWorks.nextAttemptAt, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: embeddingWorks.id });

    return updated !== undefined;
  }

  async heartbeat(workId: string, leaseToken: string) {
    return this.db.transaction(async (tx) => {
      // UPDATE가 잠금을 기다리기 전에 만료 조건을 평가할 수 있어, 먼저 행을 점유한다.
      const [work] = await tx
        .select({ id: embeddingWorks.id })
        .from(embeddingWorks)
        .where(and(eq(embeddingWorks.id, workId), eq(embeddingWorks.leaseToken, leaseToken)))
        .for('update');

      if (!work) {
        return false;
      }

      const [extended] = await tx
        .update(embeddingWorks)
        .set({ leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'` })
        .where(
          and(
            eq(embeddingWorks.id, workId),
            eq(embeddingWorks.leaseToken, leaseToken),
            inArray(embeddingWorks.state, ['LEASED', 'CALLING']),
            gt(embeddingWorks.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: embeddingWorks.id });

      return extended !== undefined;
    });
  }

  async reserveRepairBatch(limit = 20): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: embeddingWorks.id })
        .from(embeddingWorks)
        .where(
          and(
            inArray(embeddingWorks.state, activeStates),
            lte(embeddingWorks.deliveryAfter, sql`clock_timestamp()`),
          ),
        )
        .orderBy(asc(embeddingWorks.deliveryAfter), asc(embeddingWorks.id))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (!rows.length) {
        return [];
      }

      const ids = rows.map((row) => row.id);

      await tx
        .update(embeddingWorks)
        .set({ deliveryAfter: sql`clock_timestamp() + interval '15 seconds'` })
        .where(inArray(embeddingWorks.id, ids));

      return ids;
    });
  }
}
