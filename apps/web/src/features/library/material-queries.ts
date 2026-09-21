import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { listMaterials } from '@devfootnote/api-client';
import { unwrapApiResult, type createBrowserApiClient } from '../../lib/api-client';
import { searchKeys } from '../search/search-queries';

// private/owner 접두사는 AuthBoundary의 계정 전환 정리 기준이다. 모든 자료 key에서 유지한다.
export const materialKeys = {
  current: (ownerId: string, materialId: string) =>
    ['private', ownerId, 'materials', 'current', materialId] as const,
  lists: (ownerId: string) => ['private', ownerId, 'materials', 'list'] as const,
  list: (ownerId: string, page: number) => [...materialKeys.lists(ownerId), page] as const,
};

// 상세는 수정 시 재조회, 삭제 시 제거하므로 각 mutation이 별도로 처리한다.
export async function invalidateMaterialCollections(queryClient: QueryClient, ownerId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: materialKeys.lists(ownerId) }),
    queryClient.invalidateQueries({ queryKey: searchKeys.all(ownerId) }),
  ]);
}

export function materialsQuery(
  client: ReturnType<typeof createBrowserApiClient>,
  ownerId: string,
  page: number,
) {
  return queryOptions({
    queryKey: materialKeys.list(ownerId, page),
    queryFn: async ({ signal }) => {
      const result = await listMaterials({ client, signal, query: { page, pageSize: 20 } });

      return unwrapApiResult(result);
    },
  });
}
