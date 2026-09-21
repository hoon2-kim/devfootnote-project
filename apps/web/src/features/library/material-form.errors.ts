import type { UseFormReturn } from 'react-hook-form';
import { ApiError } from '../../lib/api-client';
import type { MaterialFormValues } from './material-form.schema';

export function applyMaterialFormErrors(
  error: unknown,
  form: Pick<UseFormReturn<MaterialFormValues>, 'setError' | 'setFocus'>,
) {
  if (!(error instanceof ApiError)) {
    return;
  }

  const fieldsWithErrors = new Set<keyof MaterialFormValues>();

  for (const issue of error.issues) {
    if (
      issue.field === 'body' ||
      issue.field === 'title' ||
      issue.field === 'note' ||
      issue.field === 'context' ||
      issue.field === 'sourceUrl'
    ) {
      form.setError(issue.field, { message: issue.message });
      fieldsWithErrors.add(issue.field);
    }
  }

  const fieldOrder: (keyof MaterialFormValues)[] = [
    'title',
    'body',
    'note',
    'context',
    'sourceUrl',
  ];
  const firstField = fieldOrder.find((field) => fieldsWithErrors.has(field));

  if (firstField) {
    // onError 중에는 fieldset이 아직 disabled다. mutation 상태가 반영된 다음 focus한다.
    requestAnimationFrame(() => form.setFocus(firstField));
  }
}
