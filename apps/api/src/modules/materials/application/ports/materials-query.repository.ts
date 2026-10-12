import type { PageResult } from '../../../../common/pagination/page-result.js';
import type {
  MaterialDetail,
  MaterialPage,
  MaterialSearchCandidate,
  RankedMaterialReference,
} from '../materials.types.js';

export const MATERIALS_QUERY_REPOSITORY = Symbol('MATERIALS_QUERY_REPOSITORY');

/**
 * 현재 자료의 화면 조회와 검색 후보 계약이다.
 * hasNext 판정용 추가 행은 구현체 내부에서 제거한다.
 * 원자 쓰기에 필요한 잠금·receipt 조회는 쓰기 저장소에 남긴다.
 */
export interface MaterialsQueryRepository {
  rankedCurrentCandidates(
    ownerId: string,
    references: readonly RankedMaterialReference[],
    limit: number,
  ): Promise<MaterialSearchCandidate[]>;
  list(
    ownerId: string,
    page: number,
    pageSize: number,
  ): Promise<Omit<MaterialPage, 'page' | 'pageSize'>>;
  read(ownerId: string, id: string): Promise<MaterialDetail>;
  keywordCandidates(
    ownerId: string,
    query: string,
    page: number,
    pageSize: number,
  ): Promise<PageResult<MaterialSearchCandidate>>;
}
