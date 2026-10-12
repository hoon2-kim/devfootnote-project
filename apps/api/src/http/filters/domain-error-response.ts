import { AuthError } from '../../modules/auth/index.js';
import { IndexingError } from '../../modules/indexing/index.js';
import { MaterialsError } from '../../modules/materials/index.js';
import { AnswerUsageError, UsageError } from '../../modules/usage-retention/index.js';
import { AnswerError } from '../../modules/answers/index.js';

interface PublicError {
  status: number;
  error: string;
  message: string;
}

// 업무 오류의 공개 표현은 앱의 HTTP 조립 경계가 소유한다.
const materialErrors = {
  conflict: {
    status: 409,
    error: 'MATERIAL_REQUEST_CONFLICT',
    message: '같은 요청 ID로 다른 자료를 저장할 수 없습니다.',
  },
  revision_conflict: {
    status: 409,
    error: 'MATERIAL_REVISION_CONFLICT',
    message: '자료가 변경되었습니다. 최신 내용을 확인해 주세요.',
  },
  not_found: {
    status: 404,
    error: 'MATERIAL_NOT_FOUND',
    message: '자료를 찾을 수 없습니다.',
  },
  unavailable: {
    status: 503,
    error: 'SERVICE_UNAVAILABLE',
    message: '잠시 후 다시 시도해 주세요.',
  },
} satisfies Record<MaterialsError['kind'], PublicError>;

const authErrors = {
  denied: {
    status: 401,
    error: 'AUTHENTICATION_REQUIRED',
    message: '로그인이 필요합니다.',
  },
  unavailable: {
    status: 503,
    error: 'SERVICE_UNAVAILABLE',
    message: '잠시 후 다시 시도해 주세요.',
  },
} satisfies Record<AuthError['kind'], PublicError>;

const usageErrors = {
  not_configured: {
    status: 409,
    error: 'EMBEDDING_NOT_CONFIGURED',
    message: '의미 검색 설정이 아직 승인되지 않았습니다.',
  },
  consent_conflict: {
    status: 409,
    error: 'EMBEDDING_CONSENT_CONFLICT',
    message: '동의 상태가 변경되었습니다. 다시 확인해 주세요.',
  },
  budget_exhausted: {
    status: 409,
    error: 'EMBEDDING_BUDGET_EXHAUSTED',
    message: '사용 가능한 처리 예산이 부족합니다.',
  },
  policy_conflict: {
    status: 409,
    error: 'EMBEDDING_POLICY_CONFLICT',
    message: '설정이나 비용 정책이 변경되었습니다. 다시 확인해 주세요.',
  },
  unavailable: {
    status: 503,
    error: 'SERVICE_UNAVAILABLE',
    message: '잠시 후 다시 시도해 주세요.',
  },
} satisfies Record<UsageError['kind'], PublicError>;

const indexingErrors = {
  request_conflict: {
    status: 409,
    error: 'EMBEDDING_REQUEST_CONFLICT',
    message: '같은 요청 ID로 다른 활성화를 요청할 수 없습니다.',
  },
  consent_required: {
    status: 403,
    error: 'EMBEDDING_CONSENT_REQUIRED',
    message: '외부 전송에 대한 명시적 동의가 필요합니다.',
  },
  invalid_targets: {
    status: 400,
    error: 'VALIDATION_ERROR',
    message: '활성화할 자료를 다시 확인해 주세요.',
  },
} satisfies Record<IndexingError['kind'], PublicError>;

export function toDomainErrorResponse(exception: unknown): PublicError | undefined {
  if (exception instanceof AnswerUsageError) {
    return answerUsageErrors[exception.kind];
  }

  if (exception instanceof AnswerError) {
    return answerErrors[exception.kind];
  }

  if (exception instanceof MaterialsError) {
    return materialErrors[exception.kind];
  }

  if (exception instanceof UsageError) {
    return usageErrors[exception.kind];
  }

  if (exception instanceof IndexingError) {
    return indexingErrors[exception.kind];
  }

  if (exception instanceof AuthError) {
    return authErrors[exception.kind];
  }

  return undefined;
}

const answerErrors = {
  not_configured: {
    status: 409,
    error: 'ANSWER_NOT_CONFIGURED',
    message: '답변 생성은 모델 평가와 설정 승인 후 사용할 수 있습니다.',
  },
  consent_required: {
    status: 403,
    error: 'ANSWER_CONSENT_REQUIRED',
    message: '질문과 근거의 외부 전송에 별도로 동의해 주세요.',
  },
  conflict: {
    status: 409,
    error: 'ANSWER_REQUEST_CONFLICT',
    message: '같은 요청 ID로 다른 질문이나 근거를 보낼 수 없습니다.',
  },
  evidence_unavailable: {
    status: 409,
    error: 'ANSWER_EVIDENCE_UNAVAILABLE',
    message: '근거 자료의 현재 버전과 의미 검색 준비 상태를 확인해 주세요.',
  },
  not_found: { status: 404, error: 'ANSWER_NOT_FOUND', message: '답변 요청을 찾을 수 없습니다.' },
  unavailable: {
    status: 503,
    error: 'SERVICE_UNAVAILABLE',
    message: '잠시 후 다시 시도해 주세요.',
  },
} satisfies Record<AnswerError['kind'], PublicError>;

const answerUsageErrors = {
  not_configured: {
    status: 409,
    error: 'ANSWER_NOT_CONFIGURED',
    message: '답변 생성은 모델 평가와 설정 승인 후 사용할 수 있습니다.',
  },
  consent_conflict: {
    status: 409,
    error: 'ANSWER_CONSENT_CONFLICT',
    message: '답변 동의 상태가 변경되었습니다. 다시 확인해 주세요.',
  },
  budget_exhausted: {
    status: 429,
    error: 'ANSWER_BUDGET_EXHAUSTED',
    message: '이번 기간에 사용할 수 있는 답변 예산이 부족합니다.',
  },
  policy_conflict: {
    status: 409,
    error: 'ANSWER_POLICY_CONFLICT',
    message: '답변 설정이나 비용 정책이 변경되었습니다. 다시 확인해 주세요.',
  },
  unavailable: {
    status: 503,
    error: 'SERVICE_UNAVAILABLE',
    message: '잠시 후 다시 시도해 주세요.',
  },
} satisfies Record<AnswerUsageError['kind'], PublicError>;
