import { parsePage } from '../../lib/pagination';
import { AuthBoundary } from '../../features/auth';
import { LibraryScreen } from '../../features/library';

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const page = parsePage((await searchParams).page);

  return (
    <div className="min-h-svh bg-paper-canvas text-paper-ink [--color-action-pressed:var(--color-paper-ink)] [--color-action-primary:var(--color-paper-accent)] [--color-focus:var(--color-paper-accent)]">
      <AuthBoundary>
        <LibraryScreen page={page} />
      </AuthBoundary>
    </div>
  );
}
