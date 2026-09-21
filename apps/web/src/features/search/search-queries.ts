export const searchKeys = {
  all: (ownerId: string) => ['private', ownerId, 'search'] as const,
  result: (ownerId: string, query: string, page: number) =>
    [...searchKeys.all(ownerId), query, page] as const,
};
