'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, SlidersHorizontal, RotateCw } from 'lucide-react';
import {
  activateCurrentEmbeddings,
  revokeEmbeddingConsent,
  type ActivateEmbeddingsDto,
  type EmbeddingStateDto,
} from '@devfootnote/api-client';
import { Button } from '../../components/ui/button';
import { AiNotice } from '../../components/ai-notice';
import { InfoHint } from '../../components/ui/info-hint';
import { ApiError, unwrapApiResult } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-provider';
import { useOwnerId } from '../auth';
import { embeddingKeys, embeddingPreviewQuery } from './embedding-queries';

const stateLabels = {
  NOT_STARTED: '준비 전',
  PENDING: '준비 대기',
  LEASED: '처리 대기',
  CALLING: '처리 중',
  RETRY_WAIT: '재시도 대기',
  PUBLISHED: '검색 가능',
  FINAL_FAILED: '준비 실패',
  OBSOLETE: '다시 준비 필요',
} satisfies Record<EmbeddingStateDto['state'], string>;

function failureMessage(error: unknown) {
  if (error instanceof ApiError && error.code === 'EMBEDDING_BUDGET_EXHAUSTED') {
    return '이번 달 AI 사용 한도에 도달했습니다. 키워드 검색은 계속 사용할 수 있습니다.';
  }

  if (error instanceof ApiError && error.code === 'EMBEDDING_NOT_CONFIGURED') {
    return '의미 검색 설정이 준비되지 않았습니다. 설정을 마친 뒤 준비 상태를 새로 확인해 주세요.';
  }

  if (error instanceof ApiError && error.code === 'EMBEDDING_POLICY_CONFLICT') {
    return '전송 정책이 변경되었습니다. 준비 상태를 새로 확인하고 변경된 조건에 다시 동의해 주세요.';
  }

  if (error instanceof ApiError && error.status === 409) {
    return '자료나 동의 상태가 변경되었습니다. 준비 상태를 새로 확인한 뒤 다시 선택해 주세요.';
  }

  if (error instanceof ApiError && error.status === 429) {
    return '사용 한도에 도달했습니다. 지금은 키워드 검색을 사용해 주세요.';
  }

  return '요청을 확인하지 못했습니다. 입력을 유지했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
}

