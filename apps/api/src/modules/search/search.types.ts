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

export type SemanticMode = 'vector' | 'hybrid';
export type SemanticDegradedReason =
  | 'not_configured'
  | 'consent_required'
  | 'budget_exhausted'
  | 'request_used'
  | 'provider_unavailable'
  | 'consent_changed'
  | 'index_unavailable';
export interface SemanticSearchResult extends SearchResult {
  requestedMode: SemanticMode;
  effectiveMode: SemanticMode | 'keyword';
  degradedReason: SemanticDegradedReason | null;
  resultLimit: number;
  truncated: boolean;
}
