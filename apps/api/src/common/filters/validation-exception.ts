import { BadRequestException, type ValidationError } from '@nestjs/common';

export type ValidationIssue = { field: string; code: string; message: string };

export class ValidationException extends BadRequestException {
  constructor(readonly errors: ValidationIssue[]) {
    super();
  }
}

const messages: Record<string, string> = {
  isString: '문자열을 입력해 주세요.',
  maxLength: '허용 길이를 초과했습니다.',
  minLength: '입력 길이를 확인해 주세요.',
  isInt: '정수를 입력해 주세요.',
  min: '최솟값을 확인해 주세요.',
  max: '최댓값을 확인해 주세요.',
  isEnum: '허용된 값을 선택해 주세요.',
};
const FALLBACK_MESSAGE = '입력을 확인해 주세요.';
// forbidNonWhitelisted가 만드는 오류의 property는 요청자가 정한 key이므로 본문에 반사하지 않는다.
const REFLECTS_REQUEST_KEY = 'whitelistValidation';
const MAX_ISSUES = 20;

function collect(errors: ValidationError[], parent: string): ValidationIssue[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.keys(error.constraints ?? {})
      .filter((code) => code !== REFLECTS_REQUEST_KEY)
      // class-validator 기본 메시지에는 거부된 값이 들어 있어 쓰지 않는다. 미등록 제약도 필드는 알려 준다.
      .map((code) => ({ field, code, message: messages[code] ?? FALLBACK_MESSAGE }));

    return [...own, ...collect(error.children ?? [], field)];
  });
}

export function validationException(errors: ValidationError[]) {
  return new ValidationException(collect(errors, '').slice(0, MAX_ISSUES));
}
