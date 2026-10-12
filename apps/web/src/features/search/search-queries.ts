export const searchKeys = {
  all: (ownerId: string) => ['private', ownerId, 'search'] as const,
  result: (
    ownerId: string,
    query: string,
    page: number,
    mode: 'keyword' | 'vector' | 'hybrid' = 'keyword',
  ) => [...searchKeys.all(ownerId), mode, query, page] as const,
};
