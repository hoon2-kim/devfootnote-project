import { describe, expect, it } from 'vitest';
import { chunkBody, prepareMaterial } from './material-content.js';

describe('자료 본문 준비', () => {
  it('본문 공백을 보존하고 CRLF와 선택 metadata만 정규화한다', () => {
    const first = prepareMaterial({ body: '  code\r\n다음 줄', title: ' 제목 ', note: '' });
    const retry = prepareMaterial({ body: '  code\n다음 줄', title: '제목' });

    expect(first.content.body).toBe('  code\n다음 줄');
    expect(first.content.note).toBeNull();
    expect(first.fingerprint).toBe(retry.fingerprint);
    expect(prepareMaterial({ body: 'code\n다음 줄', title: '제목' }).fingerprint).not.toBe(
      first.fingerprint,
    );
  });
  it('본문 조각의 offset이 원문을 누락·중복 없이 복원하고 surrogate pair를 나누지 않는다', () => {
    const body = 'a'.repeat(1199) + '😀' + '한글 Node.js '.repeat(400);
    const chunks = chunkBody(body);

    expect(chunks.map((chunk) => chunk.text).join('')).toBe(body);
    expect(chunks[0]?.endOffset).toBe(1199);

    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.ordinal).toBe(index);
      expect(chunk.text).toBe(body.slice(chunk.startOffset, chunk.endOffset));
      expect(chunk.startOffset).toBe(index === 0 ? 0 : chunks[index - 1]?.endOffset);
    }
  });
});
