import { createHash } from 'node:crypto';
import {
  answerInputByteLimit,
  answerOutputTokenLimit,
  geminiAnswerModel,
} from './gemini-answer.js';

export interface AnswerPolicy {
  fingerprint: string;
  provider: string;
  model: string;
  policyVersion: string;
  retentionNotice: string;
  answerRetentionSeconds: number;
  receiptRetentionDays: number;
  reservationSeconds: number;
  budgetPeriod: 'utc-month';
  budgetId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  unitScale: number;
  budgetLimit: string;
  purposeBudgetLimit: string;
  pricingVersion: string;
  maximumPerChunk: string;
  requestMaximum: string;
  inputPricePerToken: string;
  outputPricePerToken: string;
}

/** 무료 프로젝트의 청구액이 아니라 유료 표준 단가로 계산하는 보수적 내부 사용량 상한이다. */
export function geminiFreeAnswerPolicy(): AnswerPolicy {
  const maximum = BigInt(answerInputByteLimit) * 300n + BigInt(answerOutputTokenLimit) * 2500n;
  const retentionNotice =
    '질문과 선택한 자료의 근거 본문을 Google에 전송합니다. Gemini 무료 등급의 입력·출력은 제품 개선과 사람의 검토에 사용될 수 있습니다. 공개 가능한 학습 자료만 사용하고 개인정보·기밀·비밀번호·API 키는 보내지 마세요. 답변·인용은 7일, 내용 없는 중복 호출 방지·비용 기록은 90일 보관합니다. 철회해도 이미 전송한 데이터는 회수할 수 없습니다.';

  return {
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify([
          geminiAnswerModel,
          'grounded-claims-v1',
          'gemini-free-answer-v1',
          retentionNotice,
        ]),
      )
      .digest('hex'),
    provider: 'Google Gemini API (무료 등급)',
    model: geminiAnswerModel,
    policyVersion: 'gemini-free-answer-v1',
    retentionNotice,
    answerRetentionSeconds: 7 * 24 * 3600,
    receiptRetentionDays: 90,
    reservationSeconds: 600,
    budgetPeriod: 'utc-month',
    budgetId: 'df100000-0000-4000-8000-000000000000',
    periodStart: '2000-01-01T00:00:00.000Z',
    periodEnd: '2000-02-01T00:00:00.000Z',
    currency: 'USD',
    unitScale: 1_000_000_000,
    budgetLimit: '900000000',
    purposeBudgetLimit: '450000000',
    pricingVersion: 'gemini-3.5-flash-lite-2026-10',
    maximumPerChunk: maximum.toString(),
    requestMaximum: maximum.toString(),
    inputPricePerToken: '300',
    outputPricePerToken: '2500',
  };
}
