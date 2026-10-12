import { queryOptions } from '@tanstack/react-query';
import { previewEmbeddingActivation } from '@devfootnote/api-client';
import { unwrapApiResult, type createBrowserApiClient } from '../../lib/api-client';

export const embeddingKeys = {
  all: (ownerId: string) => ['private', ownerId, 'embedding'] as const,
  preview: (ownerId: string, afterId?: string) =>
    [...embeddingKeys.all(ownerId), 'preview', afterId ?? ''] as const,
};

export function embeddingPreviewQuery(
  client: ReturnType<typeof createBrowserApiClient>,
  ownerId: string,
  afterId?: string,
) {
  return queryOptions({
    queryKey: embeddingKeys.preview(ownerId, afterId),
    queryFn: async ({ signal }) =>
      unwrapApiResult(await previewEmbeddingActivation({ client, signal, query: { afterId } })),
  });
}
