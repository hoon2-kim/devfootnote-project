import Link from 'next/link';
import { Button } from './button';

export function Pagination({
  page,
  hasNext,
  href,
  label,
}: {
  page: number;
  hasNext: boolean;
  href: (page: number) => string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="mt-4 flex items-center justify-between gap-4">
      {page > 1 ? (
        <Button asChild>
          <Link href={href(page - 1)}>이전 페이지</Link>
        </Button>
      ) : (
        <span />
      )}
      <span className="text-sm text-text-muted">{page}페이지</span>
      {hasNext ? (
        <Button asChild>
          <Link href={href(page + 1)}>다음 페이지</Link>
        </Button>
      ) : (
        <span />
      )}
    </nav>
  );
}
