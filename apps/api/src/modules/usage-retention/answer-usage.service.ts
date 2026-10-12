import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transactional, Propagation } from '@nestjs-cls/transactional';
import type { AnswerPolicy } from '@devfootnote/ai';
import { AnswerUsageRepository } from './answer-usage.repository.js';
import { AnswerUsageError } from './answer-usage.error.js';

@Injectable()
export class AnswerUsageService {
  constructor(
    private readonly repository: AnswerUsageRepository,
    private readonly config: ConfigService,
  ) {}

  configuration(): AnswerPolicy | null {
    return this.config.get<AnswerPolicy | null>('answerPolicy') ?? null;
  }

  async consent(ownerId: string) {
    const row = await this.repository.consent(ownerId);

    return {
      epoch: row?.epoch ?? 0,
      fingerprint: row?.configFingerprint ?? null,
      granted: Boolean(row?.grantedAt && !row.revokedAt),
    };
  }

  @Transactional(Propagation.Mandatory)
  async lockConsent(ownerId: string) {
    const row = await this.repository.lockConsent(ownerId);

    return {
      epoch: row.epoch,
      fingerprint: row.configFingerprint,
      granted: Boolean(row.grantedAt && !row.revokedAt),
    };
  }

  @Transactional()
  async grant(ownerId: string, expectedEpoch: number, fingerprint: string) {
    const policy = this.configuration();

    if (!policy || policy.fingerprint !== fingerprint) {
      throw new AnswerUsageError('policy_conflict');
    }

    const consent = await this.lockConsent(ownerId);

    if (consent.epoch !== expectedEpoch) {
      throw new AnswerUsageError('consent_conflict');
    }

    if (consent.granted && consent.fingerprint === fingerprint) {
      return consent.epoch;
    }

    await this.repository.grant(ownerId, consent.epoch + 1, policy);

    return consent.epoch + 1;
  }

  @Transactional()
  async revoke(ownerId: string, expectedEpoch: number) {
    const consent = await this.lockConsent(ownerId);

    if (consent.epoch !== expectedEpoch) {
      throw new AnswerUsageError('consent_conflict');
    }

    if (!consent.granted) {
      return consent.epoch;
    }

    await this.repository.revoke(ownerId, consent.epoch + 1);

    return consent.epoch + 1;
  }

  @Transactional(Propagation.Mandatory)
  reserve(
    ownerId: string,
    requestId: string,
    fingerprint: string,
    epoch: number,
    policy: AnswerPolicy,
  ) {
    return this.repository.reserve(ownerId, requestId, fingerprint, epoch, policy);
  }
}
