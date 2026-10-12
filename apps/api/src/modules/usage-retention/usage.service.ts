import { approveEmbeddingPolicy } from '@devfootnote/ai';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transactional, Propagation } from '@nestjs-cls/transactional';
import { UsageRepository } from './usage.repository.js';
import {
  UsageError,
  type ApprovedEmbeddingPolicy,
  type EmbeddingPolicy,
  type EmbeddingConsent,
} from './embedding-policy.js';

@Injectable()
export class UsageService {
  constructor(
    private readonly repository: UsageRepository,
    private readonly config: ConfigService,
  ) {}

  configuration(): ApprovedEmbeddingPolicy | null {
    const policy = this.config.get<EmbeddingPolicy | null>('embeddingPolicy');

    if (!policy) {
      return null;
    }

    return approveEmbeddingPolicy(policy);
  }

  async consent(ownerId: string): Promise<EmbeddingConsent> {
    const row = await this.repository.consent(ownerId);

    return {
      epoch: row?.epoch ?? 0,
      configFingerprint: row?.configFingerprint ?? null,
      granted: Boolean(row?.grantedAt && !row.revokedAt),
    };
  }

  @Transactional(Propagation.Mandatory)
  async lockConsent(ownerId: string): Promise<EmbeddingConsent> {
    const row = await this.repository.lockConsent(ownerId);

    return {
      epoch: row.epoch,
      configFingerprint: row.configFingerprint,
      granted: Boolean(row.grantedAt && !row.revokedAt),
    };
  }

  @Transactional(Propagation.Mandatory)
  async grant(ownerId: string, expectedEpoch: number, policy: ApprovedEmbeddingPolicy) {
    const consent = await this.repository.lockConsent(ownerId);

    if (consent.epoch !== expectedEpoch) {
      throw new UsageError('consent_conflict');
    }

    if (
      consent.grantedAt &&
      !consent.revokedAt &&
      consent.configFingerprint === policy.fingerprint
    ) {
      return consent.epoch;
    }

    const epoch = consent.epoch + 1;

    await this.repository.grant(ownerId, epoch, policy);

    return epoch;
  }

  @Transactional()
  async revoke(ownerId: string, expectedEpoch: number): Promise<{ consentEpoch: number }> {
    const consent = await this.repository.lockConsent(ownerId);

    if (consent.epoch !== expectedEpoch) {
      throw new UsageError('consent_conflict');
    }

    if (!consent.grantedAt || consent.revokedAt) {
      return { consentEpoch: consent.epoch };
    }

    await this.repository.revoke(ownerId, consent.epoch + 1);

    return { consentEpoch: consent.epoch + 1 };
  }

  @Transactional(Propagation.Mandatory)
  reserve(
    ownerId: string,
    requestId: string,
    fingerprint: string,
    epoch: number,
    amount: bigint,
    policy: ApprovedEmbeddingPolicy,
  ) {
    return this.repository.reserve(ownerId, requestId, fingerprint, epoch, amount, policy);
  }

  @Transactional()
  async beginQuery(
    ownerId: string,
    requestId: string,
    fingerprint: string,
  ): Promise<
    | { reason: 'not_configured' | 'consent_required' | 'request_used' }
    | { reservationId: string; policy: ApprovedEmbeddingPolicy; consentEpoch: number }
  > {
    const policy = this.configuration();

    if (!policy?.pricePerToken || !/^[1-9][0-9]*$/.test(policy.pricePerToken)) {
      return { reason: 'not_configured' } as const;
    }

    const consent = await this.lockConsent(ownerId);

    if (!consent.granted || consent.configFingerprint !== policy.fingerprint) {
      return { reason: 'consent_required' } as const;
    }

    // 의미검색은 결과를 보존하지 않는다. 같은 ID 재전송은 재호출하지 않고 keyword로 안내한다.
    if (await this.repository.queryRequestExists(ownerId, requestId)) {
      return { reason: 'request_used' } as const;
    }

    const reservationId = await this.repository.reserve(
      ownerId,
      requestId,
      fingerprint,
      consent.epoch,
      8192n * BigInt(policy.pricePerToken),
      policy,
    );

    // commit 이후 crash도 비용 노출로 남는다. 원문·질의 벡터는 usage 행에 쓰지 않는다.
    await this.repository.exposeQuery(ownerId, reservationId);

    return { reservationId, policy, consentEpoch: consent.epoch };
  }

  @Transactional()
  settleQuery(ownerId: string, reservationId: string, tokens: number | null) {
    return this.repository.settleQuery(ownerId, reservationId, tokens);
  }
}
