import { describe, expect, it } from 'vitest';
import { prepareEmbeddingActivation } from './embedding-activation.policy.js';
import { IndexingError, type ActivateEmbeddings } from './embedding-activation.types.js';

const firstTarget = {
  materialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const secondTarget = {
  materialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  revisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

function activationInput(): ActivateEmbeddings {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    configFingerprint: 'approved-config',
    policyVersion: 'v1',
    expectedConsentEpoch: 0,
    accepted: true,
    targets: [{ ...firstTarget }, { ...secondTarget }],
  };
}

describe('임베딩 활성화 입력 준비', () => {
  it('UUID 대소문자와 입력 순서가 달라도 같은 대상을 만들고 원본 입력은 변경하지 않는다', () => {
    const input = activationInput();
    const reordered = {
      ...input,
      targets: input.targets
        .map((target) => ({
          materialId: target.materialId.toUpperCase(),
          revisionId: target.revisionId.toUpperCase(),
        }))
        .reverse(),
    };
    const original = structuredClone(reordered);

    expect(prepareEmbeddingActivation(reordered)).toEqual(prepareEmbeddingActivation(input));
    expect(reordered).toEqual(original);
    expect(prepareEmbeddingActivation(reordered).targets).toEqual(input.targets);
  });

  it('같은 자료는 UUID 대소문자나 revision이 달라도 중복 대상으로 거부한다', () => {
    const input = activationInput();

    input.targets = [
      { ...firstTarget },
      {
        materialId: firstTarget.materialId.toUpperCase(),
        revisionId: secondTarget.revisionId,
      },
    ];

    expect(() => prepareEmbeddingActivation(input)).toThrowError(
      new IndexingError('invalid_targets'),
    );
  });

  it.each([0, 21].map((count) => ({ count })))(
    '처리 대상이 $count개이면 허용 범위를 벗어나 거부한다',
    ({ count }) => {
      const input = activationInput();

      input.targets = Array.from({ length: count }, (_, index) => ({
        materialId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        revisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }));

      expect(() => prepareEmbeddingActivation(input)).toThrowError(
        new IndexingError('invalid_targets'),
      );
    },
  );

  it('서로 다른 자료 20개까지 허용한다', () => {
    const input = activationInput();

    input.targets = Array.from({ length: 20 }, (_, index) => ({
      materialId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      revisionId: firstTarget.revisionId,
    }));

    expect(prepareEmbeddingActivation(input).targets).toHaveLength(20);
  });

  it('request ID는 입력 fingerprint에 포함하지 않는다', () => {
    const input = activationInput();
    const retry = { ...input, requestId: '00000000-0000-4000-8000-000000000002' };

    expect(prepareEmbeddingActivation(input).fingerprint).toBe(
      prepareEmbeddingActivation(retry).fingerprint,
    );
  });

  it('설정·정책·동의 epoch·대상 자료·revision이 바뀌면 다른 입력으로 구분한다', () => {
    const input = activationInput();
    const fingerprint = prepareEmbeddingActivation(input).fingerprint;
    const changedInputs: ActivateEmbeddings[] = [
      { ...input, configFingerprint: 'another-config' },
      { ...input, policyVersion: 'v2' },
      { ...input, expectedConsentEpoch: 1 },
      {
        ...input,
        targets: [
          { ...firstTarget, materialId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
          { ...secondTarget },
        ],
      },
      {
        ...input,
        targets: input.targets.map((target) => ({
          ...target,
          revisionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        })),
      },
    ];

    for (const changed of changedInputs) {
      expect(prepareEmbeddingActivation(changed).fingerprint).not.toBe(fingerprint);
    }
  });
});
