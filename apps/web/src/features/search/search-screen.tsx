'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  searchMaterials,
  searchSemanticMaterials,
  type SearchItemDto,
  type SemanticSearchResponseDto,
} from '@devfootnote/api-client';
import { Search } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form-field';
import { Pagination } from '../../components/ui/pagination';
import { InfoHint } from '../../components/ui/info-hint';
import { searchKeys } from './search-queries';
import { unwrapApiResult } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-provider';
import { useOwnerId } from '../auth';
import { embeddingPreviewQuery } from '../indexing';
import { gowunBatang } from '../../lib/fonts';

const matchedFieldLabels = {
  body: '원문',
  note: '나의 메모',
  context: '사용 맥락',
  title: '제목',
  sourceUrl: '출처',
} satisfies Record<SearchItemDto['matchedField'], string>;

const degradedLabels = {
  not_configured: '의미 검색 설정이 준비되지 않았습니다.',
  consent_required: '자료함에서 AI 검색을 켜주세요.',
  budget_exhausted: '의미 검색 사용 한도에 도달했습니다.',
  request_used: '이미 처리한 요청입니다. 다시 검색하려면 검색 버튼을 눌러 주세요.',
  provider_unavailable: 'Gemini에 연결하지 못했거나 무료 한도에 도달했습니다.',
  consent_changed: '검색 중 동의 상태가 변경되었습니다.',
  index_unavailable: '의미 검색을 준비한 현재 자료가 없습니다.',
} satisfies Record<NonNullable<SemanticSearchResponseDto['degradedReason']>, string>;