export function EmbeddingPanel({ onConsentChanged }: { onConsentChanged: () => Promise<void> }) {
  const ownerId = useOwnerId();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [afterId, setAfterId] = useState<string>();
  const [revoking, setRevoking] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const request = useRef<ActivateEmbeddingsDto | undefined>(undefined);
  const revokeEpoch = useRef<number | undefined>(undefined);
  const preview = useQuery({ ...embeddingPreviewQuery(client, ownerId, afterId), enabled: open });
  const data = preview.data;

  async function refreshState() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: embeddingKeys.all(ownerId) }),
      onConsentChanged(),
    ]);
  }

  const activate = useMutation({
    mutationFn: async (retryFailed: boolean) => {
      if (!data?.policy) {
        throw new ApiError(503);
      }

      // 응답 유실 뒤에는 같은 동의·대상·요청 ID를 재전송한다. 새 상태 확인 때만 새 명령을 만든다.
      request.current ??= {
        requestId: crypto.randomUUID(),
        configFingerprint: data.policy.configFingerprint,
        policyVersion: data.policy.policyVersion,
        expectedConsentEpoch: data.consentEpoch,
        accepted: true,
        includeExisting: !retryFailed,
        retryFailed,
        targets: retryFailed
          ? data.states
              .filter((item) => item.state === 'FINAL_FAILED')
              .map(({ materialId, revisionId }) => ({ materialId, revisionId }))
          : [],
      };

      return unwrapApiResult(await activateCurrentEmbeddings({ client, body: request.current }));
    },
    onSuccess: async () => {
      request.current = undefined;
      await refreshState();
    },
  });
  const revoke = useMutation({
    mutationFn: async () => {
      if (!data) {
        throw new ApiError(503);
      }

      revokeEpoch.current ??= data.consentEpoch;

      return unwrapApiResult(
        await revokeEmbeddingConsent({
          client,
          body: { expectedConsentEpoch: revokeEpoch.current },
        }),
      );
    },
    onSuccess: async () => {
      setRevoking(false);
      request.current = undefined;
      await refreshState();
      requestAnimationFrame(() => toggle.current?.focus());
    },
  });

  useEffect(() => {
    if (revoking) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  }, [revoking]);
  const busy = activate.isPending || revoke.isPending;

  return (
    <section aria-label="의미 검색 준비" className="mb-4">
      <div className="flex justify-end">
        <Button
          ref={toggle}
          variant="ghost"
          aria-expanded={open}
          aria-controls="embedding-settings"
          className="text-text-muted"
          onClick={() => setOpen(!open)}
        >
          <SlidersHorizontal aria-hidden="true" />
          AI 검색 설정
          <ChevronDown aria-hidden="true" className={open ? 'rotate-180' : undefined} />
        </Button>
      </div>
      <div
        id="embedding-settings"
        hidden={!open}
        className="mt-3 space-y-4 rounded-xl border border-paper-rule bg-surface p-5 text-sm leading-6 sm:p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <h2 className="font-medium">AI 검색</h2>
            <InfoHint label="AI 검색 안내">
              저장한 본문을 의미로 찾을 수 있게 준비합니다. 한 번 켜면 기존 자료와 이후 저장·수정한
              자료를 자동으로 처리하며, 자료 저장은 기다리지 않아도 됩니다.
            </InfoHint>
          </div>
          {preview.isFetching && <p role="status">준비 상태를 확인하는 중…</p>}
          {preview.isError && (
            <p role="alert" className="text-status-error">
              준비 상태를 확인하지 못했습니다. 자료 저장과 키워드 검색은 계속 사용할 수 있습니다.
            </p>
          )}
          <Button
            variant="ghost"
            disabled={busy || preview.isFetching}
            onClick={() => {
              request.current = undefined;
              activate.reset();
              void preview.refetch();
            }}
          >
            <RotateCw aria-hidden="true" />
            {preview.isFetching ? '확인 중…' : '상태 새로고침'}
          </Button>
        </div>
        {data && !data.configured && (
          <p>AI 검색을 아직 사용할 수 없습니다. 설정 후 다시 확인해 주세요.</p>
        )}
        {data?.policy && (
          <>
            <p className="text-text-muted">
              {data.automatic && data.includeExisting
                ? '사용 중 · 기존 자료와 새로 저장·수정한 본문을 자동으로 준비합니다.'
                : '한 번 켜면 기존 자료와 새로 저장·수정한 본문을 자동으로 준비합니다.'}
            </p>
            <details>
              <summary className="w-fit cursor-pointer py-3 text-text-muted underline underline-offset-4">
                자료별 준비 상태
              </summary>
              <ul className="divide-y divide-paper-rule">
                {data.states.map((item) => (
                  <li
                    key={item.materialId}
                    className="flex flex-wrap items-center justify-between gap-2 py-3"
                  >
                    <Link
                      href={`/documents/${item.materialId}`}
                      className="inline-flex min-h-11 items-center underline underline-offset-4"
                    >
                      {item.title || '제목 없는 자료'}
                    </Link>
                    <span className="rounded border border-paper-rule px-2 py-1 text-sm text-paper-accent">
                      {stateLabels[item.state]}
                    </span>
                    {item.state === 'FINAL_FAILED' && (
                      <span className="w-full text-status-error">
                        준비하지 못했습니다. 한도와 연결을 확인한 뒤 명시적으로 재시도할 수
                        있습니다.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {data.states.length === 0 && <p>이 범위에 준비할 자료가 없습니다.</p>}
              <div className="flex flex-wrap gap-2">
                {afterId && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setAfterId(undefined);
                      request.current = undefined;
                    }}
                  >
                    처음 자료 보기
                  </Button>
                )}
                {data.nextCursor && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setAfterId(data.nextCursor ?? undefined);
                      request.current = undefined;
                    }}
                  >
                    다음 자료 보기
                  </Button>
                )}
              </div>
            </details>
            <AiNotice
              firstUse={!data.consented}
              summary="자료 본문과 의미 검색어를 Google에 보냅니다."
              notice={data.policy.retentionNotice}
            >
              <p>
                제목·메모·맥락·출처 URL은 보내지 않습니다. 월 사용 한도에 도달하면 AI만 일시
                중단합니다.
              </p>
            </AiNotice>
            <fieldset
              disabled={busy || preview.isError || preview.isFetching}
              className="space-y-4"
            >
              <div className="flex flex-wrap gap-3">
                {(!data.automatic || !data.includeExisting) && (
                  <Button
                    type="button"
                    onClick={() => activate.mutate(false)}
                    variant="primary"
                    disabled={activate.isError && request.current?.retryFailed === true}
                  >
                    {data.consented ? '기존 자료도 자동 준비하기' : 'AI 검색 사용하기'}
                  </Button>
                )}
                {data.states.some((item) => item.state === 'FINAL_FAILED') && (
                  <Button
                    type="button"
                    disabled={activate.isError && request.current?.retryFailed === false}
                    onClick={() => activate.mutate(true)}
                  >
                    {data.consented ? '실패한 자료 다시 준비' : 'Google에 보내 다시 준비'}
                  </Button>
                )}
              </div>
            </fieldset>
            {activate.isPending && <p role="status">준비 요청을 보내는 중…</p>}
            {activate.isSuccess && (
              <p role="status">
                요청을 반영했습니다. 준비하는 동안에도 자료를 저장하고 검색할 수 있습니다.
              </p>
            )}
            {activate.isError && (
              <p role="alert" className="text-status-error">
                {failureMessage(activate.error)}
              </p>
            )}
            {data.consented && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  revoke.reset();
                  revokeEpoch.current = undefined;
                  setRevoking(true);
                }}
              >
                AI 검색 끄기
              </Button>
            )}
          </>
        )}
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="revoke-consent-title"
        aria-describedby="revoke-consent-description"
        onCancel={(event) => {
          event.preventDefault();

          if (!revoke.isPending) {
            setRevoking(false);
          }
        }}
        className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-border-subtle bg-surface p-6 text-text-primary backdrop:bg-black/40"
      >
        <h2 id="revoke-consent-title" className="text-xl font-semibold">
          AI 검색을 끌까요?
        </h2>
        <p id="revoke-consent-description" className="mt-4 text-sm leading-6">
          자동 준비와 의미 검색을 중단합니다. 원문과 키워드 검색은 유지되며, 이미 Google로 보낸
          자료는 회수할 수 없습니다.
        </p>
        {revoke.isError && (
          <p role="alert" className="mt-4 text-status-error">
            {failureMessage(revoke.error)}
          </p>
        )}
        {revoke.isPending && <p role="status">AI 검색을 끄는 중…</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button autoFocus disabled={revoke.isPending} onClick={() => setRevoking(false)}>
            취소
          </Button>
          <Button disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {revoke.isPending ? '끄는 중…' : 'AI 검색 끄기 확인'}
          </Button>
        </div>
      </dialog>
    </section>
  );
}
