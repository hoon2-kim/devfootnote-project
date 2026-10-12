import { Injectable } from '@nestjs/common';
import {
  InjectTransactionHost,
  Propagation,
  Transactional,
  TransactionHost,
} from '@nestjs-cls/transactional';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import { UsageRepository } from './usage.repository.js';
import type { ApprovedEmbeddingPolicy } from '@devfootnote/ai';

export interface EmbeddingConsent {
  epoch: number;
  configFingerprint: string | null;
  granted: boolean;
}

export interface EmbeddingReservation {
  id: string;
  configFingerprint: string;
  consentEpoch: number;
  state: 'reserved' | 'released' | 'expired' | 'settled';
  active: boolean;
  exposed: boolean;
}

@Injectable()
export class WorkerUsageService {
  constructor(
    private readonly repository: UsageRepository,
    @InjectTransactionHost('worker')
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  reserveCurrent(
    ownerId: string,
    requestId: string,
    fingerprint: string,
    epoch: number,
    amount: bigint,
    policy: ApprovedEmbeddingPolicy,
  ): Promise<string | null> {
    return this.repository.reserveCurrent(ownerId, requestId, fingerprint, epoch, amount, policy);
  }

  lockConsent(ownerId: string): Promise<EmbeddingConsent | null> {
    return this.repository.lockConsent(ownerId);
  }

  lockReservation(ownerId: string, reservationId: string): Promise<EmbeddingReservation | null> {
    return this.repository.lockReservation(ownerId, reservationId);
  }

  markExposure(ownerId: string, reservationId: string): Promise<boolean> {
    return this.repository.markExposure(ownerId, reservationId);
  }

  recordCall(
    ownerId: string,
    reservationId: string,
    attemptId: string,
    tokens: number | null,
  ): Promise<void> {
    return this.repository.recordCall(ownerId, reservationId, attemptId, tokens);
  }

  settle(ownerId: string, reservationId: string, attemptIds: readonly string[]): Promise<void> {
    return this.repository.settle(ownerId, reservationId, attemptIds);
  }

  @Transactional('worker', Propagation.Never)
  expireUnexposed(limit = 20): Promise<number> {
    return this.transactions.withTransaction(() => this.repository.expireUnexposed(limit));
  }

  @Transactional('worker', Propagation.Never)
  settleExpiredQueries(limit = 20): Promise<number> {
    return this.transactions.withTransaction(() => this.repository.settleExpiredQueries(limit));
  }

  @Transactional('worker', Propagation.Never)
  reserveAuditCleanup() {
    return this.transactions.withTransaction(() => this.repository.reserveAuditCleanup(100));
  }

  auditExpired(ownerId: string, reservationId: string): Promise<boolean> {
    return this.repository.auditExpired(ownerId, reservationId);
  }

  deleteAudit(ownerId: string, reservationId: string): Promise<void> {
    return this.repository.deleteAudit(ownerId, reservationId);
  }

  @Transactional('worker', Propagation.Never)
  deleteExpiredBudgets(): Promise<number> {
    return this.transactions.withTransaction(() => this.repository.deleteExpiredBudgets(100));
  }
}
