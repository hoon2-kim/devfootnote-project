import { Injectable } from '@nestjs/common';
import { AnswerUsageRepository } from './answer-usage.repository.js';

@Injectable()
export class AnswerUsageService {
  constructor(private readonly repository: AnswerUsageRepository) {}

  lockConsent(ownerId: string) {
    return this.repository.lockConsent(ownerId);
  }

  async lockReservation(ownerId: string, id: string) {
    const row = await this.repository.lockReservation(ownerId, id);

    return row
      ? {
          id: row.reservation.id,
          consentEpoch: row.reservation.consentEpoch,
          fingerprint: row.reservation.configFingerprint,
          active: row.active && row.reservation.state === 'reserved',
          exposed: Boolean(row.reservation.exposureStartedAt),
        }
      : null;
  }

  expose(ownerId: string, id: string) {
    return this.repository.expose(ownerId, id);
  }
  settle(ownerId: string, id: string, usage: { inputTokens: number; outputTokens: number } | null) {
    return this.repository.settle(ownerId, id, usage);
  }
  deleteReceipt(ownerId: string, id: string) {
    return this.repository.deleteReceipt(ownerId, id);
  }
  receiptExpired(ownerId: string, id: string) {
    return this.repository.receiptExpired(ownerId, id);
  }
}
