import { expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  invalidateMaterialCollections,
  materialKeys,
} from '../apps/web/src/features/library/material-queries';
import { searchKeys } from '../apps/web/src/features/search/search-queries';

it('자료 변경은 fresh한 목록·검색도 무효화하되 다른 계정과 상세 cache는 건드리지 않는다', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const changed = [materialKeys.list('owner-a', 1), searchKeys.result('owner-a', '인증', 1)];
  const preserved = [
    materialKeys.current('owner-a', 'material-a'),
    materialKeys.list('owner-b', 1),
    searchKeys.result('owner-b', '인증', 1),
  ];

  try {
    for (const key of [...changed, ...preserved]) {
      client.setQueryData(key, { items: [] });
    }

    await invalidateMaterialCollections(client, 'owner-a');

    for (const key of changed) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }

    for (const key of preserved) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    }
  } finally {
    client.clear();
  }
});
