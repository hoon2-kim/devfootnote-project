import type { UseFormReturn } from 'react-hook-form';
import { FormField, Input, Textarea } from '../../components/ui/form-field';
import type { MaterialFormValues } from './material-form.schema';

export function MaterialFields({
  form,
  disabled,
}: {
  form: UseFormReturn<MaterialFormValues>;
  disabled: boolean;
}) {
  const { errors } = form.formState;

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-5">
      <FormField id="material-title" label="제목 (선택)" error={errors.title?.message}>
        <Input
          id="material-title"
          {...form.register('title')}
          aria-invalid={!!errors.title}
          aria-describedby="material-title-help"
          placeholder="다시 찾기 쉬운 제목"
        />
      </FormField>
      <FormField
        id="material-body"
        label="원문"
        hint="Markdown 지원 · 최대 10,000자"
        error={errors.body?.message}
      >
        <Textarea
          id="material-body"
          {...form.register('body')}
          aria-invalid={!!errors.body}
          aria-describedby="material-body-help"
          rows={8}
          placeholder="기억해 둘 본문이나 기술 메모를 붙여 넣으세요"
        />
      </FormField>
      <FormField id="material-note" label="나의 메모 (선택)" error={errors.note?.message}>
        <Textarea
          id="material-note"
          {...form.register('note')}
          aria-invalid={!!errors.note}
          aria-describedby="material-note-help"
          rows={3}
          placeholder="왜 저장했는지, 어떤 점이 유용했는지"
        />
      </FormField>
      <FormField id="material-context" label="사용 맥락 (선택)" error={errors.context?.message}>
        <Input
          id="material-context"
          {...form.register('context')}
          aria-invalid={!!errors.context}
          aria-describedby="material-context-help"
          placeholder="예: 결제 중복 요청을 처리하던 중"
        />
      </FormField>
      <FormField id="material-source" label="출처 URL (선택)" error={errors.sourceUrl?.message}>
        <Input
          id="material-source"
          type="url"
          {...form.register('sourceUrl')}
          aria-invalid={!!errors.sourceUrl}
          aria-describedby="material-source-help"
          placeholder="https://"
        />
      </FormField>
    </fieldset>
  );
}
