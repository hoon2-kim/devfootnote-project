import { AuthBoundary } from '../../features/auth';
import { SearchScreen } from '../../features/search';
import { parsePage } from '../../lib/pagination';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[] }>;
}) {
  const params = await searchParams;
  const query =
    typeof params.q === 'string'
      ? params.q.normalize('NFKC').trim().replace(/\s+/gu, ' ').slice(0, 200)
      : '';

  return (
    <AuthBoundary>
      <SearchScreen query={query} page={parsePage(params.page)} />
    </AuthBoundary>
  );
}
