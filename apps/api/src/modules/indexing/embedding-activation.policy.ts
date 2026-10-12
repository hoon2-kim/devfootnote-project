import { createHash } from 'node:crypto';
import { IndexingError, type ActivateEmbeddings } from './embedding-activation.types.js';

export function prepareEmbeddingActivation(input: ActivateEmbeddings) {
  if (
    (!input.targets.length && !input.includeExisting) ||
    (input.includeExisting && input.retryFailed) ||
    input.targets.length > 20 ||
    new Set(input.targets.map((target) => target.materialId.toLowerCase())).size !==
      input.targets.length
  ) {
    throw new IndexingError('invalid_targets');
  }

  const targets = input.targets
    .map((target) => ({
      materialId: target.materialId.toLowerCase(),
      revisionId: target.revisionId.toLowerCase(),
    }))
    .sort((left, right) => left.materialId.localeCompare(right.materialId));
  // 요청 ID는 receipt의 식별자다. fingerprint는 같은 ID에 다른 입력이 온 경우를 구분한다.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        input.configFingerprint,
        input.policyVersion,
        input.expectedConsentEpoch,
        targets,
        ...(input.retryFailed ? ['retry-failed'] : []),
        ...(input.includeExisting ? ['include-existing'] : []),
      ]),
    )
    .digest('hex');

  return { targets, fingerprint };
}
