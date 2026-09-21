import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .max(max, `${max.toLocaleString()}자 이하로 입력해 주세요.`)
    .refine((value) => !value.includes('\0'), '사용할 수 없는 문자가 포함되어 있습니다.');

export const materialFormSchema = z.object({
  title: text(200),
  body: text(10000).refine((value) => value.trim().length > 0, '원문을 입력해 주세요.'),
  note: text(2000),
  context: text(1000),
  sourceUrl: text(2048).refine((value) => {
    if (!value) {
      return true;
    }

    try {
      const url = new URL(value);

      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'http 또는 https 출처 주소를 입력해 주세요.'),
});

export type MaterialFormValues = z.infer<typeof materialFormSchema>;
export const emptyMaterialForm: MaterialFormValues = {
  title: '',
  body: '',
  note: '',
  context: '',
  sourceUrl: '',
};
