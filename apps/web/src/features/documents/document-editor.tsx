'use client';

import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getMaterial, updateMaterial, type MaterialDetailDto } from '@devfootnote/api-client';
import { Button } from '../../components/ui/button';
import { ApiError, unwrapApiResult } from '../../lib/api-client';
import { useApiClient } from '../../lib/api-provider';
import { gowunBatang } from '../../lib/fonts';
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

  const reload = useMutation({
    mutationFn: async () => {
      const result = await getMaterial({ client, path: { materialId: material.id } });

      return unwrapApiResult(result);
    },
    onSuccess: (latest) => {
      // 명시적 조회가 성공한 경우에만 초안과 기대 버전을 함께 교체한다.
      form.reset(formValues(latest));
      setExpectedRevisionId(latest.revisionId);
      request.current = undefined;
      save.reset();
    },
  });

  // 늦은 조회 응답이 조회 시작 뒤의 새 입력·저장과 경합하지 않게 한다.
  const busy = save.isPending || reload.isPending;

  return (
    <section
      aria-labelledby="edit-title"
      className="mb-10 border border-paper-rule bg-surface p-5 sm:p-8"
    >
      <h2 id="edit-title" className={`${gowunBatang.className} mb-8 text-2xl`}>
        자료 수정
      </h2>
      <form
        noValidate
        onSubmit={form.handleSubmit((values) => save.mutate(values))}
        className="space-y-5"
      >
        <MaterialFields form={form} disabled={busy} />
        {save.isError && (
          <div role="alert" className="space-y-3 text-sm text-status-error">
            <p>
              {save.error instanceof ApiError && save.error.code === 'MATERIAL_REVISION_CONFLICT'
                ? '다른 곳에서 자료가 변경되었습니다. 입력은 보존했습니다. 최신 내용을 확인한 뒤 다시 편집해 주세요.'
                : '수정하지 못했습니다. 입력은 보존했습니다. 연결과 로그인 상태를 확인한 뒤 재시도해 주세요.'}
            </p>
            {save.error instanceof ApiError && save.error.status === 409 && (
              <Button type="button" disabled={busy} onClick={() => reload.mutate()}>
                {reload.isPending ? '최신 내용 불러오는 중…' : '입력을 버리고 최신 내용 불러오기'}
              </Button>
            )}
          </div>
        )}
        {reload.isPending && <p role="status">최신 내용을 불러오고 있습니다.</p>}
        {reload.isError && (
          <p role="alert" className="text-status-error">
            최신 내용을 불러오지 못했습니다. 입력은 그대로 유지됩니다.
          </p>
        )}
        <div className="flex gap-3">
          <Button type="submit" variant="primary" disabled={busy}>
            {save.isPending ? '저장 중…' : '수정 저장'}
          </Button>
          <Button type="button" disabled={busy} onClick={onClose}>
            편집 취소
          </Button>
        </div>
      </form>
    </section>
  );
}
