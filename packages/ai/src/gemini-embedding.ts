import { z } from 'zod';

export const geminiEmbeddingModel = 'gemini-embedding-2';
export const geminiEmbeddingDimensions = 1536;
export const geminiEmbeddingBatchLimit = 20;
export const geminiEmbeddingInputVersion = 'body-utf16-1200-gemini2-retrieval-v1';

const resultSchema = z.object({
  embeddings: z.array(
    z.object({ values: z.array(z.number().finite()).length(geminiEmbeddingDimensions) }),
  ),
  usageMetadata: z.object({ promptTokenCount: z.number().int().positive() }).optional(),
});

export class EmbeddingProviderError extends Error {
  constructor(
    readonly kind:
      | 'not_configured'
      | 'invalid_input'
      | 'access_denied'
      | 'request_rejected'
      | 'provider_error'
      | 'invalid_response'
      | 'unknown_outcome',
  ) {
    // 제공자 오류에는 키·입력이 섞일 수 있어 원인 예외도 보존하지 않는다.
    super(`임베딩 제공자 요청 실패: ${kind}`);
  }
}

/** 동기 HTTP 전송만 담당한다. 무료 등급·동의·예산 확인은 호출자가 먼저 마쳐야 한다. */
export class GeminiEmbedding {
  constructor(private readonly apiKey: string) {}

  async embed(input: readonly string[], purpose: 'document' | 'query', signal?: AbortSignal) {
    if (!this.apiKey.trim()) {
      throw new EmbeddingProviderError('not_configured');
    }

    // Embedding 2는 taskType 대신 검색용 접두사를 사용한다. 실제 제목은 기존 전송 계약대로 제외한다.
    const texts = input.map((text) =>
      purpose === 'document'
        ? `title: none | text: ${text}`
        : `task: search result | query: ${text}`,
    );

    if (
      input.length === 0 ||
      input.length > geminiEmbeddingBatchLimit ||
      input.some((text) => !text.trim()) ||
      texts.some((text) => Buffer.byteLength(text, 'utf8') > 8192)
    ) {
      throw new EmbeddingProviderError('invalid_input');
    }

    try {
      const timeout = AbortSignal.timeout(20000);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiEmbeddingModel}:batchEmbedContents`,
        {
          method: 'POST',
          redirect: 'error',
          headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            requests: texts.map((text) => ({
              model: `models/${geminiEmbeddingModel}`,
              content: { parts: [{ text }] },
              embedContentConfig: {
                outputDimensionality: geminiEmbeddingDimensions,
                autoTruncate: false,
              },
            })),
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
      );

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new EmbeddingProviderError('access_denied');
        }

        // 429만으로 일시 제한과 일일 할당량 소진을 구분하지 않는다. 평가에서는 모두 중단한다.
        if (response.status === 429) {
          throw new EmbeddingProviderError('request_rejected');
        }

        throw new EmbeddingProviderError(
          response.status >= 500 ? 'provider_error' : 'invalid_input',
        );
      }

      const body: unknown = await response.json().catch(() => null);
      const parsed = resultSchema.safeParse(body);

      if (!parsed.success) {
        throw new EmbeddingProviderError('invalid_response');
      }

      const { embeddings, usageMetadata } = parsed.data;

      if (
        embeddings.length !== input.length ||
        embeddings.some(({ values }) => !values.some((value) => value !== 0)) ||
        (usageMetadata && usageMetadata.promptTokenCount > input.length * 8192)
      ) {
        throw new EmbeddingProviderError('invalid_response');
      }

      // 배치 응답은 요청 순서다. usage가 없으면 토큰 수를 추정하거나 무료로 정산하지 않는다.
      return {
        vectors: embeddings.map(({ values }) => values),
        tokens: usageMetadata?.promptTokenCount ?? null,
      };
    } catch (error) {
      if (error instanceof EmbeddingProviderError) {
        throw error;
      }

      throw new EmbeddingProviderError('unknown_outcome');
    }
  }
}
