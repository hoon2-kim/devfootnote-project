import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiEmbedding, geminiEmbeddingDimensions } from '@devfootnote/ai';

function responseBody() {
  return {
    embeddings: [1, 2].map((value) => ({
      values: Array.from({ length: geminiEmbeddingDimensions }, () => value),
    })),
    usageMetadata: { promptTokenCount: 10 },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Gemini 임베딩 HTTP 연동 — 실제 외부 호출 없음', () => {
  it.each([
    { purpose: 'document' as const, prefix: 'title: none | text: ', reason: '본문' },
    { purpose: 'query' as const, prefix: 'task: search result | query: ', reason: '검색어' },
  ])('$reason 전송 형식을 구분하고 키는 URL 대신 헤더로 보낸다', async ({ purpose, prefix }) => {
    const transport = vi.fn().mockResolvedValue(Response.json(responseBody()));

    vi.stubGlobal('fetch', transport);
    const result = await new GeminiEmbedding('fixture-key').embed(
      ['첫 입력', '다음 입력'],
      purpose,
    );

    expect(result.tokens).toBe(10);
    expect(result.vectors.map((vector) => vector[0])).toEqual([1, 2]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents',
      expect.objectContaining({
        redirect: 'error',
        headers: { 'x-goog-api-key': 'fixture-key', 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: ['첫 입력', '다음 입력'].map((text) => ({
            model: 'models/gemini-embedding-2',
            content: { parts: [{ text: `${prefix}${text}` }] },
            embedContentConfig: { outputDimensionality: 1536, autoTruncate: false },
          })),
        }),
      }),
    );
  });

  it.each([
    { status: 400, kind: 'invalid_input' },
    { status: 401, kind: 'access_denied' },
    { status: 403, kind: 'access_denied' },
    { status: 429, kind: 'request_rejected' },
    { status: 503, kind: 'provider_error' },
  ])('HTTP $status 뒤 자동 재시도하거나 원본 오류를 남기지 않는다', async ({ status, kind }) => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: 'fixture-key 원문-비밀' } }, { status }),
      );

    vi.stubGlobal('fetch', transport);
    const failure = await new GeminiEmbedding('fixture-key')
      .embed(['본문'], 'document')
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toMatch(/fixture-key|원문-비밀/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { fault: 'dimension', reason: '다른 차원' },
    { fault: 'count', reason: '벡터 누락' },
    { fault: 'zero', reason: '영벡터' },
    { fault: 'nonfinite', reason: '유한하지 않은 값' },
    { fault: 'usage', reason: '사용량 상한 초과' },
  ])('$reason 응답을 성공 결과로 반환하지 않는다', async ({ fault }) => {
    const body = responseBody();
    const first = body.embeddings[0];

    if (!first) {
      throw new Error('검증할 테스트 벡터가 필요합니다.');
    }

    if (fault === 'dimension') {
      first.values.pop();
    }

    if (fault === 'count') {
      body.embeddings.pop();
    }

    if (fault === 'zero') {
      first.values.fill(0);
    }

    if (fault === 'nonfinite') {
      first.values[0] = Infinity;
    }

    if (fault === 'usage') {
      body.usageMetadata.promptTokenCount = 999999;
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));

    await expect(
      new GeminiEmbedding('fixture').embed(['본문', '본문'], 'document'),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('usage가 없는 유효 응답의 토큰 수를 0으로 위장하지 않는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ embeddings: responseBody().embeddings })),
    );

    const result = await new GeminiEmbedding('fixture').embed(['본문', '본문'], 'document');

    expect(result.tokens).toBeNull();
    expect(result.vectors).toHaveLength(2);
  });

  it('JSON이 아닌 응답을 유효한 벡터로 처리하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('원문-비밀')));

    await expect(new GeminiEmbedding('fixture').embed(['본문'], 'document')).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('취소 신호를 전송하고 네트워크 오류 원문은 보존하지 않는다', async () => {
    const controller = new AbortController();
    const transport = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      expect(init.signal?.aborted).toBe(true);

      throw new Error('fixture-key 원문-비밀', { cause: '연결 비밀' });
    });

    controller.abort();
    vi.stubGlobal('fetch', transport);
    const failure = await new GeminiEmbedding('fixture-key')
      .embed(['본문'], 'document', controller.signal)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: 'unknown_outcome' });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toMatch(/fixture-key|원문-비밀|연결 비밀/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('키가 없거나 입력 크기·개수 제한을 넘으면 외부 요청을 보내지 않는다', async () => {
    const transport = vi.fn();

    vi.stubGlobal('fetch', transport);
    await expect(new GeminiEmbedding('').embed(['본문'], 'document')).rejects.toMatchObject({
      kind: 'not_configured',
    });

    for (const input of [
      [],
      [' '],
      ['가'.repeat(3000)],
      Array.from({ length: 21 }, () => '본문'),
    ]) {
      await expect(new GeminiEmbedding('fixture').embed(input, 'query')).rejects.toMatchObject({
        kind: 'invalid_input',
      });
    }

    expect(transport).not.toHaveBeenCalled();
  });
});