export function SearchScreen({
  query,
  page,
  mode = 'keyword',
}: {
  query: string;
  page: number;
  mode?: 'keyword' | 'vector' | 'hybrid';
}) {
  const ownerId = useOwnerId();
  const client = useApiClient();
  const router = useRouter();
  const queryClient = useQueryClient();
  const semanticRequest = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => semanticRequest.current?.abort(), []);
  const readiness = useQuery(embeddingPreviewQuery(client, ownerId));
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
  // 비용이 드는 검색은 URL 복원·focus·cache 무효화로 실행하지 않는다. 명시 submit만 mutation을 만든다.
  const semantic = useQuery<SemanticSearchResponseDto>({
    queryKey: searchKeys.result(ownerId, query, 1, 'hybrid'),
    queryFn: skipToken,
    enabled: false,
  });
  const runSemantic = useMutation({
    mutationKey: ['private', ownerId, 'semantic-search'],
    retry: false,
    mutationFn: async ({ q, requestId }: { q: string; requestId: string }) => {
      semanticRequest.current?.abort();
      semanticRequest.current = new AbortController();
      const result = await searchSemanticMaterials({
        client,
        signal: semanticRequest.current.signal,
        body: { q, mode: 'hybrid', requestId },
      });

      return unwrapApiResult(result);
    },
    onSuccess: (data, variables) => {
      queryClient.setQueryData(searchKeys.result(ownerId, variables.q, 1, 'hybrid'), data);
    },
  });
  const canSemantic = !readiness.isError && readiness.data?.configured && readiness.data.consented;
  const semanticFailed =
    mode !== 'keyword' && runSemantic.isError && runSemantic.variables?.q === query;
  const usingKeyword =
    mode === 'keyword' ||
    !canSemantic ||
    !semantic.data ||
    semanticFailed ||
    semantic.data.effectiveMode === 'keyword';
  const degradedReason =
    canSemantic && mode !== 'keyword' && !semanticFailed
      ? semantic.data?.degradedReason
      : undefined;
  const results = usingKeyword ? search.data : semantic.data;
  const fetching = runSemantic.isPending || (usingKeyword && search.isFetching);
  const failed = usingKeyword && search.isError;
  const pageUrl = (page: number) =>
    `/search?${new URLSearchParams({ q: query, page: String(page) })}`;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-6xl px-6 py-10 sm:px-10 sm:py-14"
    >
      <h1
        className={`${gowunBatang.className} text-[32px] leading-snug tracking-tight sm:text-[38px]`}
      >
        자료 검색
      </h1>
      <form
        action="/search"
        className="mt-7 rounded-xl border border-paper-rule bg-surface p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const input = form.get('q');
          const q =
            typeof input === 'string'
              ? input.normalize('NFKC').trim().replace(/\s+/gu, ' ').slice(0, 200)
              : '';
          const selectedMode = canSemantic ? 'hybrid' : 'keyword';

          router.replace(`/search?${new URLSearchParams({ q, mode: selectedMode })}`);

          if (q && selectedMode !== 'keyword' && canSemantic) {
            runSemantic.mutate({ q, requestId: crypto.randomUUID() });
          } else if (q === query) {
            void search.refetch();
          }
        }}
      >
        <label htmlFor="search-query" className="sr-only">
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
            placeholder="찾고 싶은 내용을 입력하세요"
            className="min-h-12 min-w-0 flex-1 rounded-lg"
          />
          <Button type="submit" variant="primary" disabled={fetching} className="min-h-12 px-6">
            <Search aria-hidden="true" />
            {fetching ? '검색 중…' : '검색'}
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p id="search-hint" className="text-sm text-text-muted">
            단어가 같거나 뜻이 비슷한 자료를 찾습니다.
          </p>
          <InfoHint label="검색 방법 안내">
            <p>
              검색을 누르면 단어와 뜻을 함께 비교합니다. AI 검색을 켜지 않았거나 사용할 수 없을 때는
              단어가 일치하는 자료만 찾습니다.
            </p>
            <p className="mt-2">
              AI 검색에는 검색어를 Google에 전송합니다. 입력 중에는 전송하지 않습니다.
            </p>
          </InfoHint>
          {!canSemantic && !readiness.isError && !readiness.isFetching && (
            <Link
              href="/library"
              className="inline-flex min-h-11 items-center text-sm text-paper-accent underline underline-offset-4"
            >
              AI 검색 사용하기
            </Link>
          )}
        </div>
        {readiness.isError && (
          <p role="alert" className="mt-3 text-sm text-status-error">
            의미 검색 준비 상태를 확인하지 못했습니다. 키워드 검색은 계속 사용할 수 있습니다.
          </p>
        )}
        {readiness.isError && (
          <Button
            type="button"
            disabled={readiness.isFetching}
            onClick={() => void readiness.refetch()}
          >
            {readiness.isFetching ? '준비 상태 확인 중…' : '준비 상태 다시 확인'}
          </Button>
        )}
        {readiness.isFetching && (
          <p role="status" className="mt-3 text-sm text-text-muted">
            의미 검색 준비 상태를 확인하는 중…
          </p>
        )}
      </form>
      <section aria-labelledby="results-title" className="mt-8">
        <h2 id="results-title" className="text-base font-medium">
          검색 결과
        </h2>
        {!query && (
          <div className="py-12 text-center sm:py-16">
            <p className="text-sm text-text-muted">검색어를 입력해 주세요.</p>
          </div>
        )}
        {query && fetching && (
          <p role="status" className="mt-6">
            검색 중…
          </p>
        )}
        {query && usingKeyword && !fetching && !failed && !semanticFailed && !degradedReason && (
          <p aria-live="polite" className="mt-4 text-sm text-text-muted">
            지금은 단어가 일치하는 자료만 찾았어요.
            {canSemantic ? ' 검색 버튼을 누르면 뜻도 함께 비교합니다.' : ''}
          </p>
        )}
        {semanticFailed && (
          <div className="mt-4 text-sm text-text-muted">
            <p aria-live="polite">AI 검색에 연결하지 못해 단어 검색 결과를 표시합니다.</p>
            <Button
              disabled={fetching || !canSemantic}
              onClick={() => runSemantic.variables && runSemantic.mutate(runSemantic.variables)}
            >
              AI 검색 다시 확인
            </Button>
          </div>
        )}
        {degradedReason && (
          <p aria-live="polite" className="mt-4 text-sm text-text-muted">
            {degradedLabels[degradedReason]} 지금은 단어가 일치하는 자료만 찾았어요.
          </p>
        )}
        {failed && (
          <div className="mt-6">
            <p role="alert" className="mb-4 text-status-error">
              검색하지 못했습니다. 연결과 로그인 상태를 확인한 뒤 다시 시도해 주세요.
            </p>
            <Button disabled={fetching} onClick={() => void search.refetch()}>
              {fetching ? '검색 중…' : '검색 다시 시도'}
            </Button>
          </div>
        )}
        {results && (
          <>
            {!usingKeyword && semantic.data?.truncated && (
              <p className="mt-4 text-sm text-text-muted">
                의미 검색은 상위 {semantic.data.resultLimit}개까지 표시합니다.
                {semantic.data.truncated
                  ? ' 검색어를 구체적으로 입력하면 범위를 좁힐 수 있습니다.'
                  : ''}
              </p>
            )}
            <p role="status" className="my-4 text-sm text-text-muted">
              {failed
                ? '최신 검색 결과를 확인하지 못했습니다. 이전 결과입니다.'
                : results.items.length
                  ? '현재 저장된 자료에서 찾은 결과입니다.'
                  : '일치하는 자료가 없습니다. 다른 단어로 검색해 보세요.'}
            </p>
            <ul className="divide-y divide-paper-rule rounded-xl border border-paper-rule bg-surface">
              {results.items.map((item) => (
                <li key={item.id} className="p-5 sm:px-6">
                  <Link
                    href={`/documents/${item.id}?revision=${item.revisionId}#${item.matchedField === 'note' || item.matchedField === 'context' ? 'note-title' : 'source-title'}`}
                    className="inline-flex min-h-11 items-center text-lg font-medium underline-offset-4 hover:underline"
                  >
                    {item.title || '제목 없는 자료'}
                  </Link>
                  <p className="mt-2 max-w-3xl whitespace-pre-wrap leading-7 text-text-secondary">
                    {item.snippet}
                  </p>
                  <p className="mt-3 text-sm text-text-muted">
                    버전 {item.revision} · {matchedFieldLabels[item.matchedField]}에서 찾음
                  </p>
                </li>
              ))}
            </ul>
            {usingKeyword && (
              <Pagination
                page={page}
                hasNext={results.hasNext}
                href={pageUrl}
                label="검색 결과 페이지"
              />
            )}
          </>
        )}
      </section>
    </main>
  );
}
