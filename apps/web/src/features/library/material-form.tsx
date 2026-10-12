'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createMaterial } from '@devfootnote/api-client';
import { LoaderCircle, Plus, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { MaterialFields } from './material-fields';
import { ApiError, unwrapApiResult } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-provider';
import {
  emptyMaterialForm,
  materialFormSchema,
  type MaterialFormValues,
} from './material-form.schema';
import { invalidateMaterialCollections } from './material-queries';
import { applyMaterialFormErrors } from './material-form.errors';
import { gowunBatang } from '../../lib/fonts';

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401:
        return '로그인이 만료되었습니다. 새 탭에서 다시 로그인한 뒤 이 화면에서 재시도해 주세요. 입력은 유지됩니다.';
      case 409:
        return '같은 요청 ID의 저장 내용이 다릅니다. 자료 목록을 확인한 뒤 내용을 수정해 주세요.';
      case 400:
        return '입력 내용을 확인해 주세요. 작성한 내용은 유지됩니다.';
    }
  }

  return '저장을 확인하지 못했습니다. 연결과 쿠키 설정을 확인한 뒤 다시 저장해 주세요. 입력은 유지됩니다.';
}

// 패널을 접을 때도 마운트를 유지하고 hidden으로 가린다. 초안·오류·재시도 key를 보존하기 위해서다.
export function MaterialForm({
  ownerId,
  open,
  onClose,
}: {
  ownerId: string;
  open: boolean;
  onClose: () => void;
}) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const form = useForm({
    resolver: zodResolver(materialFormSchema),
    defaultValues: emptyMaterialForm,
  });
  const pendingRequest = useRef<{ input: string; key: string } | undefined>(undefined);
  const [savedId, setSavedId] = useState<string>();
  const { setFocus } = form;

  useEffect(() => {
    if (open) {
      setFocus('title');
    }
  }, [open, setFocus]);

  const save = useMutation({
    mutationFn: async (values: MaterialFormValues) => {
      const body = { ...values, sourceUrl: values.sourceUrl || undefined };
      const input = JSON.stringify(body);

      // 응답 유실 후 같은 내용은 같은 key로 재시도하고, 사용자가 내용을 바꿀 때만 새 요청이다.
      if (pendingRequest.current?.input !== input) {
        pendingRequest.current = { input, key: crypto.randomUUID() };
      }

      const result = await createMaterial({
        client,
        body: { ...body, idempotencyKey: pendingRequest.current.key },
      });

      return unwrapApiResult(result);
    },
    onSuccess: (result) => {
      pendingRequest.current = undefined;
      setSavedId(result.id);
      form.reset(emptyMaterialForm);
      void invalidateMaterialCollections(queryClient, ownerId);
    },
    onError: (error) => {
      applyMaterialFormErrors(error, form);
    },
  });

  return (
    <section
      id="new-material"
      hidden={!open}
      aria-labelledby="save-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !save.isPending) {
          event.preventDefault();
          onClose();
        }
      }}
      className="mb-10 border border-paper-rule bg-surface p-5 sm:p-8"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="save-title" className={`${gowunBatang.className} text-2xl`}>
            새 자료 남기기
          </h2>
          <p className="mt-2 text-sm leading-6 text-paper-muted">원문만 있어도 저장할 수 있어요.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          disabled={save.isPending}
          onClick={onClose}
          aria-label="작성 패널 닫기"
          className="shrink-0"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => {
          setSavedId(undefined);
          save.mutate(values);
        })}
        className="mt-8 space-y-6"
      >
        <MaterialFields form={form} disabled={save.isPending} />
        {save.isError && (
          <p role="alert" className="text-sm leading-6 text-status-error">
            {saveErrorMessage(save.error)}
            {save.error instanceof ApiError && save.error.status === 401 && (
              <a
                href="/login"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center px-2 underline"
              >
                새 탭에서 로그인
              </a>
            )}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-4 border-t border-paper-rule pt-6">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? (
              <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
            ) : (
              <Plus aria-hidden="true" />
            )}
            {save.isPending ? '저장 중…' : '자료 저장'}
          </Button>
          <div role="status" className="text-sm text-status-success">
            {savedId && (
              <>
                저장했습니다.{' '}
                <Link
                  href={`/documents/${savedId}`}
                  className="inline-flex min-h-11 items-center underline"
                >
                  저장한 자료 읽기
                </Link>
              </>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
