'use client';

import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getMaterial, updateMaterial, type MaterialDetailDto } from '@devfootnote/api-client';
import { Button } from '../../components/ui/button';
import { ApiError, unwrapApiResult } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-provider';
import {
  MaterialFields,
  materialFormSchema,
  materialKeys,
  invalidateMaterialCollections,
  applyMaterialFormErrors,
  type MaterialFormValues,
} from '../library';

function formValues(material: MaterialDetailDto): MaterialFormValues {
  return {
    title: material.title ?? '',
    body: material.body,
    note: material.note ?? '',
    context: material.context ?? '',
    sourceUrl: material.sourceUrl ?? '',
  };
}

export function DocumentEditor({
  material,
  ownerId,
  onClose,
}: {
  material: MaterialDetailDto;
  ownerId: string;
  onClose: () => void;
}) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const form = useForm({
    resolver: zodResolver(materialFormSchema),
    defaultValues: formValues(material),
  });
  // 편집을 시작한 버전을 고정한다. background 조회로 props가 바뀌어도 초안의 기준을 바꾸지 않는다.
  const [expectedRevisionId, setExpectedRevisionId] = useState(material.revisionId);
  const request = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const [reloadError, setReloadError] = useState(false);
  const save = useMutation({
    mutationFn: async (values: MaterialFormValues) => {
      const body = { ...values, sourceUrl: values.sourceUrl || undefined, expectedRevisionId };
      const fingerprint = JSON.stringify(body);

      // 응답 유실 재시도는 같은 key를 쓰고, 내용이나 기대 버전이 바뀐 경우에만 새 요청으로 보낸다.
      if (request.current?.fingerprint !== fingerprint) {
        request.current = { fingerprint, key: crypto.randomUUID() };
      }

      const result = await updateMaterial({
        client,
        path: { materialId: material.id },
        body: { ...body, idempotencyKey: request.current.key },
      });

      return unwrapApiResult(result);
    },
    onSuccess: async () => {
      await Promise.all([
        invalidateMaterialCollections(queryClient, ownerId),
        queryClient.invalidateQueries({
          queryKey: materialKeys.current(ownerId, material.id),
        }),
      ]);
      onClose();
    },
    onError: (error) => {
      applyMaterialFormErrors(error, form);
    },
  });

  async function loadLatest() {
    setReloadError(false);
    const result = await getMaterial({ client, path: { materialId: material.id } });

    if (!result.data) {
      setReloadError(true);

      return;
    }

    // 사용자가 최신 내용 불러오기를 선택하고 조회에도 성공한 경우에만 초안·기대 버전을 교체한다.
    form.reset(formValues(result.data.data));
    setExpectedRevisionId(result.data.data.revisionId);
    request.current = undefined;
    save.reset();
  }

  return (
    <section
      aria-labelledby="edit-title"
      className="mb-8 rounded-xl border border-border-subtle bg-surface p-6 sm:p-8"
    >
      <h2 id="edit-title" className="mb-6 text-xl font-semibold">
        자료 수정
      </h2>
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => save.mutate(values))}
        className="space-y-5"
      >
        <MaterialFields form={form} disabled={save.isPending} />
        {save.isError && (
          <div role="alert" className="space-y-3 text-sm text-status-error">
            <p>
              {save.error instanceof ApiError && save.error.code === 'MATERIAL_REVISION_CONFLICT'
                ? '다른 곳에서 자료가 변경되었습니다. 입력은 보존했습니다. 최신 내용을 확인한 뒤 다시 편집해 주세요.'
                : '수정하지 못했습니다. 입력은 보존했습니다. 연결과 로그인 상태를 확인한 뒤 재시도해 주세요.'}
            </p>
            {save.error instanceof ApiError && save.error.status === 409 && (
              <Button type="button" onClick={() => void loadLatest()}>
                입력을 버리고 최신 내용 불러오기
              </Button>
            )}
          </div>
        )}
        {reloadError && (
          <p role="alert" className="text-status-error">
            최신 내용을 불러오지 못했습니다. 입력은 그대로 유지됩니다.
          </p>
        )}
        <div className="flex gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? '저장 중…' : '수정 저장'}
          </Button>
          <Button type="button" disabled={save.isPending} onClick={onClose}>
            편집 취소
          </Button>
        </div>
      </form>
    </section>
  );
}
