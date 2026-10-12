export class AnswerError extends Error {
  constructor(
    readonly kind:
      | 'not_configured'
      | 'consent_required'
      | 'conflict'
      | 'evidence_unavailable'
      | 'not_found'
      | 'unavailable',
  ) {
    super(`답변 요청을 처리하지 못했습니다: ${kind}`);
  }
}

export interface AnswerCommand {
  requestId: string;
  question: string;
  evidence: { materialId: string; revisionId: string }[];
  history?: { requestId: string; question: string }[];
}
