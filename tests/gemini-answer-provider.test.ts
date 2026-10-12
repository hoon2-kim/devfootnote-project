import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GeminiAnswer,
  answerInputByteLimit,
  answerOutputTokenLimit,
  geminiAnswerModel,
  type AnswerInput,
} from '@devfootnote/ai';

const input: AnswerInput = {
  question: '예약 비용은 언제 정산하나요?',
  evidence: [{ evidenceId: 'evidence-1', text: '호출 후 검증한 사용량으로 비용을 정산한다.' }],
};
const candidate = {
  insufficientEvidence: false,
  claims: [{ text: '호출 후 사용량을 검증해 비용을 정산합니다.', evidenceIds: ['evidence-1'] }],
};

function envelope(
  output: unknown = candidate,
  usage: unknown = { promptTokenCount: 40, candidatesTokenCount: 20 },
) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: 'STOP' }],
    ...(usage === undefined ? {} : { usageMetadata: usage }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Gemini 근거 답변 HTTP 연동 — 실제 외부 호출 없음', () => {
  it('선택 모델과 JSON 출력을 요청하고 비밀 키를 URL이나 prompt에 넣지 않는다', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(envelope()));

    vi.stubGlobal('fetch', transport);
    const result = await new GeminiAnswer('fixture-secret-key').generate(input);

    expect(result).toEqual({ ...candidate, usage: { inputTokens: 40, outputTokens: 20 } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiAnswerModel}:generateContent`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': 'fixture-secret-key' },
        signal: expect.any(AbortSignal),
      }),
    );
    const [, request] = transport.mock.calls[0] ?? [];

    if (typeof request?.body !== 'string') {
      throw new Error('직렬화한 답변 요청이 필요합니다.');
    }

    const body = JSON.parse(request.body);

    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: JSON.stringify(input) }] }]);
    expect(body.systemInstruction.parts[0].text).toContain('신뢰할 수 없는 데이터');
    expect(body.generationConfig).toMatchObject({
      candidateCount: 1,
      maxOutputTokens: answerOutputTokenLimit,
      responseMimeType: 'application/json',
    });
    expect(request.body).not.toContain('fixture-secret-key');
  });

  it('근거 부족 응답은 빈 주장으로 반환하고 없는 사용량은 0으로 위장하지 않는다', async () => {
    const response = envelope({ insufficientEvidence: true, claims: [] });

    Reflect.deleteProperty(response, 'usageMetadata');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)));

    expect(await new GeminiAnswer('fixture').generate(input)).toEqual({
      insufficientEvidence: true,
      claims: [],
      usage: null,
    });
  });

  it('생각 부분은 답변에 합치지 않지만 생각 토큰은 비용 사용량에 포함한다', async () => {
    const response = envelope(candidate, {
      promptTokenCount: 40,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 10,
    });

    const first = response.candidates[0];

    if (!first) {
      throw new Error('검증할 답변 후보가 필요합니다.');
    }

    first.content.parts.unshift({ text: '내부 추론 비공개', ...{ thought: true } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)));

    expect(await new GeminiAnswer('fixture').generate(input)).toEqual({
      ...candidate,
      usage: { inputTokens: 40, outputTokens: 30 },
    });
  });

  it('키·질문·근거·UTF-8 입력 상한을 통과하지 못하면 호출은 0건이다', async () => {
    const transport = vi.fn();

    vi.stubGlobal('fetch', transport);
    await expect(new GeminiAnswer('  ').generate(input)).rejects.toMatchObject({
      kind: 'not_configured',
    });

    for (const invalid of [
      { ...input, question: ' ' },
      { ...input, evidence: [] },
      {
        ...input,
        evidence: Array.from({ length: 11 }, (_, index) => ({
          evidenceId: `evidence-${index}`,
          text: '근거',
        })),
      },
      { ...input, question: '한'.repeat(Math.ceil(answerInputByteLimit / 3)) },
    ]) {
      await expect(new GeminiAnswer('fixture').generate(invalid)).rejects.toMatchObject({
        kind: 'invalid_input',
      });
    }

    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: 'snapshot 밖 citation',
      value: { ...candidate, claims: [{ text: '주장', evidenceIds: ['other-owner-evidence'] }] },
    },
    {
      reason: 'citation 없는 주장',
      value: { ...candidate, claims: [{ text: '주장', evidenceIds: [] }] },
    },
    {
      reason: '외부 URL',
      value: {
        ...candidate,
        claims: [{ text: 'https://evil.example/private', evidenceIds: ['evidence-1'] }],
      },
    },
    {
      reason: 'HTML',
      value: {
        ...candidate,
        claims: [{ text: '<script>비공개</script>', evidenceIds: ['evidence-1'] }],
      },
    },
    {
      reason: 'Markdown 링크',
      value: {
        ...candidate,
        claims: [{ text: '[링크](javascript:alert(1))', evidenceIds: ['evidence-1'] }],
      },
    },
    { reason: '근거 부족과 주장 모순', value: { ...candidate, insufficientEvidence: true } },
    { reason: '근거 충분과 빈 주장 모순', value: { insufficientEvidence: false, claims: [] } },
    { reason: '추가 응답 필드', value: { ...candidate, url: 'https://evil.example' } },
  ])('$reason 결과는 게시 가능한 답변이 아니다', async ({ value }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(envelope(value))));

    await expect(new GeminiAnswer('fixture').generate(input)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it.each([
    { status: 400, kind: 'invalid_input' },
    { status: 401, kind: 'access_denied' },
    { status: 403, kind: 'access_denied' },
    { status: 429, kind: 'rate_limited' },
    { status: 503, kind: 'provider_error' },
  ])('HTTP $status 오류를 정제하고 자동 재시도하지 않는다', async ({ status, kind }) => {
    const transport = vi
      .fn()
      .mockResolvedValue(Response.json({ error: 'fixture-secret-key 원문-비밀' }, { status }));

    vi.stubGlobal('fetch', transport);
    const failure = await new GeminiAnswer('fixture-secret-key')
      .generate(input)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toMatch(/fixture-secret-key|원문-비밀/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { reason: '음수 입력 사용량', usage: { promptTokenCount: -1, candidatesTokenCount: 1 } },
    { reason: '소수 출력 사용량', usage: { promptTokenCount: 1, candidatesTokenCount: 1.5 } },
    { reason: '문자열 사용량', usage: { promptTokenCount: '1', candidatesTokenCount: 1 } },
    {
      reason: '입력 상한 초과',
      usage: { promptTokenCount: answerInputByteLimit + 1, candidatesTokenCount: 1 },
    },
    {
      reason: '출력 상한 초과',
      usage: { promptTokenCount: 1, candidatesTokenCount: answerOutputTokenLimit + 1 },
    },
    {
      reason: '생각 포함 상한 초과',
      usage: {
        promptTokenCount: 1,
        candidatesTokenCount: answerOutputTokenLimit,
        thoughtsTokenCount: 1,
      },
    },
    { reason: '출력 사용량 누락', usage: { promptTokenCount: 1 } },
  ])('$reason 응답의 사용량을 정상 비용으로 정산하지 않는다', async ({ usage }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(envelope(candidate, usage))));

    await expect(new GeminiAnswer('fixture').generate(input)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('잘못된 HTTP JSON·모델 JSON·미완료 응답을 성공 처리하지 않는다', async () => {
    const invalidModelJson = envelope();

    const incomplete = envelope();
    const invalidPart = invalidModelJson.candidates[0]?.content.parts[0];
    const incompleteCandidate = incomplete.candidates[0];

    if (!invalidPart || !incompleteCandidate) {
      throw new Error('검증할 답변 후보가 필요합니다.');
    }

    invalidPart.text = '원문-비밀';
    incompleteCandidate.finishReason = 'MAX_TOKENS';

    for (const response of [
      new Response('원문-비밀'),
      Response.json(invalidModelJson),
      Response.json(incomplete),
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

      await expect(new GeminiAnswer('fixture').generate(input)).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    }
  });

  it.each([
    { reason: '빈 후보 목록', candidates: [] },
    { reason: '본문 없는 후보', candidates: [{ finishReason: 'STOP' }] },
    { reason: '후보 누락', candidates: undefined },
  ])('$reason 응답도 정상 사용량은 게시 여부와 별도로 보존한다', async ({ candidates }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          candidates,
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
      ),
    );

    await expect(new GeminiAnswer('fixture').generate(input)).rejects.toMatchObject({
      kind: 'invalid_response',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('취소·네트워크 실패를 사용량 불명의 호출로 분류하고 원본 오류를 보존하지 않는다', async () => {
    const controller = new AbortController();
    const transport = vi.fn().mockImplementation((_url: string, request: RequestInit) => {
      expect(request.signal?.aborted).toBe(true);

      throw new Error('fixture-secret-key 원문-비밀', { cause: '연결 비밀' });
    });

    controller.abort();
    vi.stubGlobal('fetch', transport);
    const failure = await new GeminiAnswer('fixture-secret-key')
      .generate(input, controller.signal)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: 'unknown_outcome' });
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toMatch(/fixture-secret-key|원문-비밀|연결 비밀/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
