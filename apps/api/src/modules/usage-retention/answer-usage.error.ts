export class AnswerUsageError extends Error {
  constructor(
    readonly kind:
      | 'not_configured'
      | 'consent_conflict'
      | 'budget_exhausted'
      | 'policy_conflict'
      | 'unavailable',
  ) {
    super(`답변 사용 조건을 확인하지 못했습니다: ${kind}`);
  }
}
