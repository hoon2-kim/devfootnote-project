'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Pagination } from '../../components/ui/pagination';
import { useApiClient } from '../../lib/api-provider';
import { useOwnerId } from '../auth';
import { MaterialForm } from './material-form';
import { invalidateMaterialCollections, materialsQuery } from './material-queries';
import { gowunBatang } from '../../lib/fonts';
import { EmbeddingPanel } from '../indexing';
import { searchKeys } from '../search';

export function LibraryScreen({ page }: { page: number }) {
  const ownerId = useOwnerId();
  const queryClient = useQueryClient();
  const list = useQuery(materialsQuery(useApiClient(), ownerId, page));
  const [formOpen, setFormOpen] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-6xl px-6 py-10 sm:px-10 sm:py-14"
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 sm:mb-8">
        <div>
          <h1
            className={`${gowunBatang.className} text-[32px] leading-snug tracking-tight sm:text-[38px]`}
          >
            내 자료함
          </h1>
        </div>
        <Button
          ref={createButton}
          type="button"
          variant="primary"
          aria-expanded={formOpen}
          aria-controls="new-material"
          disabled={formOpen}
          onClick={() => setFormOpen(true)}
        >
          <Plus aria-hidden="true" />새 자료
        </Button>
      </div>
      {/* 패널을 접어도 초안과 멱등 요청 ID가 사라지지 않도록 form은 마운트 상태를 유지한다. */}
      <MaterialForm
        ownerId={ownerId}
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          requestAnimationFrame(() => createButton.current?.focus());
        }}
      />
      <EmbeddingPanel
        onConsentChanged={async () => {
          queryClient.removeQueries({ queryKey: searchKeys.all(ownerId) });
          await invalidateMaterialCollections(queryClient, ownerId);
        }}
      />
      <section aria-labelledby="materials-title">
        <h2 id="materials-title" className="sr-only">
          저장한 자료
        </h2>
        <div
          aria-hidden="true"
          className="flex justify-between gap-4 rounded-t-xl border border-paper-rule bg-paper-hover px-5 py-3 text-sm text-paper-muted sm:px-6"
        >
          <span>자료</span>
          <span>최근 수정</span>
        </div>
        {list.isPending && (
          <p role="status" className="py-8 text-text-muted">
            자료를 불러오고 있습니다.
          </p>
        )}
        {list.isError && (
          <div className="border-b border-paper-rule py-10">
            <p role="alert" className="mb-4 text-status-error">
              자료 목록을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.
            </p>
            <Button disabled={list.isFetching} onClick={() => void list.refetch()}>
              목록 다시 불러오기
            </Button>
          </div>
        )}
        {list.data && (
          <>
            {list.data.items.length === 0 ? (
              <div className="border-b border-paper-rule py-20 text-center sm:py-28">
                <p className="text-base text-paper-ink">
                  {page === 1 ? '아직 저장한 자료가 없습니다' : '이 페이지에는 자료가 없습니다'}
                </p>
                <p className="mt-3 text-sm leading-6 text-paper-muted">
                  {page === 1
                    ? '새 자료를 눌러 첫 기록을 남겨 보세요.'
                    : '이전 페이지에서 저장한 자료를 확인해 주세요.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-paper-rule rounded-b-xl border border-t-0 border-paper-rule bg-surface">
                {list.data.items.map((item) => (
                  <li
                    key={item.id}
                    className="group grid gap-1 px-5 py-3 first:rounded-t-none last:rounded-b-xl hover:bg-paper-hover/60 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8 sm:px-6 sm:py-4"
                  >
                    <Link
                      href={`/documents/${item.id}`}
                      className="flex min-h-11 min-w-0 items-center gap-3 font-medium text-paper-ink underline-offset-4 hover:underline"
                    >
                      <FileText
                        aria-hidden="true"
                        className="size-5 shrink-0 text-paper-muted"
                        strokeWidth={1.5}
                      />
                      {item.title || '제목 없는 자료'}
                    </Link>
                    <p className="pl-8 text-sm text-paper-muted sm:pl-0 sm:text-right">
                      <time dateTime={item.updatedAt}>
                        {new Date(item.updatedAt).toLocaleDateString('ko-KR', {
                          timeZone: 'Asia/Seoul',
                        })}
                      </time>{' '}
                      <span className="sm:sr-only">수정</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <Pagination
              page={page}
              hasNext={list.data.hasNext}
              totalPages={Math.max(1, Math.ceil(list.data.totalCount / list.data.pageSize))}
              href={(page) => `/library?page=${page}`}
              label="자료 목록 페이지"
            />
          </>
        )}
      </section>
    </main>
  );
}
