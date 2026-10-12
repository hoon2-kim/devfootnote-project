import { createHash } from 'node:crypto';
import {
  geminiEmbeddingDimensions,
  geminiEmbeddingInputVersion,
  geminiEmbeddingModel,
} from './gemini-embedding.js';

export interface EmbeddingPolicy {
  provider: string;
  model: string;
  modelVersion: string;
  dimensions: number;
  inputVersion: string;
  policyVersion: string;
  retentionNotice: string;
  pricingVersion: string;
  currency: string;
  unitScale: number;
  maximumPerChunk: string;
  pricePerToken?: string;
  budgetId: string;
  budgetLimit: string;
  purposeBudgetLimit?: string;
  periodStart: string;
  periodEnd: string;
  reservationSeconds: number;
  budgetPeriod?: 'utc-month';
}

export type ApprovedEmbeddingPolicy = EmbeddingPolicy & {
  fingerprint: string;
  vectorFingerprint: string;
  consentFingerprint: string;
};

export function approveEmbeddingPolicy(policy: EmbeddingPolicy): ApprovedEmbeddingPolicy {
  const vectorFingerprint = fingerprint([
    policy.provider,
    policy.model,
    policy.modelVersion,
    policy.dimensions,
    policy.inputVersion,
  ]);
  const consentFingerprint = fingerprint([
    policy.provider,
    policy.policyVersion,
    policy.retentionNotice,
  ]);

  return {
    ...policy,
    vectorFingerprint,
    consentFingerprint,
    // 게시·재사용에는 벡터 호환성뿐 아니라 전송 동의 조건도 유지되어야 한다.
    // 가격과 월별 예산은 예약 snapshot의 책임이며 기존 벡터를 무효화하지 않는다.
    fingerprint: fingerprint([vectorFingerprint, consentFingerprint]),
  };
}

function fingerprint(fields: readonly (string | number)[]) {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/** 무료 개발 설정도 유료 표준 단가의 참고 예산으로 사용량을 제한한다. 실제 청구액은 아니다. */
export function geminiFreePolicy(now = new Date()): ApprovedEmbeddingPolicy {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const periodStart = new Date(Date.UTC(year, month, 1)).toISOString();
  const periodEnd = new Date(Date.UTC(year, month + 1, 1)).toISOString();
  // 모든 owner·API·worker가 같은 UTC 월 예산을 사용한다. 재기동으로 예산을 초기화하지 않는다.
  const suffix = `${year}${String(month + 1).padStart(2, '0')}`.padStart(12, '0');

  return approveEmbeddingPolicy({
    provider: 'Google Gemini API (무료 등급)',
    model: geminiEmbeddingModel,
    modelVersion: 'gemini-embedding-2-config-v1',
    dimensions: geminiEmbeddingDimensions,
    inputVersion: geminiEmbeddingInputVersion,
    policyVersion: 'gemini-free-public-only-v1',
    retentionNotice:
      '본문과 의미 검색어를 Google에 전송합니다. 무료 등급의 입력·출력은 제품 개선에 사용되고 사람이 검토할 수 있습니다. 공개 가능한 학습 자료만 사용하고 개인정보·회사 기밀·비밀번호·API 키를 보내지 마세요. 철회해도 이미 전송한 자료를 회수할 수 없습니다.',
    pricingVersion: 'gemini2-text-standard-2026-10',
    currency: 'USD',
    unitScale: 1_000_000_000,
    pricePerToken: '200',
    maximumPerChunk: '8192000',
    budgetId: `df000000-0000-4000-8000-${suffix}`,
    budgetLimit: '900000000',
    purposeBudgetLimit: '450000000',
    periodStart,
    periodEnd,
    reservationSeconds: 3600,
    budgetPeriod: 'utc-month',
  });
}
