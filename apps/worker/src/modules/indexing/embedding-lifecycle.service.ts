import { createHash, randomUUID } from 'node:crypto';
import type { ApprovedEmbeddingPolicy } from '@devfootnote/ai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InjectTransactionHost,
  Propagation,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import { logger } from '../../infrastructure/logging/logger.js';
import { MaterialsService } from '../materials/index.js';
import { WorkerUsageService } from '../usage-retention/index.js';
import { EmbeddingWorkRepository } from './embedding-work.repository.js';

/** 저장 직후 알림이 유실돼도 명시적 활성화에서 복구하고, 더 이상 쓸 수 없는 파생 벡터를 정리한다. */
@Injectable()
export class EmbeddingLifecycleService {
  constructor(
    @InjectTransactionHost('worker') private readonly transactions: TransactionHost,
    private readonly config: ConfigService,
    private readonly repository: EmbeddingWorkRepository,
    private readonly materials: MaterialsService,
    private readonly usage: WorkerUsageService,
  ) {}

  @Transactional('worker', Propagation.Never)
  async activateMissing() {
    const policy = this.config.get<ApprovedEmbeddingPolicy | null>('embeddingPolicy');

    if (
      !policy ||
      this.config.get<string | null>('embeddingConfigFingerprint') !== policy.fingerprint
    ) {
      return;
    }

    for (const ownerId of await this.repository.reserveActivationBatch()) {
      try {
        await this.transactions.withTransaction(async () => {
          const consent = await this.usage.lockConsent(ownerId);
          const activation = await this.repository.activation(ownerId);

          if (
            !activation ||
            !consent?.granted ||
            consent.epoch !== activation.consentEpoch ||
            consent.configFingerprint !== policy.fingerprint ||
            activation.configFingerprint !== policy.fingerprint
          ) {
            return;
          }

          const rows = await this.materials.currentIntents(
            ownerId,
            activation.intentCursor,
            activation.includeExisting ? null : activation.enabledAt,
            21,
          );
          const page = rows.slice(0, 20);
          const existing = await this.repository.existingIntents(
            ownerId,
            page.map((row) => row.intentId),
            policy.fingerprint,
            consent.epoch,
          );
          const pending: typeof page = [];

          // API의 자료 잠금과 순서를 맞춘다. 커서는 intent 순서지만 잠금은 material ID 순서다.
          for (const row of [...page].sort((a, b) => a.materialId.localeCompare(b.materialId))) {
            if (
              !existing.has(row.intentId) &&
              (await this.materials.lockCurrentIntent(ownerId, row.intentId))
            ) {
              pending.push(row);
            }
          }

          if (pending.length) {
            const amount = pending.reduce(
              (sum, row) => sum + BigInt(row.chunkCount) * BigInt(policy.maximumPerChunk),
              0n,
            );
            const requestId = randomUUID();
            const fingerprint = createHash('sha256')
              .update(
                JSON.stringify([
                  activation.requestId,
                  policy.fingerprint,
                  consent.epoch,
                  pending.map((row) => row.intentId),
                ]),
              )
              .digest('hex');
            const reservationId = await this.usage.reserveCurrent(
              ownerId,
              requestId,
              fingerprint,
              consent.epoch,
              amount,
              policy,
            );

            if (reservationId) {
              await this.repository.createMissingWorks(
                ownerId,
                activation.requestId,
                pending.map((row) => row.intentId),
                policy.fingerprint,
                consent.epoch,
                reservationId,
              );
            }
          }

          // 이미 완료된 앞쪽 intent나 예산 부족 항목이 이후 자료의 검사를 영원히 막지 않는다.
          await this.repository.advanceActivation(
            ownerId,
            rows.length > 20 ? (page.at(-1)?.intentId ?? null) : null,
          );
        });
      } catch {
        logger.warn('현재 자료의 누락 임베딩 작업을 복구하지 못했습니다.');
      }
    }
  }

  @Transactional('worker', Propagation.Never)
  async cleanVectors() {
    const fingerprint = this.config.get<string | null>('embeddingConfigFingerprint');

    for (const row of await this.repository.reserveVectorCleanup()) {
      try {
        await this.transactions.withTransaction(async () => {
          const consent = await this.usage.lockConsent(row.ownerId);
          const reusable = await this.materials.lockReusableChunk(
            row.ownerId,
            row.materialId,
            row.chunkId,
          );

          if (
            !consent?.granted ||
            consent.epoch !== row.consentEpoch ||
            consent.configFingerprint !== row.configFingerprint ||
            (fingerprint !== null &&
              fingerprint !== undefined &&
              row.configFingerprint !== fingerprint) ||
            !reusable
          ) {
            await this.repository.deleteVector(row.workId, row.chunkId);
          }
        });
      } catch {
        logger.warn('사용하지 않는 임베딩 벡터를 정리하지 못했습니다.');
      }
    }
  }

  @Transactional('worker', Propagation.Never)
  async cleanAudit() {
    for (const row of await this.usage.reserveAuditCleanup()) {
      try {
        await this.transactions.withTransaction(async () => {
          // API의 예약·정산과 같은 budget→reservation→work 잠금 순서를 유지한다.
          if (
            !(await this.usage.lockReservation(row.ownerId, row.id)) ||
            !(await this.usage.auditExpired(row.ownerId, row.id))
          ) {
            return;
          }

          if (await this.repository.detachExpiredAudit(row.ownerId, row.id)) {
            await this.usage.deleteAudit(row.ownerId, row.id);
          }
        });
      } catch {
        logger.warn('보존 기간이 지난 임베딩 실행 기록을 정리하지 못했습니다.');
      }
    }

    await this.usage.deleteExpiredBudgets();
  }
}
