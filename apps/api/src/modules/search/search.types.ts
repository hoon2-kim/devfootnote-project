import type { PageResult } from '../../common/pagination/page-result.js';

export type SearchMatchedField = 'body' | 'note' | 'context' | 'title' | 'sourceUrl';

export interface SearchItem {
  id: string;
  revisionId: string;
  revision: number;
  title: string | null;
  updatedAt: Date;
  snippet: string;
  matchedField: SearchMatchedField;
}

export interface SearchResult extends PageResult<SearchItem> {
  page: number;
}
