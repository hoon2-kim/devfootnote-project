import {
  embeddingWorks,
  embeddingActivationReceipts,
  embeddingActivations,
} from '@devfootnote/db/schema/indexing';
import { randomUUID } from 'node:crypto';
import { TransactionHost, Transactional, Propagation } from '@nestjs-cls/transactional';
import type { PostgresTransactionAdapter } from '../../infrastructure/database/transactions.module.js';
import type { EmbeddingActivationResult } from './embedding-activation.types.js';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../infrastructure/database/database.provider.js';

@Injectable()
export class EmbeddingWorkRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly transactions: TransactionHost<PostgresTransactionAdapter>,
  ) {}

  async activation(ownerId: string) {
    const [row] = await this.db
      .select()
      .from(embeddingActivations)
      .where(eq(embeddingActivations.ownerId, ownerId));

    return row;
  }

  @Transactional(Propagation.Mandatory)
  async receipt(ownerId: string, requestId: string) {
    const [row] = await this.transactions.tx
      .select()
      .from(embeddingActivationReceipts)
      .where(
        and(
          eq(embeddingActivationReceipts.ownerId, ownerId),
          eq(embeddingActivationReceipts.requestId, requestId),
        ),
      );

    return row;
  }

  async existingIntents(
    ownerId: string,
    intentIds: string[],
    configFingerprint: string,
    consentEpoch: number,
    retryFailed = false,
  ) {
    if (!intentIds.length) {
      return new Set<string>();
    }

    const rows = await this.transactions.tx
      .select({ intentId: embeddingWorks.intentId })
      .from(embeddingWorks)
      .where(
        and(
          eq(embeddingWorks.ownerId, ownerId),
          inArray(embeddingWorks.intentId, intentIds),
          eq(embeddingWorks.configFingerprint, configFingerprint),
          eq(embeddingWorks.consentEpoch, consentEpoch),
          retryFailed
            ? inArray(embeddingWorks.state, [
                'PENDING',
                'LEASED',
                'CALLING',
                'RETRY_WAIT',
                'PUBLISHED',
              ])
            : undefined,
        ),
      );

    // terminal도 제외한다. 동일 epoch의 명시적 실패 재시도는 후속 command에서만 생성한다.
    return new Set(rows.map((row) => row.intentId));
  }

  @Transactional(Propagation.Mandatory)
  async createWorks(
    ownerId: string,
    requestId: string,
    intentIds: string[],
    configFingerprint: string,
    consentEpoch: number,
    reservationId: string,
  ) {
    const previous = await this.transactions.tx
      .select({
        intentId: embeddingWorks.intentId,
        generation: sql<number>`max(${embeddingWorks.generation})`.mapWith(Number),
      })
      .from(embeddingWorks)
      .where(
        and(
          eq(embeddingWorks.ownerId, ownerId),
          inArray(embeddingWorks.intentId, intentIds),
          eq(embeddingWorks.configFingerprint, configFingerprint),
          eq(embeddingWorks.consentEpoch, consentEpoch),
        ),
      )
      .groupBy(embeddingWorks.intentId);
    const generations = new Map(previous.map((work) => [work.intentId, work.generation]));
    const rows = intentIds.map((intentId) => ({
      id: randomUUID(),
      ownerId,
      intentId,
      activationId: requestId,
      configFingerprint,
      consentEpoch,
      reservationId,
      generation: (generations.get(intentId) ?? 0) + 1,
    }));

    await this.transactions.tx.insert(embeddingWorks).values(rows);

    return rows.map((row) => row.id);
  }

  @Transactional(Propagation.Mandatory)
  async recordActivation(
    ownerId: string,
    fingerprint: string,
    configFingerprint: string,
    result: EmbeddingActivationResult,
    includeExisting = false,
  ) {
    const tx = this.transactions.tx;

    await tx
      .insert(embeddingActivations)
      .values({
        ownerId,
        configFingerprint,
        consentEpoch: result.consentEpoch,
        requestId: result.requestId,
        includeExisting,
      })
      .onConflictDoUpdate({
        target: embeddingActivations.ownerId,
        set: {
          configFingerprint,
          consentEpoch: result.consentEpoch,
          requestId: result.requestId,
          // 동일 동의의 재시도는 이미 승인된 전송 범위를 축소하지 않는다.
          includeExisting: sql`case when ${embeddingActivations.configFingerprint} = ${configFingerprint}
            and ${embeddingActivations.consentEpoch} = ${result.consentEpoch}
            then ${embeddingActivations.includeExisting} or ${includeExisting}
            else ${includeExisting} end`,
          intentCursor: null,
          enabledAt: sql`case when ${embeddingActivations.configFingerprint} = ${configFingerprint}
            and ${embeddingActivations.consentEpoch} = ${result.consentEpoch}
            then ${embeddingActivations.enabledAt} else now() end`,
          scanAfter: sql`now()`,
        },
      });
    await tx.insert(embeddingActivationReceipts).values({
      id: randomUUID(),
      ownerId,
      fingerprint,
      configFingerprint,
      ...result,
      reservedMaximum: BigInt(result.reservedMaximum),
    });
  }

  async canDeliver(ownerId: string, workId: string) {
    const [work] = await this.db
      .select({ id: embeddingWorks.id })
      .from(embeddingWorks)
      .where(
        and(
          eq(embeddingWorks.ownerId, ownerId),
          eq(embeddingWorks.id, workId),
          eq(embeddingWorks.state, 'PENDING'),
          lte(embeddingWorks.nextAttemptAt, sql`now()`),
        ),
      );

    return work !== undefined;
  }

  async states(ownerId: string, intentIds: string[], configuration: string, epoch: number) {
    if (!intentIds.length) {
      return [];
    }

    const rows = await this.transactions.tx
      .select({
        intentId: embeddingWorks.intentId,
        state: embeddingWorks.state,
        failure: embeddingWorks.lastFailure,
      })
      .from(embeddingWorks)
      .where(
        and(
          eq(embeddingWorks.ownerId, ownerId),
          inArray(embeddingWorks.intentId, intentIds),
          eq(embeddingWorks.configFingerprint, configuration),
          eq(embeddingWorks.consentEpoch, epoch),
        ),
      )
      .orderBy(desc(embeddingWorks.generation));
    const latest = new Map<string, (typeof rows)[number]>();

    for (const row of rows) {
      if (!latest.has(row.intentId)) {
        latest.set(row.intentId, row);
      }
    }

    return [...latest.values()];
  }
}
