import { createHash } from 'node:crypto';
import type { MaterialChunk, MaterialContentInput, PreparedMaterial } from './material.types.js';

/** DB 접근 없이 저장 본문·검색용 정규화 텍스트·chunk·내용 식별자를 함께 준비한다. */
export function prepareMaterial(input: MaterialContentInput): PreparedMaterial {
  // 본문 공백은 Markdown 의미와 offset에 영향을 주므로 줄바꿈만 통일한다.
  const optional = (value: string | undefined) => value?.replace(/\r\n?/g, '\n').trim() || null;
  const content = {
    title: optional(input.title),
    body: input.body.replace(/\r\n?/g, '\n'),
    note: optional(input.note),
    context: optional(input.context),
    sourceUrl: optional(input.sourceUrl),
  };

  return {
    content,
    fingerprint: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
    normalizedText: Object.values(content)
      .filter((value) => value !== null)
      .join('\n')
      .normalize('NFKC')
      .toLowerCase(),
    chunks: chunkBody(content.body),
  };
}

export function chunkBody(body: string): MaterialChunk[] {
  const chunks: MaterialChunk[] = [];

  // 초기 고정 크기 분할. offset은 JS UTF-16의 [start, end)이며 surrogate pair는 나누지 않는다.
  for (let start = 0; start < body.length;) {
    let end = Math.min(start + 1200, body.length);
    const last = body.charCodeAt(end - 1);

    if (end < body.length && last >= 0xd800 && last <= 0xdbff) {
      end--;
    }

    chunks.push({
      ordinal: chunks.length,
      text: body.slice(start, end),
      startOffset: start,
      endOffset: end,
    });
    start = end;
  }

  return chunks;
}

// 내용이 같아도 대상 자료·기대 버전·작업이 다르면 같은 요청으로 재사용할 수 없다.
export function mutationFingerprint(
  operation: 'update' | 'delete',
  materialId: string,
  expectedRevisionId: string,
  contentFingerprint?: string,
) {
  return createHash('sha256')
    .update(JSON.stringify([operation, materialId, expectedRevisionId, contentFingerprint ?? null]))
    .digest('hex');
}
