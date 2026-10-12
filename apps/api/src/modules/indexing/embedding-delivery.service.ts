import {
  CLAIM_EMBEDDING_WORK,
  EMBEDDING_CLAIM_QUEUE,
  type EmbeddingClaimJob,
  type EmbeddingClaimResult,
} from '@devfootnote/queue';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../../infrastructure/logging/logger.js';
import { EmbeddingWorkRepository } from './embedding-work.repository.js';

type ClaimQueue = Queue<EmbeddingClaimJob, EmbeddingClaimResult>;

/** 이미 commit된 work만 전달한다. 자료 저장·기동은 Redis를 기다리지 않는다. */
@Injectable()
export class EmbeddingDeliveryService implements OnApplicationShutdown {
  private connecting?: Promise<ClaimQueue>;
  private connection?: Redis;

  constructor(
    private readonly repository: EmbeddingWorkRepository,
    private readonly config: ConfigService,
  ) {}

  async deliver(ownerId: string, workId: string): Promise<boolean> {
    const redisUrl = this.config.get<string>('redisUrl');

    if (!redisUrl) {
      return false;
    }

    try {
      if (!(await this.repository.canDeliver(ownerId, workId))) {
        return false;
      }
    } catch {
      logger.warn('작업 전달 가능 여부를 DB에서 확인하지 못했습니다.');

      return false;
    }

    try {
      this.connecting ??= this.connect(redisUrl).catch(() => {
        this.connecting = undefined;

        throw new Error('큐 연결을 준비하지 못했습니다.');
      });
      const queue = await this.connecting;

      const job = await queue.add(
        CLAIM_EMBEDDING_WORK,
        { workId },
        {
          jobId: workId,
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
      const state = await job.getState();

      // 완료된 전달 메시지가 남아 있으면 같은 ID의 add는 실행을 만들지 않는다.
      // 삭제 후 재등록하지 않고 BullMQ의 상태 확인을 포함한 원자적 재전달을 사용한다.
      if (state === 'completed' || state === 'failed') {
        await job.retry(state);
      }

      return true;
    } catch {
      // 전달 실패를 저장 실패로 바꾸지 않는다. durable work는 DB에 그대로 남는다.
      logger.warn('작업 claim을 큐에 전달하지 못했습니다.');

      return false;
    }
  }

  private async connect(url: string): Promise<ClaimQueue> {
    const connection = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 2000,
    });

    connection.on('error', () => logger.warn('API Redis 연결을 확인하지 못했습니다.'));
    this.connection = connection;

    try {
      await connection.connect();
      const queue = new Queue<EmbeddingClaimJob, EmbeddingClaimResult>(EMBEDDING_CLAIM_QUEUE, {
        connection,
      });

      queue.on('error', () => logger.warn('API 큐 연결을 확인하지 못했습니다.'));

      return queue;
    } catch {
      connection.disconnect();

      throw new Error('큐 연결을 준비하지 못했습니다.');
    }
  }

  async onApplicationShutdown() {
    try {
      const queue = await this.connecting;

      await queue?.close();
    } finally {
      this.connection?.disconnect();
    }
  }
}
