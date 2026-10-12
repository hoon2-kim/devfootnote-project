import {
  CLAIM_EMBEDDING_WORK,
  EMBEDDING_CLAIM_QUEUE,
  type EmbeddingClaimJob,
  type EmbeddingClaimResult,
} from '@devfootnote/queue';
import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../../infrastructure/logging/logger.js';
import { WorkerUsageService } from '../usage-retention/index.js';
import { EmbeddingExecutionService } from './embedding-execution.service.js';
import type { EmbeddingRecoveryResult } from './embedding-execution.types.js';
import { EmbeddingWorkRepository } from './embedding-work.repository.js';
import { EmbeddingLifecycleService } from './embedding-lifecycle.service.js';

type ClaimQueue = Queue<EmbeddingClaimJob, EmbeddingClaimResult>;

@Injectable()
export class EmbeddingRepairService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  private connecting?: Promise<ClaimQueue>;
  private connection?: Redis;

  constructor(
    private readonly repository: EmbeddingWorkRepository,
    private readonly execution: EmbeddingExecutionService,
    private readonly usage: WorkerUsageService,
    private readonly config: ConfigService,
    private readonly lifecycle: EmbeddingLifecycleService,
  ) {}

  onApplicationBootstrap() {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), 15000);
  }

  async runOnce(): Promise<void> {
    if (this.stopping) {
      return;
    }

    // 한 프로세스의 회차는 겹치지 않는다. 여러 프로세스 사이의 선점은 PG가 판정한다.
    if (this.running) {
      return this.running;
    }

    this.running = this.repair().catch(() => {
      logger.warn('임베딩 작업 복구를 완료하지 못했습니다.');
    });

    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async repair() {
    await this.usage.expireUnexposed(20);
    await this.usage.settleExpiredQueries(20);
    await this.lifecycle.cleanVectors();
    await this.lifecycle.cleanAudit();

    // 키를 제거해도 보존·철회 정리는 계속한다. 새 실행과 전달만 승인 설정으로 차단한다.
    if (this.stopping || !this.config.get<string | null>('embeddingConfigFingerprint')) {
      return;
    }

    await this.lifecycle.activateMissing();

    const workIds = await this.repository.reserveRepairBatch(20);

    for (const workId of workIds) {
      if (this.stopping) {
        return;
      }

      let result: EmbeddingRecoveryResult;

      try {
        result = await this.execution.recover(workId);
      } catch {
        // 한 항목의 잠금 충돌이나 저장 실패로 뒤의 정상 작업까지 막지 않는다.
        logger.warn('개별 임베딩 작업을 복구하지 못했습니다.');

        continue;
      }

      if (result === 'pending' && !this.stopping && !(await this.deliver(workId))) {
        // Redis 장애 때 나머지 항목마다 같은 timeout을 반복하지 않는다.
        // DB에 선점한 회차가 만료되면 다음 scanner가 계속한다.
        return;
      }
    }
  }

  private async deliver(workId: string): Promise<boolean> {
    try {
      this.connecting ??= this.connect().catch(() => {
        this.connecting = undefined;

        throw new Error('복구 큐 연결을 준비하지 못했습니다.');
      });
      const queue = await this.connecting;
      const job = await queue.add(
        CLAIM_EMBEDDING_WORK,
        { workId },
        { jobId: workId, removeOnComplete: 1000, removeOnFail: 1000 },
      );
      const state = await job.getState();

      // 활성 작업은 건드리지 않는다. terminal 전달 메시지만 원자적으로 재대기열화한다.
      if (state === 'completed' || state === 'failed') {
        await job.retry(state);
      }

      return true;
    } catch {
      logger.warn('복구한 작업 claim을 큐에 전달하지 못했습니다.');

      return false;
    }
  }

  private async connect(): Promise<ClaimQueue> {
    // consumer의 무한 재연결 연결과 분리해 repair의 Redis 대기를 제한한다.
    const connection = new Redis(this.config.getOrThrow<string>('redisUrl'), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 2000,
    });

    connection.on('error', () => logger.warn('복구 Redis 연결을 확인하지 못했습니다.'));
    this.connection = connection;

    try {
      await connection.connect();
      const queue = new Queue<EmbeddingClaimJob, EmbeddingClaimResult>(EMBEDDING_CLAIM_QUEUE, {
        connection,
      });

      queue.on('error', () => logger.warn('복구 큐 연결을 확인하지 못했습니다.'));

      return queue;
    } catch {
      connection.disconnect();

      throw new Error('복구 큐 연결을 준비하지 못했습니다.');
    }
  }

  async beforeApplicationShutdown() {
    this.stopping = true;

    if (this.timer) {
      clearInterval(this.timer);
    }

    // 진행 중 Redis 명령을 풀고, 현재 DB 복구 transaction이 끝난 뒤 Pool을 닫는다.
    this.connection?.disconnect();

    try {
      await this.running;
      const queue = await this.connecting;

      await queue?.close();
    } catch {
      logger.warn('복구 큐 종료 중 연결을 확인하지 못했습니다.');
    }
  }
}
