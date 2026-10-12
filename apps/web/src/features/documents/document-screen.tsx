'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteMaterial, getMaterial } from '@devfootnote/api-client';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ApiError, unwrapApiResult } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-provider';
import { useOwnerId } from '../auth';
import { SafeMarkdown } from './safe-markdown';
import { DocumentEditor } from './document-editor';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { materialKeys, invalidateMaterialCollections } from '../library';
import { gowunBatang } from '../../lib/fonts';
import { AnswerPanel } from '../answers';

export function DocumentScreen({
  materialId,
  expectedRevisionId,
}: {
  materialId: string;
  expectedRevisionId?: string;
}) {
  const ownerId = useOwnerId();
  const client = useApiClient();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const deleteRequest = useRef<{ key: string; revisionId: string } | undefined>(undefined);
  const document = useQuery({
    queryKey: materialKeys.current(ownerId, materialId),
    queryFn: async ({ signal }) => {
      const result = await getMaterial({ client, signal, path: { materialId } });

      return unwrapApiResult(result);
    },
  });
  const material = document.data;
  // 일시 장애에는 cached 본문을 유지하지만 삭제·접근 거부 응답에는 이전 내용도 숨긴다.
  const missing =
    document.error instanceof ApiError && [400, 403, 404].includes(document.error.status);
  const remove = useMutation({
    mutationFn: async () => {
      if (!material) {
        throw new ApiError(404);
      }

      // 확인 시점의 revision과 key는 응답 유실 재시도에서도 유지한다.
      deleteRequest.current ??= { key: crypto.randomUUID(), revisionId: material.revisionId };
      const result = await deleteMaterial({
        client,
        path: { materialId },
        body: {
          idempotencyKey: deleteRequest.current.key,
          expectedRevisionId: deleteRequest.current.revisionId,
        },
      });

      unwrapApiResult(result);
    },
    onSuccess: () => {
      setConfirming(false);
      queryClient.removeQueries({
        queryKey: materialKeys.current(ownerId, materialId),
      });
      void invalidateMaterialCollections(queryClient, ownerId);
      router.replace('/library');
    },
  });

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-6xl px-6 py-8 sm:px-10 sm:py-12"
    >
      <Button asChild variant="ghost" className="-ml-4 text-text-muted">
        <Link href="/library">
          <ArrowLeft aria-hidden="true" />
          자료함으로
        </Link>
      </Button>
      {document.isPending && (
        <>
          <h1 className="mt-8 text-2xl font-semibold">자료 읽기</h1>
          <p role="status" className="mt-6 text-text-muted">
            원문을 불러오고 있습니다.
          </p>
        </>
      )}
      {document.isFetching && !document.isPending && (
        <p role="status" className="mt-6 text-text-muted">
          불러오는 중…
        </p>
      )}
      {document.isError && (!material || missing) && (
        <section className="mt-8 rounded-xl border border-border-subtle bg-surface p-6">
          <h1 className="text-2xl font-semibold">
            {missing ? '자료를 찾을 수 없습니다' : '자료를 불러오지 못했습니다'}
          </h1>
          <p role="alert" className="mt-4 text-text-secondary">
            {missing
              ? '삭제되었거나 접근할 수 없는 자료입니다. 자료함에서 다시 확인해 주세요.'
              : '연결을 확인한 뒤 다시 시도해 주세요.'}
          </p>
          {!missing && (
            <Button
              disabled={document.isFetching}
              onClick={() => void document.refetch()}
              className="mt-6"
            >
              {document.isFetching ? '불러오는 중…' : '원문 다시 불러오기'}
            </Button>
          )}
        </section>
      )}
      {material && !missing && (
        <>
          {document.isError && (
            <div className="mt-6 rounded-lg border border-border-subtle bg-surface p-4">
              <p role="alert">최신 상태를 확인하지 못했습니다. 이전에 불러온 내용입니다.</p>
              <Button
                className="mt-3"
                disabled={document.isFetching}
                onClick={() => void document.refetch()}
              >
                {document.isFetching ? '불러오는 중…' : '최신 상태 다시 확인'}
              </Button>
            </div>
          )}
          {expectedRevisionId && expectedRevisionId !== material.revisionId && (
            <p role="status" className="mt-6 rounded-lg border border-border-subtle bg-surface p-4">
              검색 이후 자료가 변경되어 최신 버전을 표시합니다.
            </p>
          )}
          <div className="mt-6 mb-10 flex flex-wrap items-end justify-between gap-6 border-b border-paper-rule pb-8">
            <header className="min-w-0 flex-1 basis-full lg:basis-0">
              <h1
                className={`${gowunBatang.className} text-[32px] leading-snug tracking-tight sm:text-[40px]`}
              >
                {material.title || '제목 없는 자료'}
              </h1>
              <p className="mt-3 text-sm text-text-muted">
                버전 {material.revision} ·{' '}
                <time dateTime={material.updatedAt}>
                  {new Date(material.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
                </time>{' '}
                수정
              </p>
            </header>
            <div className="flex flex-wrap gap-2">
              <Button disabled={editing} onClick={() => setEditing(true)}>
                자료 수정
              </Button>
              <Button
                variant="destructive"
                disabled={editing}
                onClick={() => {
                  deleteRequest.current = undefined;
                  remove.reset();
                  setRecoveryFailed(false);
                  setConfirming(true);
                }}
              >
                자료 삭제
              </Button>
            </div>
          </div>
          {editing && (
            <DocumentEditor
              material={material}
              ownerId={ownerId}
              onClose={() => setEditing(false)}
            />
          )}
          <ConfirmDialog
            open={confirming}
            title="자료를 삭제할까요?"
            busy={remove.isPending}
            confirmDisabled={document.isFetching}
            onCancel={() => setConfirming(false)}
            onConfirm={() => remove.mutate()}
          >
            <p>삭제하면 목록·검색·원문 읽기에서 즉시 제외됩니다. 되돌리는 기능은 없습니다.</p>
            {remove.isError && (
              <div role="alert" className="mt-4 text-status-error">
                {remove.error instanceof ApiError && remove.error.status === 409 ? (
                  <>
                    <p>자료가 변경되어 삭제하지 않았습니다.</p>
                    <Button
                      disabled={document.isFetching}
                      onClick={async () => {
                        setRecoveryFailed(false);
                        const latest = await document.refetch();

                        // 실패한 refetch에도 cached data는 남을 수 있어 data 유무로 성공을 판정하지 않는다.
                        if (latest.isSuccess) {
                          deleteRequest.current = undefined;
                          remove.reset();
                          setConfirming(false);
                        } else {
                          setRecoveryFailed(true);
                        }
                      }}
                    >
                      {document.isFetching ? '불러오는 중…' : '취소하고 최신 내용 확인'}
                    </Button>
                    <p role="status">
                      {document.isFetching
                        ? '최신 내용을 불러오는 중…'
                        : recoveryFailed
                          ? '최신 내용을 불러오지 못했습니다. 다시 시도해 주세요.'
                          : ''}
                    </p>
                  </>
                ) : (
                  <p>
                    삭제를 확인하지 못했습니다. 연결과 로그인 상태를 확인한 뒤 다시 시도해 주세요.
                  </p>
                )}
              </div>
            )}
          </ConfirmDialog>
          <div className="grid items-start gap-8 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-12">
            <section
              aria-labelledby="note-title"
              className="min-w-0 border-t-2 border-paper-accent pt-5"
            >
              <h2 id="note-title" className={`${gowunBatang.className} scroll-mt-8 text-2xl`}>
                나의 메모
              </h2>
              <p className="mt-4 whitespace-pre-wrap leading-7 text-text-secondary">
                {material.note || '남긴 메모가 없습니다.'}
              </p>
              {material.context && (
                <>
                  <h3 className="mt-8 border-t border-paper-rule pt-5 text-sm font-medium">
                    사용 맥락
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap leading-7 text-text-secondary">
                    {material.context}
                  </p>
                </>
              )}
            </section>
            <section
              aria-labelledby="source-title"
              className="min-w-0 border border-paper-rule bg-surface p-5 sm:p-8 lg:p-10"
            >
              <h2 id="source-title" className={`${gowunBatang.className} scroll-mt-8 text-2xl`}>
                저장한 원문
              </h2>
              {material.sourceUrl && (
                <a
                  href={material.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex min-h-11 max-w-full items-center gap-2 text-sm text-action-primary underline"
                >
                  <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
                  <span className="break-all">{material.sourceUrl} (새 탭)</span>
                </a>
              )}
              <div className="mt-6 border-t border-border-subtle pt-6">
                <SafeMarkdown body={material.body} />
              </div>
            </section>
          </div>
          <AnswerPanel key={`${material.id}:${material.revisionId}`} material={material} />
        </>
      )}
    </main>
  );
}
