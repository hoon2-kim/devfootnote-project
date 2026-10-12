'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { MessageSquare, X, ArrowUp } from 'lucide-react';
import {
  generateAnswer,
  getAnswerConfiguration,
  grantAnswerConsent,
  readAnswer,
  revokeAnswerConsent,
  type AnswerResultDto,
  type GenerateAnswerDto,
} from '@devfootnote/api-client';
import { Button } from '../../components/ui/button';
import { AiNotice } from '../../components/ai-notice';
import { Textarea } from '../../components/ui/form-field';
import { ApiError, unwrapApiResult } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-provider';
import { useOwnerId } from '../auth';
import { answerResultKey, useAnswerEvents } from './use-answer-events';

const questionSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, '질문을 입력해 주세요.')
    .max(2000, '질문은 2,000자 이내로 입력해 주세요.'),
});

const stateMessages = {
  REQUESTED: '질문을 확인하고 있습니다.',
  RESERVED: '답변을 준비하고 있습니다.',
  RUNNING: '자료를 읽고 답변을 작성하고 있습니다.',
  PUBLISHED: '자료를 근거로 작성한 답변입니다.',
  NO_ANSWER: '이 자료에서는 답을 찾을 수 없어요. 자료 내용에 관해 질문해 주세요.',
  FAILED: '답변을 만들지 못했습니다. 저장한 자료는 계속 읽을 수 있습니다.',
  EXPIRED: '답변의 보관 또는 처리 기한이 끝났습니다. 같은 요청으로 AI를 다시 호출하지 않습니다.',
  INVALIDATED: '자료나 동의 상태가 바뀌어 이전 답변을 숨겼습니다.',
} satisfies Record<AnswerResultDto['state'], string>;

function isPending(state: AnswerResultDto['state']) {
  return state === 'REQUESTED' || state === 'RESERVED' || state === 'RUNNING';
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409) {
    return '자료나 동의 상태가 변경되었습니다. 최신 상태를 확인한 뒤 새 대화를 시작해 주세요.';
  }

  if (error instanceof ApiError && error.status === 429) {
    return '답변 사용 한도에 도달했습니다. 검색과 원문은 계속 볼 수 있습니다.';
  }

  return '요청 결과를 확인하지 못했습니다. 연결을 확인하고 같은 요청으로 다시 확인해 주세요.';
}

type Turn = { request: GenerateAnswerDto; accepted: boolean };

