import { describe, expect, it } from 'vitest';
import { embeddingMaximumCost } from './embedding-policy.js';

describe('임베딩 최대 비용', () => {
  it('선택된 자료의 chunk 수와 승인된 chunk당 상한을 곱해 합산한다', () => {
    expect(embeddingMaximumCost([2, 3], '7')).toBe(35n);
  });

  it('Number의 안전한 정수 범위를 넘는 비용도 정밀도를 잃지 않는다', () => {
    expect(embeddingMaximumCost([1, 2], '9007199254740993')).toBe(27021597764222979n);
  });

  it('추가 대상이 없거나 승인된 단가가 0이면 최대 비용도 0이다', () => {
    expect(embeddingMaximumCost([], '7')).toBe(0n);
    expect(embeddingMaximumCost([2, 3], '0')).toBe(0n);
  });
});
