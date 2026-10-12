import { sql } from 'drizzle-orm';
import {
  check,
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { embeddingIntents, materialChunks } from './materials.js';
import { accounts } from './auth.js';
import { embeddingReservations } from './usage-retention.js';
import {
  embeddingFailureClasses,
  embeddingMaxAttempts,
  embeddingWorkStates,
} from '../indexing-policy.js';

// 값은 위의 정적 enum만 사용한다. 사용자 입력을 SQL 문자열로 결합하지 않는다.
const failureValues = sql.raw(embeddingFailureClasses.map((value) => `'${value}'`).join(', '));

// work identity는 intent와 분리한다. 같은 intent라도 새 설정·동의·명시적 재시도는 별도 generation이다.
export const embeddingWorks = pgTable(
  'indexing_embedding_works',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    intentId: uuid('intent_id').notNull(),
    configFingerprint: text('config_fingerprint').notNull(),
    consentEpoch: integer('consent_epoch').notNull(),
    generation: integer('generation').notNull(),
    activationId: uuid('activation_id').notNull(),
    reservationId: uuid('reservation_id'),
    state: text('state', {
      enum: embeddingWorkStates,
    })
      .default('PENDING')
      .notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    lastFailure: text('last_failure', { enum: embeddingFailureClasses }),
    deliveryAfter: timestamp('delivery_after', { withTimezone: true }).defaultNow().notNull(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('embedding_work_owner_identity').on(table.ownerId, table.id),
    index('embedding_work_owner_reservation_idx').on(table.ownerId, table.reservationId),
    foreignKey({
      columns: [table.ownerId, table.reservationId],
      foreignColumns: [embeddingReservations.ownerId, embeddingReservations.id],
    }),
    foreignKey({
      columns: [table.ownerId, table.intentId],
      foreignColumns: [embeddingIntents.ownerId, embeddingIntents.id],
    }),
    unique('embedding_work_generation_unique').on(
      table.intentId,
      table.configFingerprint,
      table.consentEpoch,
      table.generation,
    ),
    uniqueIndex('embedding_work_active_unique')
      .on(table.intentId, table.configFingerprint, table.consentEpoch)
      .where(sql`${table.state} in ('PENDING', 'LEASED', 'CALLING', 'RETRY_WAIT', 'PUBLISHED')`),
    index('embedding_work_pending_idx')
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.state} = 'PENDING'`),
    index('embedding_work_recovery_idx')
      .on(table.deliveryAfter, table.id)
      .where(sql`${table.state} in ('PENDING', 'LEASED', 'CALLING', 'RETRY_WAIT')`),
    check(
      'embedding_work_positive_identity',
      sql`${table.consentEpoch} > 0 and ${table.generation} > 0`,
    ),
    check(
      'embedding_work_state',
      sql`${table.state} in ('PENDING', 'LEASED', 'CALLING', 'RETRY_WAIT', 'PUBLISHED', 'FINAL_FAILED', 'OBSOLETE')`,
    ),
    check(
      'embedding_work_lease_pair',
      sql`(${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)`,
    ),
    check(
      'embedding_work_active_lease',
      sql`${table.state} not in ('LEASED', 'CALLING') or ${table.leaseToken} is not null`,
    ),
    check(
      'embedding_work_attempt_bounds',
      sql`${table.attemptCount} between 0 and ${sql.raw(String(embeddingMaxAttempts))}`,
    ),
    check('embedding_work_failure_class', sql`${table.lastFailure} in (${failureValues})`),
  ],
);

export const embeddingAttempts = pgTable(
  'indexing_embedding_attempts',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    workId: uuid('work_id').notNull(),
    number: integer('number').notNull(),
    leaseToken: uuid('lease_token').notNull(),
    outcome: text('outcome', {
      enum: ['STARTED', 'SUCCEEDED', 'RETRYABLE_FAILED', 'FINAL_FAILED', 'UNKNOWN', 'OBSOLETE'],
    }).notNull(),
    failure: text('failure', { enum: embeddingFailureClasses }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'embedding_attempt_owner_work_fk',
      columns: [table.ownerId, table.workId],
      foreignColumns: [embeddingWorks.ownerId, embeddingWorks.id],
    }),
    unique('embedding_attempt_number_unique').on(table.workId, table.number),
    uniqueIndex('embedding_attempt_started_unique')
      .on(table.workId)
      .where(sql`${table.outcome} = 'STARTED'`),
    check(
      'embedding_attempt_number_bounds',
      sql`${table.number} between 1 and ${sql.raw(String(embeddingMaxAttempts))}`,
    ),
    check(
      'embedding_attempt_outcome',
      sql`${table.outcome} in ('STARTED', 'SUCCEEDED', 'RETRYABLE_FAILED', 'FINAL_FAILED', 'UNKNOWN', 'OBSOLETE')`,
    ),
    check(
      'embedding_attempt_finished',
      sql`(${table.outcome} = 'STARTED') = (${table.finishedAt} is null)`,
    ),
    check('embedding_attempt_failure_class', sql`${table.failure} in (${failureValues})`),
  ],
);

// 공개 여부는 이 행의 존재만으로 판단하지 않는다. work의 PUBLISHED와 현재 revision·동의를 함께 검사한다.
export const embeddingVectors = pgTable(
  'indexing_embedding_vectors',
  {
    workId: uuid('work_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    materialId: uuid('material_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    chunkId: uuid('chunk_id').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
    cleanupAfter: timestamp('cleanup_after', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workId, table.chunkId] }),
    index('embedding_vector_cleanup_idx').on(table.cleanupAfter, table.workId, table.chunkId),
    foreignKey({
      columns: [table.ownerId, table.workId],
      foreignColumns: [embeddingWorks.ownerId, embeddingWorks.id],
    }),
    foreignKey({
      name: 'embedding_vector_chunk_identity_fk',
      columns: [table.ownerId, table.materialId, table.revisionId, table.chunkId],
      foreignColumns: [
        materialChunks.ownerId,
        materialChunks.materialId,
        materialChunks.revisionId,
        materialChunks.id,
      ],
    }),
    check('embedding_vector_nonzero', sql`vector_norm(${table.embedding}) > 0`),
  ],
);

export const embeddingActivations = pgTable(
  'indexing_embedding_activations',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(() => accounts.id),
    configFingerprint: text('config_fingerprint').notNull(),
    consentEpoch: integer('consent_epoch').notNull(),
    requestId: uuid('request_id').notNull(),
    scanAfter: timestamp('scan_after', { withTimezone: true }).defaultNow().notNull(),
    intentCursor: uuid('intent_cursor'),
    enabledAt: timestamp('enabled_at', { withTimezone: true }).defaultNow().notNull(),
    includeExisting: boolean('include_existing').default(false).notNull(),
  },
  (table) => [index('embedding_activation_scan_idx').on(table.scanAfter, table.ownerId)],
);

export const embeddingActivationReceipts = pgTable(
  'indexing_activation_receipts',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id),
    requestId: uuid('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    configFingerprint: text('config_fingerprint').notNull(),
    consentEpoch: integer('consent_epoch').notNull(),
    workIds: uuid('work_ids').array().notNull(),
    reservedMaximum: bigint('reserved_maximum', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('embedding_activation_request_unique').on(table.ownerId, table.requestId),
    check(
      'embedding_activation_receipt_bounds',
      sql`${table.consentEpoch} > 0 and ${table.reservedMaximum} >= 0`,
    ),
  ],
);
