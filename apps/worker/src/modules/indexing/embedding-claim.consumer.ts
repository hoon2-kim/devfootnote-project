import {
  CLAIM_EMBEDDING_WORK,
  EMBEDDING_CLAIM_QUEUE,
  type EmbeddingClaimJob,
  type EmbeddingClaimResult,
} from '@devfootnote/queue';
import {
  Injectable,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { logger } from '../../infrastructure/logging/logger.js';
import { EmbeddingWorkRepository } from './embedding-work.repository.js';
import { EmbeddingProcessorService } from './embedding-processor.service.js';

const payloadSchema = z.strictObject({ workId: z.uuid() });

@Injectable()
export class EmbeddingClaimConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private worker?: Worker<EmbeddingClaimJob, EmbeddingClaimResult>;
  private connection?: Redis;
  private readonly stopping = new AbortController();

  constructor(
    private readonly repository: EmbeddingWorkRepository,
    private readonly config: ConfigService,
    private readonly processor: EmbeddingProcessorService,
  ) {}

  onApplicationBootstrap() {
    const connection = new Redis(this.config.getOrThrow<string>('redisUrl'), {
      maxRetriesPerRequest: null,
      connectTimeout: 2000,
    });
    const retryStrategy = connection.options.retryStrategy;

    // 소켓이 없는 재연결 대기 중 disconnect만 하면 end 이벤트가 오지 않을 수 있다.
    // 종료 시 다음 연결 실패가 end로 끝나게 하며, 평소에는 ioredis 기본 정책을 유지한다.
    // BullMQ의 전용 blocking 연결도 duplicate 시 이 정책을 이어받는다.
    connection.options.retryStrategy = (attempts) =>
      this.stopping.signal.aborted ? null : retryStrategy?.(attempts);

    connection.on('error', () => logger.warn('Worker Redis 연결을 확인하지 못했습니다.'));
    this.connection = connection;
    this.worker = new Worker<EmbeddingClaimJob, EmbeddingClaimResult>(
      EMBEDDING_CLAIM_QUEUE,
      async (job) => {
        const payload = payloadSchema.safeParse(job.data);

        if (job.name !== CLAIM_EMBEDDING_WORK || !payload.success) {
          throw new UnrecoverableError('지원하지 않는 claim 메시지입니다.');
        }

        try {
          const token = await this.repository.claimLease(payload.data.workId);

          if (token && this.config.get<string | null>('embeddingConfigFingerprint')) {
            await this.processor.process(payload.data.workId, token, this.stopping.signal);
          }

          // 완료는 DB 전이 이후다. 성공 게시 여부는 Redis 결과가 아니라 PostgreSQL에서 읽는다.
          return token ? 'claimed' : 'not-claimable';
        } catch {
          // BullMQ failedReason/stacktrace에도 SQL·DB parameter가 저장되지 않게 경계에서 정제한다.
          throw new Error('작업 claim을 저장하지 못했습니다.');
        }
      },
      { connection, concurrency: 2 },
    );
    this.worker.on('error', () => logger.warn('Worker 큐 연결을 확인하지 못했습니다.'));
    this.worker.on('failed', () => logger.warn('작업 claim 전달에 실패했습니다.'));
  }

  async beforeApplicationShutdown() {
    this.stopping.abort();
    const worker = this.worker;

    if (!worker) {
      this.connection?.disconnect();

      return;
    }

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const closing = worker.close();

    try {
      // close는 새 수신을 멈추고 DB claim·Redis ack를 기다리지만 자체 timeout은 없다.
      // pause는 대기가 끝난 뒤 blocking 연결을 다시 열므로 종료 유예에 사용하지 않는다.
      const drained = await Promise.race([
        closing.then(() => true),
        new Promise<false>((resolve) => {
          deadline = setTimeout(() => resolve(false), 5000);
        }),
      ]);

      if (!drained) {
        logger.warn('Worker 종료 유예 시간이 지나 전달 확인을 중단합니다.');
        // close(true)는 이미 시작한 close promise를 돌려준다. public backend API로
        // 재연결·ack를 끝낸 뒤 원래 종료 흐름을 회수하고 Pool shutdown으로 넘어간다.
        await worker.getBackend().close(true);
        this.connection?.disconnect();
        await closing;
      }
    } finally {
      if (deadline) {
        clearTimeout(deadline);
      }

      // 유실된 ack는 PG의 lease·repair로 복구한다.
      this.connection?.disconnect();
    }
  }
}