export function AnswerPanel({
  material,
}: {
  material: { id: string; revisionId: string; revision: number; title: string | null };
}) {
  const ownerId = useOwnerId();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const configurationKey = ['private', ownerId, 'answers', 'configuration'];
  const resultsKey = ['private', ownerId, 'answers', 'results'];
  const configuration = useQuery({
    queryKey: configurationKey,
    queryFn: async ({ signal }) =>
      unwrapApiResult(await getAnswerConfiguration({ client, signal })),
  });
  const policy = configuration.data?.policy;
  const consented = !configuration.isError && configuration.data?.consented;
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [revoking, setRevoking] = useState(false);
  const revokeDialog = useRef<HTMLDialogElement>(null);
  const revokeTrigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const question = useForm({
    resolver: zodResolver(questionSchema),
    defaultValues: { question: '' },
  });
  const consentRequest = useRef<
    { expectedConsentEpoch: number; policyFingerprint: string; accepted: true } | undefined
  >(undefined);
  const revokeEpoch = useRef<number | undefined>(undefined);
  const previousConsentEpoch = useRef<number | undefined>(undefined);
  const grant = useMutation({
    mutationFn: async () => {
      if (!configuration.data?.policy || configuration.isError) {
        throw new ApiError(409);
      }

      consentRequest.current ??= {
        expectedConsentEpoch: configuration.data.consentEpoch,
        policyFingerprint: configuration.data.policy.fingerprint,
        accepted: true,
      };

      return unwrapApiResult(await grantAnswerConsent({ client, body: consentRequest.current }));
    },
    onSuccess: async () => {
      consentRequest.current = undefined;
      await queryClient.invalidateQueries({ queryKey: configurationKey });
    },
  });
  const submit = useMutation({
    retry: false,
    mutationFn: async (request: GenerateAnswerDto) => {
      // 첫 전송 버튼이 승인을 겸한다. 펼치기나 재연결은 승인·생성 요청을 만들지 않는다.
      if (!consented || consentRequest.current) {
        await grant.mutateAsync();
      }

      return unwrapApiResult(await generateAnswer({ client, body: request }));
    },
    onSuccess: (data) => {
      setTurns((current) =>
        current.map((turn) =>
          turn.request.requestId === data.requestId ? { ...turn, accepted: true } : turn,
        ),
      );
      question.reset();
    },
  });
  const results = useQueries({
    queries: turns.map((turn) => ({
      queryKey: answerResultKey(ownerId, turn.request.requestId, configuration.data?.consentEpoch),
      enabled: turn.accepted && Boolean(consented),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        unwrapApiResult(
          await readAnswer({
            client,
            signal,
            path: { requestId: turn.request.requestId },
          }),
        ),
      // 지난 답변도 focus/invalidate 때 현재 접근 가능 여부를 다시 확인한다.
      // 질문만 로컬에 유지하고 답변 본문은 서버가 검증한 request ID에서 복원한다.
    })),
  });
  const latest = turns.at(-1);
  const latestResult = results.at(-1);
  const latestAnswer = consented && !latestResult?.isError ? latestResult?.data : undefined;
  const waiting = Boolean(
    latest?.accepted && !latestResult?.isError && (!latestAnswer || isPending(latestAnswer.state)),
  );
  const pending = submit.isPending || waiting;
  const events = useAnswerEvents({
    ownerId,
    requestId: latest?.request.requestId,
    consentEpoch: configuration.data?.consentEpoch,
    enabled: Boolean(
      consented &&
      latest?.accepted &&
      latestAnswer &&
      isPending(latestAnswer.state) &&
      !latestResult?.isError,
    ),
  });
  const revoke = useMutation({
    mutationFn: async () => {
      if (!configuration.data) {
        throw new ApiError(409);
      }

      revokeEpoch.current ??= configuration.data.consentEpoch;

      return unwrapApiResult(
        await revokeAnswerConsent({ client, body: { expectedConsentEpoch: revokeEpoch.current } }),
      );
    },
    onSuccess: async () => {
      setRevoking(false);
      setTurns([]);
      question.reset();
      submit.reset();
      await queryClient.cancelQueries({ queryKey: resultsKey });
      queryClient.removeQueries({ queryKey: resultsKey });
      await queryClient.invalidateQueries({ queryKey: configurationKey });
      requestAnimationFrame(() => heading.current?.focus());
    },
  });

  useEffect(() => {
    if (open) {
      drawer.current?.showModal();
    } else {
      drawer.current?.close();
    }
  }, [open]);

  useEffect(() => {
    if (revoking) {
      revokeDialog.current?.showModal();
    } else {
      revokeDialog.current?.close();
    }
  }, [revoking]);

  useEffect(() => {
    if (open && turns.length > 0) {
      conversationEnd.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, turns.length, latestAnswer?.state]);

  useEffect(() => {
    const data = configuration.data;

    if (!data || configuration.isError) {
      return;
    }

    if (
      previousConsentEpoch.current !== undefined &&
      previousConsentEpoch.current !== data.consentEpoch &&
      !data.consented
    ) {
      setTurns([]);
      question.reset();
    }

    previousConsentEpoch.current = data.consentEpoch;
  }, [configuration.data, configuration.isError, question]);

  const resetConversation = () => {
    setTurns([]);
    consentRequest.current = undefined;
    grant.reset();
    submit.reset();
    question.reset();
    void configuration.refetch();
    requestAnimationFrame(() => question.setFocus('question'));
  };

  return (
    <>
      <Button
        ref={trigger}
        variant="primary"
        aria-expanded={open}
        aria-controls="answer-drawer"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="fixed right-5 bottom-5 z-30 shadow-md sm:right-8 sm:bottom-8"
      >
        <MessageSquare aria-hidden="true" /> 자료에 질문하기
      </Button>
      <dialog
        ref={drawer}
        id="answer-drawer"
        aria-labelledby="answer-title"
        onCancel={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }

          event.preventDefault();
          setOpen(false);
        }}
        onClose={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }

          setOpen(false);
          trigger.current?.focus();
        }}
        className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-full border-l border-paper-rule bg-paper-canvas p-0 text-text-primary shadow-xl backdrop:bg-black/15 sm:w-[480px]"
      >
        <section aria-labelledby="answer-title" className="flex min-h-full flex-col">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-paper-rule bg-paper-canvas px-5 py-4">
            <div className="min-w-0">
              <h2 ref={heading} id="answer-title" tabIndex={-1} className="text-base font-medium">
                자료에 질문하기
              </h2>
              <p className="mt-1 truncate text-sm text-text-muted">
                {material.title || '제목 없는 자료'} · 버전 {material.revision}
              </p>
            </div>
            <Button
              variant="ghost"
              autoFocus
              aria-label="질문 접기"
              title="질문 접기"
              onClick={() => setOpen(false)}
              className="px-2"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          {/* 숨기기는 취소가 아니다. 질문·요청 ID·SSE는 유지하고 자료 revision이 바뀌면 부모가 새 대화를 만든다. */}
          <div id="answer-workspace" className="flex flex-1 flex-col p-5">
            <p id="answer-help" className="text-sm leading-6 text-text-secondary">
              이 자료에 대해 물어보세요. 최근 세 번의 답변을 이어서 이야기할 수 있어요.
            </p>
            {configuration.isFetching && (
              <p role="status" className="mt-3">
                답변 설정을 확인하는 중…
              </p>
            )}
            {configuration.isError && (
              <div className="mt-4">
                <p role="alert">답변 설정을 확인하지 못했습니다. 원문은 계속 볼 수 있습니다.</p>
                <Button
                  disabled={configuration.isFetching}
                  onClick={() => void configuration.refetch()}
                >
                  답변 설정 다시 확인
                </Button>
              </div>
            )}
            {configuration.data && !configuration.data.configured && (
              <p className="mt-4">
                답변 모델 설정이 아직 준비되지 않았습니다. 검색과 원문 읽기는 계속 사용할 수
                있습니다.
              </p>
            )}
            <div aria-label="이 자료의 대화" className="space-y-5 py-6">
              {turns.map((turn, index) => {
                const result = results[index];
                const answer = consented && !result?.isError ? result?.data : undefined;

                return (
                  <div key={turn.request.requestId} className="space-y-3">
                    <div className="ml-8 rounded-2xl rounded-tr-sm bg-paper-hover p-4">
                      <p className="mb-1 text-sm text-text-muted">내 질문</p>
                      <p className="whitespace-pre-wrap break-words">{turn.request.question}</p>
                    </div>
                    {result?.isError && (
                      <div className="space-y-3">
                        <p role="alert" className="text-status-error">
                          답변의 최신 상태를 확인하지 못해 내용을 숨겼습니다. 다시 확인해 주세요.
                        </p>
                        <Button
                          disabled={result.isFetching || !consented}
                          onClick={() => void result.refetch()}
                        >
                          {result.isFetching ? '답변 확인 중…' : '답변 상태 다시 확인'}
                        </Button>
                      </div>
                    )}
                    {turn.accepted && result?.isPending && (
                      <p role="status">답변 상태를 확인하는 중…</p>
                    )}
                    {answer && (
                      <div
                        className="mr-3 space-y-3 rounded-2xl rounded-tl-sm border border-paper-rule bg-surface p-4"
                        aria-busy={isPending(answer.state)}
                      >
                        <p className="text-sm font-medium text-paper-accent">자료 답변</p>
                        <p role="status" className="text-sm text-text-secondary">
                          {stateMessages[answer.state]}
                        </p>
                        {answer.state === 'PUBLISHED' &&
                          answer.claims.map((claim, claimIndex) => (
                            <div key={claimIndex} className="space-y-2">
                              <p className="whitespace-pre-wrap break-words leading-7">
                                {claim.text}
                              </p>
                              <ul
                                className="flex flex-wrap gap-3"
                                aria-label={`답변 ${index + 1}-${claimIndex + 1}의 출처`}
                              >
                                {claim.evidenceIds.map((id) => {
                                  const citation = answer.citations.find(
                                    (item) => item.evidenceId === id,
                                  );

                                  return citation ? (
                                    <li key={id}>
                                      <Link
                                        href={citation.href}
                                        onClick={() => setOpen(false)}
                                        className="inline-flex min-h-11 items-center underline"
                                      >
                                        출처 {answer.citations.indexOf(citation) + 1} 원문 보기
                                      </Link>
                                    </li>
                                  ) : null;
                                })}
                              </ul>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {submit.isPending && (
              <p role="status" className="mb-4">
                답변 요청을 보내는 중…
              </p>
            )}
            {submit.isError && latest && !latest.accepted && (
              <div className="mb-4 space-y-3">
                <p role="alert" className="text-status-error">
                  {errorMessage(submit.error)}
                </p>
                <Button
                  disabled={configuration.isError || !policy || submit.isPending}
                  onClick={() => submit.mutate(latest.request)}
                >
                  같은 요청 다시 확인
                </Button>
              </div>
            )}
            {events.disconnected && (
              <div className="mb-4 space-y-3">
                <p role="alert">실시간 연결이 끊겼습니다. 같은 답변의 상태를 다시 확인해 주세요.</p>
                <Button
                  disabled={latestResult?.isFetching}
                  onClick={async () => {
                    const result = await latestResult?.refetch();

                    if (result?.isSuccess && isPending(result.data.state)) {
                      events.reconnect();
                    }
                  }}
                >
                  답변 연결 다시 확인
                </Button>
              </div>
            )}
            <div ref={conversationEnd} />
            <form
              className="mt-auto space-y-4 border-t border-paper-rule pt-5"
              onSubmit={question.handleSubmit((values) => {
                const history = turns
                  .flatMap((turn, index) =>
                    results[index]?.data?.state === 'PUBLISHED' && !results[index]?.isError
                      ? [{ requestId: turn.request.requestId, question: turn.request.question }]
                      : [],
                  )
                  .slice(-3);
                const request: GenerateAnswerDto = {
                  requestId: crypto.randomUUID(),
                  question: values.question,
                  evidence: [{ materialId: material.id, revisionId: material.revisionId }],
                  history,
                };

                setTurns((current) => [...current, { request, accepted: false }]);
                submit.mutate(request);
              })}
            >
              <fieldset
                disabled={
                  !policy ||
                  !configuration.data?.configured ||
                  configuration.isError ||
                  configuration.isFetching ||
                  pending ||
                  Boolean(latest && !latest.accepted) ||
                  results.some((result) => result.isError) ||
                  revoke.isPending
                }
                className="space-y-3"
              >
                <label htmlFor="answer-question" className="block text-sm font-medium">
                  자료에 관해 궁금한 점
                </label>
                <Textarea
                  id="answer-question"
                  rows={3}
                  maxLength={2000}
                  {...question.register('question')}
                  placeholder={
                    turns.length ? '이어서 질문해 보세요' : '이 자료를 쉽게 설명해 줄래?'
                  }
                  aria-describedby="answer-help answer-question-error"
                  aria-invalid={Boolean(question.formState.errors.question)}
                />
                <p
                  id="answer-question-error"
                  role={question.formState.errors.question ? 'alert' : undefined}
                  className="text-status-error"
                >
                  {question.formState.errors.question?.message}
                </p>
                {policy && (
                  <AiNotice
                    firstUse={!consented}
                    summary="본문과 질문을 Google에 전송합니다."
                    notice={policy.retentionNotice}
                  >
                    <p>
                      답변·출처는 {policy.answerRetentionSeconds / 86400}일 보관합니다. 대화는 이
                      화면을 떠나거나 자료를 수정하면 초기화됩니다. 근거가 바뀌거나 AI 답변을 끄면
                      이전 답변은 숨깁니다.
                    </p>
                  </AiNotice>
                )}
                <Button type="submit" variant="primary" className="w-full">
                  {consented ? '질문 보내기' : 'Google에 보내 질문하기'}
                  <ArrowUp aria-hidden="true" />
                </Button>
              </fieldset>
            </form>
            <div className="mt-4 flex flex-wrap gap-2">
              {turns.length > 0 && (
                <Button
                  variant="ghost"
                  disabled={submit.isPending || waiting}
                  onClick={resetConversation}
                >
                  새 대화
                </Button>
              )}
              {consented && (
                <Button
                  variant="ghost"
                  ref={revokeTrigger}
                  disabled={revoke.isPending}
                  onClick={() => {
                    revoke.reset();
                    revokeEpoch.current = undefined;
                    setRevoking(true);
                  }}
                >
                  AI 답변 끄기
                </Button>
              )}
            </div>
          </div>
          <dialog
            ref={revokeDialog}
            aria-labelledby="answer-revoke-title"
            aria-describedby="answer-revoke-description"
            onCancel={(event) => {
              event.preventDefault();

              if (!revoke.isPending) {
                setRevoking(false);
              }
            }}
            onClose={() => revokeTrigger.current?.focus()}
            className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-border-subtle bg-surface p-6 text-text-primary backdrop:bg-black/40"
          >
            <h2 id="answer-revoke-title" className="text-xl font-semibold">
              AI 답변을 끌까요?
            </h2>
            <p id="answer-revoke-description" className="mt-4 leading-6">
              새 답변 전송과 기존 답변 접근을 중단합니다. 이미 Google로 전송한 내용을 회수하지는
              못합니다. 저장한 자료와 검색은 유지됩니다.
            </p>
            {revoke.isError && (
              <p role="alert" className="mt-4 text-status-error">
                {errorMessage(revoke.error)}
              </p>
            )}
            {revoke.isPending && (
              <p role="status" className="mt-4">
                AI 답변을 끄는 중…
              </p>
            )}
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Button autoFocus disabled={revoke.isPending} onClick={() => setRevoking(false)}>
                취소
              </Button>
              <Button disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                {revoke.isPending ? '끄는 중…' : 'AI 답변 끄기 확인'}
              </Button>
            </div>
          </dialog>
        </section>
      </dialog>
    </>
  );
}
