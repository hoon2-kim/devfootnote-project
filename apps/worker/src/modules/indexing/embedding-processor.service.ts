import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Propagation, Transactional } from '@nestjs-cls/transactional';
import { GeminiEmbedding, EmbeddingProviderError } from '@devfootnote/ai';
import { EmbeddingExecutionService } from './embedding-execution.service.js';
import { classifyEmbeddingProviderError } from './embedding-execution.policy.js';

@Injectable()
export class EmbeddingProcessorService {
  constructor(
    private readonly execution: EmbeddingExecutionService,
    private readonly provider: GeminiEmbedding,
    private readonly config: ConfigService,
  ) {}

  @Transactional('worker', Propagation.Never)
  async process(workId: string, leaseToken: string, signal: AbortSignal) {
    // 키가 없는 worker는 호출 시작·비용 노출을 만들지 않는다. 나중에 repair가 재전달한다.
    if (!this.config.get<string>('geminiApiKey') || signal.aborted) {
      return;
    }

    if (await this.execution.reuse(workId, leaseToken)) {
      return;
    }

    const attempt = await this.execution.startAttempt(workId, leaseToken);

    if (!attempt) {
      return;
    }

    const input = await this.execution.callInput(workId, leaseToken, attempt.attemptId);

    if (!input || signal.aborted) {
      return;
    }

    let result: Awaited<ReturnType<GeminiEmbedding['embed']>>;

    try {
      // 두 DB transaction의 commit을 마친 뒤 HTTP를 실행한다. 20초 요청 상한은 60초 lease 안이다.
      result = await this.provider.embed(
        input.chunks.map((chunk) => chunk.text),
        'document',
        signal,
      );
    } catch (error) {
      const kind = error instanceof EmbeddingProviderError ? error.kind : 'unknown_outcome';
      const { failure, retryable } = classifyEmbeddingProviderError(kind);

      // 무료 할당량의 429는 일시 제한이라고 추측해 반복하지 않는다. 새 명시적 재시도가 필요하다.
      await this.execution.failAttempt(workId, leaseToken, attempt.attemptId, failure, {
        retryable,
      });

      return;
    }

    const vectors = input.chunks.map((chunk, index) => {
      const values = result.vectors[index];

      if (!values) {
        throw new Error('검증된 임베딩 결과가 누락되었습니다.');
      }

      return { chunkId: chunk.id, values };
    });

    // 게시 오류를 provider 실패로 바꿔 재호출하지 않는다. DB lease 복구가 불명 결과를 처리한다.
    await this.execution.completeAttempt(workId, leaseToken, attempt.attemptId, {
      configFingerprint: input.configFingerprint,
      vectors,
      tokens: result.tokens,
    });
  }
}
