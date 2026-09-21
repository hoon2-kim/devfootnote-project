import type { SearchMatchedField } from './search.types.js';

interface SearchableContent {
  body: string;
  note: string | null;
  context: string | null;
  title: string | null;
  sourceUrl: string | null;
}

/**
 * 검색 후보에서 일치 필드와 원문 미리보기를 만든다. 후보 선정·순위 계산은 담당하지 않는다.
 * tokens는 NFKC·소문자로 정규화된 값이지만 snippet은 사용자가 저장한 표기를 유지한다.
 */
export function createSearchSnippet(material: SearchableContent, tokens: readonly string[]) {
  const fields: { field: SearchMatchedField; text: string }[] = [
    { field: 'body', text: material.body },
    { field: 'note', text: material.note ?? '' },
    { field: 'context', text: material.context ?? '' },
    { field: 'title', text: material.title ?? '' },
    { field: 'sourceUrl', text: material.sourceUrl ?? '' },
  ];

  for (const { field, text } of fields) {
    const normalized = text.normalize('NFKC').toLowerCase();
    const matches = tokens.map((token) => normalized.indexOf(token)).filter((index) => index >= 0);

    if (matches.length > 0) {
      const index = originalOffset(text, Math.min(...matches));

      return { snippet: excerpt(text, Math.max(0, index - 60)), matchedField: field };
    }
  }

  // 전문 검색으로만 일치한 경우에는 원문 앞부분을 미리보기로 사용한다.
  return { snippet: excerpt(material.body, 0), matchedField: 'body' as const };
}

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

// NFKC·소문자 변환으로 문자열 길이가 달라질 수 있어 검색 위치를 원문 인덱스로 되돌린다.
// 정규화 결과의 한 문자 안을 가리키더라도 원문의 grapheme 시작 경계로 맞춘다.
function originalOffset(text: string, normalizedOffset: number): number {
  if (normalizedOffset === 0) {
    return 0;
  }

  const segments = segmenter.segment(text);
  let low = 0;
  let high = text.length;
  let offset = 0;

  // 전체 grapheme 배열을 만들지 않고 탐색 지점의 경계만 조회한다.
  // prefix 전체를 변환해 NFKC·소문자 변환의 길이 변화와 결합 문자를 유지한다.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    // middle은 항상 [0, text.length) 안에 있으므로 해당 segment가 존재한다.
    const boundary = segments.containing(middle)!.index;
    const length = text.slice(0, boundary).normalize('NFKC').toLowerCase().length;

    if (length <= normalizedOffset) {
      offset = boundary;
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return offset;
}

function excerpt(text: string, offset: number): string {
  const start = codePointBoundary(text, offset);
  const end = codePointBoundary(text, Math.min(text.length, start + 240));

  // 검색 응답은 원문 plain text만 반환하며 HTML highlight를 생성하지 않는다.
  return text.slice(start, end);
}

function codePointBoundary(text: string, offset: number): number {
  const code = text.charCodeAt(offset);

  // UTF-16 low surrogate에서 자르면 이모지 등이 깨지므로 pair 시작으로 한 칸 물린다.
  return code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}
