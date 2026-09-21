import { describe, expect, it } from 'vitest';
import { createSearchSnippet } from './search-snippet.js';

const content = { body: '', title: null, note: null, context: null, sourceUrl: null };

describe('검색 snippet', () => {
  it('정규화된 검색어에 대응하는 원문 위치를 보여 준다', () => {
    const result = createSearchSnippet({ ...content, body: `${'가'.repeat(300)}ＢｕｌｌＭＱ` }, [
      'bullmq',
    ]);

    expect(result.matchedField).toBe('body');
    expect(result.snippet).toContain('ＢｕｌｌＭＱ');
  });

  it('첫 검색어가 제목에 있어도 본문에 실제로 일치한 토큰을 보여 준다', () => {
    const result = createSearchSnippet(
      { ...content, title: 'postgres', body: `${'가'.repeat(300)}redis` },
      ['postgres', 'redis'],
    );

    expect(result.matchedField).toBe('body');
    expect(result.snippet).toContain('redis');
  });

  it('240자 끝 경계에서 이모지를 자르지 않는다', () => {
    const { snippet } = createSearchSnippet({ ...content, body: `${'a'.repeat(239)}😀` }, ['a']);

    expect(snippet.length).toBeLessThanOrEqual(240);
    expect(snippet).toBe(Buffer.from(snippet).toString('utf8'));
  });

  it.each(['ﬃ', 'e\u0301', 'ㄱㅏ'])(
    '길이가 달라지는 정규화(%s) 뒤의 일치 위치를 찾는다',
    (prefix) => {
      const { snippet } = createSearchSnippet({ ...content, body: `${prefix.repeat(300)} redis` }, [
        'redis',
      ]);

      expect(snippet).toContain('redis');
    },
  );

  it('snippet 시작 경계에서도 이모지를 보존한다', () => {
    const { snippet } = createSearchSnippet(
      { ...content, body: `${'x'.repeat(300)}😀${' '.repeat(59)}redis` },
      ['redis'],
    );

    expect(snippet).toContain('redis');
    expect(snippet.startsWith('😀')).toBe(true);
    expect(snippet).toBe(Buffer.from(snippet).toString('utf8'));
  });

  it.each(['İ', 'ﬃ', 'e\u0301', 'ㄱㅏ', '👩‍💻'])(
    '긴 본문의 %s 변환 뒤에도 끝부분 일치 위치를 보존한다',
    (prefix) => {
      const { snippet } = createSearchSnippet(
        { ...content, body: `${prefix.repeat(1500)} redis` },
        ['redis'],
      );

      expect(snippet).toContain('redis');
      expect(snippet.length).toBeLessThanOrEqual(240);
      expect(snippet).toBe(Buffer.from(snippet).toString('utf8'));
    },
  );

  it('본문에 일치가 없으면 메모에서 찾고 원문을 그대로 반환한다', () => {
    expect(
      createSearchSnippet({ ...content, body: '원문', note: '<b>Ｒｅｄｉｓ</b>' }, ['redis']),
    ).toEqual({ snippet: '<b>Ｒｅｄｉｓ</b>', matchedField: 'note' });
  });

  it('literal 일치가 없는 전문 검색 후보는 본문 미리보기를 반환한다', () => {
    expect(createSearchSnippet({ ...content, body: '미리보기' }, ['missing'])).toEqual({
      snippet: '미리보기',
      matchedField: 'body',
    });
  });
});
