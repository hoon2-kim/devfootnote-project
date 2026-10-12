import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';

export function Pagination({
  page,
  hasNext,
  href,
  label,
  totalPages,
}: {
  page: number;
  hasNext: boolean;
  href: (page: number) => string;
  label: string;
  totalPages?: number;
}) {
  // 전체 개수가 없는 검색은 확인된 인접 페이지만 표시한다.
  const current = totalPages === undefined ? page : Math.min(page, totalPages);
  const first = Math.max(1, current - 1);
  const last =
    totalPages === undefined ? (hasNext ? page + 1 : page) : Math.min(totalPages, first + 2);
  const pages = Array.from({ length: last - first + 1 }, (_, index) => first + index);

  return (
    <nav aria-label={label} className="mt-6 flex flex-wrap items-center justify-center gap-1">
      {page > 1 ? (
        <Button asChild variant="ghost" className="px-2">
          <Link href={href(page - 1)} aria-label="이전 페이지">
            <ChevronLeft aria-hidden="true" />
          </Link>
        </Button>
      ) : (
        <Button variant="ghost" disabled aria-label="이전 페이지" className="px-2">
          <ChevronLeft aria-hidden="true" />
        </Button>
      )}
      {first > 1 && (
        <Button asChild variant="ghost" className="px-2 tabular-nums">
          <Link href={href(1)} aria-label="1페이지">
            1
          </Link>
        </Button>
      )}
      {first > 2 && (
        <span aria-hidden="true" className="px-1 text-text-muted">
          …
        </span>
      )}
      {pages.map((number) => (
        <Button
          key={number}
          asChild
          variant={number === page ? 'primary' : 'ghost'}
          className="px-2 tabular-nums"
        >
          <Link
            href={href(number)}
            aria-label={`${number}페이지`}
            aria-current={number === page ? 'page' : undefined}
          >
            {number}
          </Link>
        </Button>
      ))}
      {totalPages !== undefined && last < totalPages - 1 && (
        <span aria-hidden="true" className="px-1 text-text-muted">
          …
        </span>
      )}
      {totalPages !== undefined && last < totalPages && (
        <Button asChild variant="ghost" className="px-2 tabular-nums">
          <Link href={href(totalPages)} aria-label={`${totalPages}페이지`}>
            {totalPages}
          </Link>
        </Button>
      )}
      {hasNext ? (
        <Button asChild variant="ghost" className="px-2">
          <Link href={href(page + 1)} aria-label="다음 페이지">
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      ) : (
        <Button variant="ghost" disabled aria-label="다음 페이지" className="px-2">
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
    </nav>
  );
}
