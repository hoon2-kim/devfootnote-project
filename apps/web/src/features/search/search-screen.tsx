'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { searchMaterials } from '@devfootnote/api-client';
import { Search } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form-field';
import { Pagination } from '../../components/ui/pagination';
import { searchKeys } from './search-queries';
import { unwrapApiResult } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-provider';
import { useOwnerId } from '../auth';

export function SearchScreen({ query, page }: { query: string; page: number }) {
  const ownerId = useOwnerId();
  const client = useApiClient();
  const search = useQuery({
    queryKey: searchKeys.result(ownerId, query, page),
    enabled: query.length > 0,
    queryFn: async ({ signal }) => {
      const result = await searchMaterials({
        client,
        signal,
        query: { q: query, page, pageSize: 20 },
      });

      return unwrapApiResult(result);
    },
  });
  const pageUrl = (page: number) =>
    `/search?${new URLSearchParams({ q: query, page: String(page) })}`;

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
      <h1 className="text-[32px] font-semibold tracking-tight">자료 검색</h1>
      <p className="mt-3 text-text-secondary">기억나는 단어로 원문과 메모를 다시 찾아보세요.</p>
      <form action="/search" className="mt-8 rounded-xl border border-border-subtle bg-surface p-6">
        <label htmlFor="search-query" className="mb-2 block font-semibold">
          검색어
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            key={query}
            id="search-query"
            aria-describedby="search-hint"
            name="q"
            defaultValue={query}
            maxLength={200}
            placeholder="예: PostgreSQL 중복 요청"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="primary">
            <Search aria-hidden="true" />
            검색
          </Button>
        </div>
        <p id="search-hint" className="mt-3 text-sm text-text-muted">
          키워드 검색 · 의미 검색과 AI 답변은 아직 제공하지 않습니다.
        </p>
      </form>
      <section aria-labelledby="results-title" className="mt-8">
        <h2 id="results-title" className="text-xl font-semibold">
          검색 결과
        </h2>
        {!query && <p className="mt-6 text-text-muted">검색어를 입력해 주세요.</p>}
        {query && search.isFetching && (
          <p role="status" className="mt-6">
            검색 중…
          </p>
        )}
        {search.isError && (
          <div className="mt-6">
            <p role="alert" className="mb-4 text-status-error">
              검색하지 못했습니다. 연결과 로그인 상태를 확인한 뒤 다시 시도해 주세요.
            </p>
            <Button disabled={search.isFetching} onClick={() => void search.refetch()}>
              {search.isFetching ? '검색 중…' : '검색 다시 시도'}
            </Button>
          </div>
        )}
        {search.data && (
          <>
            <p role="status" className="my-4 text-sm text-text-muted">
              {search.isError
                ? '최신 검색 결과를 확인하지 못했습니다. 이전 결과입니다.'
                : search.data.items.length
                  ? '현재 저장된 자료에서 찾은 결과입니다.'
                  : '일치하는 자료가 없습니다. 다른 단어로 검색해 보세요.'}
            </p>
            <ul className="space-y-4">
              {search.data.items.map((item) => (
                <li key={item.id} className="rounded-xl border border-border-subtle bg-surface p-6">
                  <Link
                    href={`/documents/${item.id}?revision=${item.revisionId}#${item.matchedField === 'note' || item.matchedField === 'context' ? 'note-title' : 'source-title'}`}
                    className="inline-flex min-h-11 items-center text-lg font-semibold underline-offset-4 hover:underline"
                  >
                    {item.title || '제목 없는 자료'}
                  </Link>
                  <p className="mt-2 whitespace-pre-wrap text-text-secondary">{item.snippet}</p>
                  <p className="mt-3 text-sm text-text-muted">
                    버전 {item.revision} ·{' '}
                    {item.matchedField === 'note'
                      ? '나의 메모'
                      : item.matchedField === 'context'
                        ? '사용 맥락'
                        : item.matchedField === 'title'
                          ? '제목'
                          : item.matchedField === 'sourceUrl'
                            ? '출처'
                            : '원문'}
                    에서 찾음
                  </p>
                </li>
              ))}
            </ul>
            <Pagination
              page={page}
              hasNext={search.data.hasNext}
              href={pageUrl}
              label="검색 결과 페이지"
            />
          </>
        )}
      </section>
    </main>
  );
}
