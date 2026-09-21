import { Injectable } from '@nestjs/common';
import { MaterialsService } from '../materials/index.js';
import { createSearchSnippet } from './search-snippet.js';
import type { SearchItem, SearchResult } from './search.types.js';

@Injectable()
export class SearchService {
  constructor(private readonly materials: MaterialsService) {}

  async search(
    ownerId: string,
    input: string,
    page: number,
    pageSize: number,
  ): Promise<SearchResult> {
    const query = input.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');

    if (!query) {
      return { items: [], page, hasNext: false };
    }

    const candidates = await this.materials.findKeywordCandidates(ownerId, query, page, pageSize);
    const tokens = query.split(' ');
    const items = candidates.items.map((material): SearchItem => {
      return {
        id: material.id,
        revisionId: material.revisionId,
        revision: material.revision,
        title: material.title,
        updatedAt: material.updatedAt,
        ...createSearchSnippet(material, tokens),
      };
    });

    return { items, page, hasNext: candidates.hasNext };
  }
}
