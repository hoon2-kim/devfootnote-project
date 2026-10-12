import { Injectable } from '@nestjs/common';
import { TransactionHost, Transactional, Propagation } from '@nestjs-cls/transactional';
import { MaterialsError, MaterialsService } from '../materials/index.js';
import { UsageService, UsageError, embeddingMaximumCost } from '../usage-retention/index.js';
import { EmbeddingWorkRepository } from './embedding-work.repository.js';
import { EmbeddingDeliveryService } from './embedding-delivery.service.js';
import { prepareEmbeddingActivation } from './embedding-activation.policy.js';
import {
  IndexingError,
  type ActivateEmbeddings,
  type EmbeddingActivationResult,
  type EmbeddingPreviewResult,
} from './embedding-activation.types.js';
import { isDatabaseUnavailable } from '../../infrastructure/database/database-error.js';

// 업무 실패는 보존하고 원본 SQL·parameter·cause는 HTTP 경계로 전달하지 않는다.
function activationError(error: unknown): Error {
  if (
    error instanceof MaterialsError ||
    error instanceof UsageError ||
    error instanceof IndexingError
  ) {
    return error;
  }

  if (isDatabaseUnavailable(error)) {
    return new UsageError('unavailable');
  }

  return new Error('의미 검색 활성화 저장 작업에 실패했습니다.');
}

@Injectable()
export class EmbeddingActivationService {
  constructor(
    private readonly transactions: TransactionHost,
    private readonly materials: MaterialsService,
    private readonly usage: UsageService,
    private readonly repository: EmbeddingWorkRepository,
    private readonly delivery: EmbeddingDeliveryService,
  ) {}

  async preview(ownerId: string, afterId?: string, limit = 20): Promise<EmbeddingPreviewResult> {
    try {
      const policy = this.usage.configuration();
      const consent = await this.usage.consent(ownerId);

      if (!policy) {
        return {
          configured: false,
          consentEpoch: consent.epoch,
          policy: null,
          items: [],
          nextCursor: null,
          reservedMaximum: '0',
          consented: false,
          automatic: false,
          includeExisting: false,
          states: [],
        };
      }

      const rows = await this.materials.currentEmbeddingIntents(ownerId, afterId, limit + 1);
      const activation = await this.repository.activation(ownerId);
      const automatic = Boolean(
        consent.granted &&
        consent.configFingerprint === policy.fingerprint &&
        activation?.configFingerprint === policy.fingerprint &&
        activation.consentEpoch === consent.epoch,
      );
      const page = rows.slice(0, limit);
      const epoch =
        consent.granted && consent.configFingerprint === policy.fingerprint
          ? consent.epoch
          : consent.epoch + 1;
      const existing = await this.repository.existingIntents(
        ownerId,
        page.map((row) => row.intentId),
        policy.fingerprint,
        epoch,
      );
      const items = page.filter((row) => !existing.has(row.intentId));
      const amount = embeddingMaximumCost(
        items.map((row) => row.chunkCount),
        policy.maximumPerChunk,
      );
      const states = await this.repository.states(
        ownerId,
        page.map((row) => row.intentId),
        policy.fingerprint,
        epoch,
      );

      return {
        configured: true,
        consentEpoch: consent.epoch,
        policy,
        items,
        nextCursor: rows.length > limit ? (page.at(-1)?.materialId ?? null) : null,
        reservedMaximum: amount.toString(),
        consented: consent.granted && consent.configFingerprint === policy.fingerprint,
        automatic,
        includeExisting: automatic && Boolean(activation?.includeExisting),
        states: page.map((row) => {
          const work = states.find((state) => state.intentId === row.intentId);

          return {
            materialId: row.materialId,
            revisionId: row.revisionId,
            title: row.title ?? null,
            state: work?.state ?? 'NOT_STARTED',
            failure: work?.failure ?? null,
          };
        }),
      };
    } catch (error) {
      throw activationError(error);
    }
  }

  // 바깥 transaction에 합류하면 이 메서드가 반환할 때도 commit 전일 수 있다.
  // 큐 전달 순서를 지키기 위해 활성화는 독립적인 업무 진입점으로만 호출한다.
  @Transactional(Propagation.Never)
  async activate(ownerId: string, input: ActivateEmbeddings): Promise<EmbeddingActivationResult> {
    const policy = this.usage.configuration();

    if (!policy) {
      throw new UsageError('not_configured');
    }

    if (!input.accepted) {
      throw new IndexingError('consent_required');
    }

    if (
      input.configFingerprint !== policy.fingerprint ||
      input.policyVersion !== policy.policyVersion
    ) {
      throw new UsageError('policy_conflict');
    }

    const { targets, fingerprint } = prepareEmbeddingActivation(input);
    let result: EmbeddingActivationResult;

    try {
      result = await this.transactions.withTransaction(async () => {
        // 같은 owner의 동의 행으로 활성화·철회를 직렬화한다. 예산은 별도 공유 행으로 잠근다.
        const consent = await this.usage.lockConsent(ownerId);
        const receipt = await this.repository.receipt(ownerId, input.requestId);

        if (receipt && receipt.fingerprint !== fingerprint) {
          throw new IndexingError('request_conflict');
        }

        const current = await this.materials.lockCurrentEmbeddingIntents(ownerId, targets);

        if (receipt) {
          if (
            !consent.granted ||
            consent.epoch !== receipt.consentEpoch ||
            consent.configFingerprint !== policy.fingerprint
          ) {
            throw new UsageError('consent_conflict');
          }

          return {
            requestId: receipt.requestId,
            consentEpoch: receipt.consentEpoch,
            workIds: receipt.workIds,
            reservedMaximum: receipt.reservedMaximum.toString(),
          };
        }

        const epoch = await this.usage.grant(ownerId, input.expectedConsentEpoch, policy);
        const existing = await this.repository.existingIntents(
          ownerId,
          current.map((row) => row.intentId),
          policy.fingerprint,
          epoch,
          input.retryFailed,
        );
        const pending = current.filter((row) => !existing.has(row.intentId));
        const amount = embeddingMaximumCost(
          pending.map((row) => row.chunkCount),
          policy.maximumPerChunk,
        );
        let workIds: string[] = [];

        if (pending.length) {
          const reservationId = await this.usage.reserve(
            ownerId,
            input.requestId,
            fingerprint,
            epoch,
            amount,
            policy,
          );

          workIds = await this.repository.createWorks(
            ownerId,
            input.requestId,
            pending.map((row) => row.intentId),
            policy.fingerprint,
            epoch,
            reservationId,
          );
        }

        const accepted = {
          requestId: input.requestId,
          consentEpoch: epoch,
          workIds,
          reservedMaximum: amount.toString(),
        };

        await this.repository.recordActivation(
          ownerId,
          fingerprint,
          policy.fingerprint,
          accepted,
          input.includeExisting,
        );

        return accepted;
      });
    } catch (error) {
      throw activationError(error);
    }

    // 이 await 이전에 PostgreSQL commit이 끝난다. Redis 장애로 저장 결과를 rollback하지 않는다.
    await Promise.all(result.workIds.map((id) => this.delivery.deliver(ownerId, id)));

    return result;
  }

  async revoke(ownerId: string, expectedEpoch: number): Promise<{ consentEpoch: number }> {
    try {
      return await this.usage.revoke(ownerId, expectedEpoch);
    } catch (error) {
      throw activationError(error);
    }
  }
}
