import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { geminiEmbeddingBatchLimit, geminiEmbeddingDimensions } from '@devfootnote/ai';
import {
  InjectTransactionHost,
  Propagation,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import { logger } from '../../infrastructure/logging/logger.js';
import { MaterialsService, type CurrentEmbeddingIntent } from '../materials/index.js';
import { WorkerUsageService } from '../usage-retention/index.js';
import {
  embeddingFailureDecision,
  embeddingFenceFailure,
  embeddingRetryDelay,
  holdsLease,
  isTerminalWork,
} from './embedding-execution.policy.js';
import type {
  EmbeddingCallFailure,
  EmbeddingFailureResult,
  EmbeddingFenceFailure,
  EmbeddingRecoveryResult,
  LockedEmbeddingWork,
} from './embedding-execution.types.js';
import { EmbeddingWorkRepository, type FinishTransition } from './embedding-work.repository.js';

// 예약 만료와 시작 CAS 사이에서 실패하면 exposure·attempt·work 전체를 되돌린다.
class AttemptStartRejected extends Error {}

@Injectable()
export class EmbeddingExecutionService {
  constructor(
    @InjectTransactionHost('worker') private readonly transactions: TransactionHost,
    private readonly config: ConfigService,
    private readonly materials: MaterialsService,
    private readonly usage: WorkerUsageService,
    private readonly repository: EmbeddingWorkRepository,
  ) {}

  // 외부 호출자는 STARTED commit 이후에만 provider를 호출할 수 있다.
  // STARTED는 호출 가능성의 기록이다. 실제 HTTP는 이 transaction이 끝난 뒤 실행한다.
  @Transactional('worker', Propagation.Never)
  async startAttempt(
    workId: string,
    leaseToken: string,
  ): Promise<{ attemptId: string; number: number } | null> {
    try {
      const result = await this.withFencedWork(workId, async (work, fenceFailure) => {
        if (!holdsLease(work, leaseToken, 'LEASED')) {
          return null;
        }

        if (fenceFailure) {
          await this.rejectFence(work, fenceFailure, { requireLiveLease: true });

          return null;
        }

        const attempt = await this.repository.start(work, leaseToken);

        if (!attempt) {
          return null;
        }

        if (
          !work.reservationId ||
          !(await this.usage.markExposure(work.ownerId, work.reservationId))
        ) {
          throw new AttemptStartRejected();
        }

        return attempt;
      });

      return result ?? null;
    } catch (error) {
      if (error instanceof AttemptStartRejected) {
        return null;
      }

      logger.error('임베딩 실행 시작 저장 오류');

      throw new Error('임베딩 실행 시작에 실패했습니다.');
    }
  }

  @Transactional('worker', Propagation.Never)
  async reuse(workId: string, leaseToken: string): Promise<boolean> {
    try {
      const result = await this.withFencedWork(workId, async (work, failure, current) => {
        if (!holdsLease(work, leaseToken, 'LEASED') || failure || !current) {
          return false;
        }

        const chunks = await this.materials.chunks(
          work.ownerId,
          current.materialId,
          current.revisionId,
        );
        const vectors: { chunkId: string; values: number[] }[] = [];

        for (const chunk of chunks) {
          // 같은 자료의 보존된 revision만 사용한다. target material 잠금이 삭제·수정과 경쟁한다.
          const candidates = await this.materials.reusableChunks(
            work.ownerId,
            current.materialId,
            current.revisionId,
            chunk.text,
          );
          const values = await this.repository.reusableVector(
            work,
            candidates.map((candidate) => candidate.id),
          );

          if (!values) {
            return false;
          }

          vectors.push({ chunkId: chunk.id, values });
        }

        return (
          vectors.length > 0 &&
          this.repository.publishReused(work, current.materialId, current.revisionId, vectors)
        );
      });

      return result ?? false;
    } catch {
      throw new Error('임베딩 결과 재사용에 실패했습니다.');
    }
  }

  @Transactional('worker', Propagation.Never)
  async callInput(workId: string, leaseToken: string, attemptId: string) {
    try {
      return await this.withFencedWork(workId, async (work, failure, current) => {
        if (
          !holdsLease(work, leaseToken, 'CALLING') ||
          !(await this.repository.hasActiveAttempt(work.id, leaseToken, attemptId))
        ) {
          return null;
        }

        if (failure) {
          await this.rejectFence(work, failure, { requireLiveLease: true });

          return null;
        }

        if (!current) {
          return null;
        }

        return {
          configFingerprint: work.configFingerprint,
          chunks: await this.materials.chunks(work.ownerId, current.materialId, current.revisionId),
        };
      });
    } catch {
      throw new Error('임베딩 입력을 준비하지 못했습니다.');
    }
  }

  @Transactional('worker', Propagation.Never)
  async failAttempt(
    workId: string,
    leaseToken: string,
    attemptId: string,
    failure: EmbeddingCallFailure,
    { retryable = true }: { retryable?: boolean } = {},
  ): Promise<EmbeddingFailureResult> {
    try {
      const result = await this.withFencedWork(workId, async (work, fenceFailure) => {
        if (
          !holdsLease(work, leaseToken, 'CALLING') ||
          !(await this.repository.hasActiveAttempt(work.id, leaseToken, attemptId))
        ) {
          return 'ignored';
        }

        if (fenceFailure) {
          return this.rejectFence(work, fenceFailure, { requireLiveLease: true });
        }

        return this.failCurrentAttempt(work, failure, { requireLiveLease: true, retryable });
      });

      return result ?? 'ignored';
    } catch {
      logger.error('임베딩 실행 실패 저장 오류');

      throw new Error('임베딩 실행 결과 저장에 실패했습니다.');
    }
  }

  @Transactional('worker', Propagation.Never)
  async completeAttempt(
    workId: string,
    leaseToken: string,
    attemptId: string,
    result: {
      configFingerprint: string;
      vectors: readonly { chunkId: string; values: number[] }[];
      tokens: number | null;
    },
  ): Promise<'published' | 'obsolete' | 'final_failed' | 'ignored'> {
    try {
      const completed = await this.withFencedWork(workId, async (work, failure, current) => {
        if (
          !holdsLease(work, leaseToken, 'CALLING') ||
          result.configFingerprint !== work.configFingerprint ||
          !(await this.repository.hasActiveAttempt(work.id, leaseToken, attemptId))
        ) {
          return 'ignored';
        }

        const validUsage =
          result.tokens === null ||
          (Number.isSafeInteger(result.tokens) &&
            result.tokens > 0 &&
            result.tokens <= geminiEmbeddingBatchLimit * 8192);

        if (work.reservationId && validUsage) {
          // 게시 조건과 별개로 usage가 예약 당시 가격에 따라 정산한다.
          await this.usage.recordCall(work.ownerId, work.reservationId, attemptId, result.tokens);
        }

        // 게시를 거부해도 이미 수신한 usage는 별도로 보존하고 공유 예약 종료 시 정산한다.
        if (failure) {
          return this.rejectFence(work, failure, { requireLiveLease: true });
        }

        if (!current) {
          throw new Error('게시할 현재 자료가 없습니다.');
        }

        const chunks = await this.materials.chunks(
          work.ownerId,
          current.materialId,
          current.revisionId,
        );
        const validVectors =
          result.vectors.length === chunks.length &&
          chunks.length > 0 &&
          result.vectors.every(
            (vector, index) =>
              vector.chunkId === chunks[index]?.id &&
              vector.values.length === geminiEmbeddingDimensions &&
              vector.values.every((value) => Number.isFinite(Math.fround(value))) &&
              vector.values.some((value) => Math.fround(value) !== 0),
          );

        if (!validUsage || !validVectors) {
          const failed = await this.failCurrentAttempt(work, 'invalid_response', {
            requireLiveLease: true,
            retryable: false,
          });

          return failed === 'ignored' ? 'ignored' : 'final_failed';
        }

        return (await this.repository.publish(
          work,
          attemptId,
          current.materialId,
          current.revisionId,
          result.vectors,
        ))
          ? 'published'
          : 'ignored';
      });

      return completed ?? 'ignored';
    } catch {
      logger.error('임베딩 게시·정산 저장 오류');

      throw new Error('임베딩 게시·정산에 실패했습니다.');
    }
  }

  @Transactional('worker', Propagation.Never)
  async heartbeat(workId: string, leaseToken: string): Promise<boolean> {
    try {
      return await this.repository.heartbeat(workId, leaseToken);
    } catch {
      logger.error('임베딩 lease 갱신 저장 오류');

      throw new Error('임베딩 작업 점유 갱신에 실패했습니다.');
    }
  }

  @Transactional('worker', Propagation.Never)
  async recover(workId: string): Promise<EmbeddingRecoveryResult> {
    try {
      const result = await this.withFencedWork(workId, async (work, fenceFailure) => {
        if (fenceFailure) {
          return this.rejectFence(work, fenceFailure, { requireLiveLease: false });
        }

        if (work.state === 'PENDING') {
          return work.due ? 'pending' : 'waiting';
        }

        if (work.state === 'RETRY_WAIT') {
          if (!work.due) {
            return 'waiting';
          }

          return (await this.repository.returnToPending(work)) ? 'pending' : 'ignored';
        }

        if (work.leaseActive) {
          return 'waiting';
        }

        if (work.state === 'LEASED') {
          return (await this.repository.returnToPending(work)) ? 'pending' : 'ignored';
        }

        // STARTED 이후 crash는 provider 수신 여부를 알 수 없다. 예약 노출을 지우지 않는다.
        const result = await this.failCurrentAttempt(work, 'lease_expired', {
          requireLiveLease: false,
          retryable: true,
        });

        return result === 'retry_wait' ? 'waiting' : result;
      });

      return result ?? 'ignored';
    } catch {
      logger.error('임베딩 작업 복구 저장 오류');

      throw new Error('임베딩 작업 복구에 실패했습니다.');
    }
  }

  private async withFencedWork<T>(
    workId: string,
    action: (
      work: LockedEmbeddingWork,
      failure: EmbeddingFenceFailure | null,
      current: CurrentEmbeddingIntent | null,
    ) => Promise<T>,
  ): Promise<T | undefined> {
    const configuration = this.config.get<string | null>('embeddingConfigFingerprint');

    if (!configuration) {
      return undefined;
    }

    const snapshot = await this.repository.snapshot(workId);

    if (!snapshot || isTerminalWork(snapshot.state)) {
      return undefined;
    }

    return this.transactions.withTransaction(async () => {
      // 활성화와 같은 잠금 방향이다. work를 먼저 잠근 채 다른 기능의 행을 기다리지 않는다.
      const consent = await this.usage.lockConsent(snapshot.ownerId);
      const current = await this.materials.lockCurrentIntent(snapshot.ownerId, snapshot.intentId);
      const reservation = snapshot.reservationId
        ? await this.usage.lockReservation(snapshot.ownerId, snapshot.reservationId)
        : null;
      const work = await this.repository.lock(workId);

      if (!work || isTerminalWork(work.state)) {
        return undefined;
      }

      if (
        work.ownerId !== snapshot.ownerId ||
        work.intentId !== snapshot.intentId ||
        work.configFingerprint !== snapshot.configFingerprint ||
        work.consentEpoch !== snapshot.consentEpoch ||
        work.reservationId !== snapshot.reservationId
      ) {
        throw new Error('임베딩 작업 식별자가 변경되었습니다.');
      }

      const result = await action(
        work,
        embeddingFenceFailure({
          configuration,
          work,
          consent,
          hasCurrentIntent: Boolean(current),
          reservation,
        }),
        current,
      );

      // 여러 자료가 같은 예약을 공유한다. 모두 terminal일 때만 전체 attempt의 비용을 한 번 닫는다.
      if (work.reservationId && reservation?.state === 'reserved') {
        const attempts = await this.repository.completedReservationAttempts(
          work.ownerId,
          work.reservationId,
        );

        if (attempts !== null) {
          await this.usage.settle(work.ownerId, work.reservationId, attempts);
        }
      }

      return result;
    });
  }

  private async rejectFence(
    work: LockedEmbeddingWork,
    failure: EmbeddingFenceFailure,
    { requireLiveLease }: { requireLiveLease: boolean },
  ): Promise<'obsolete' | 'final_failed' | 'ignored'> {
    const transition: FinishTransition =
      failure === 'reservation_missing' || failure === 'reservation_expired'
        ? { state: 'FINAL_FAILED', failure, outcome: 'FINAL_FAILED', requireLiveLease }
        : { state: 'OBSOLETE', failure, outcome: 'OBSOLETE', requireLiveLease };
    const changed = await this.repository.finish(work, transition);

    if (!changed) {
      return 'ignored';
    }

    return transition.state === 'OBSOLETE' ? 'obsolete' : 'final_failed';
  }

  private async failCurrentAttempt(
    work: LockedEmbeddingWork,
    failure: EmbeddingCallFailure | 'lease_expired',
    { requireLiveLease, retryable }: { requireLiveLease: boolean; retryable: boolean },
  ): Promise<EmbeddingFailureResult> {
    const decision = embeddingFailureDecision({
      attemptCount: work.attemptCount,
      failure,
      retryable,
    });
    const transition: FinishTransition =
      decision.state === 'FINAL_FAILED'
        ? {
            ...decision,
            failure,
            requireLiveLease,
          }
        : {
            ...decision,
            failure,
            retryDelayMs: embeddingRetryDelay(work.attemptCount),
            requireLiveLease,
          };
    const changed = await this.repository.finish(work, transition);

    if (!changed) {
      return 'ignored';
    }

    return decision.state === 'FINAL_FAILED' ? 'final_failed' : 'retry_wait';
  }
}
