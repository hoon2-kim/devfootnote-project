import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  unique,
} from 'drizzle-orm/pg-core';
import { accounts } from './auth.js';
import { embeddingReservations } from './usage-retention.js';

export const answerStates = [
  'REQUESTED',
  'RESERVED',
  'RUNNING',
  'PUBLISHED',
  'NO_ANSWER',
  'FAILED',
  'EXPIRED',
  'INVALIDATED',
] as const;

/** 본문을 복제하지 않는다. immutable chunk를 다시 읽고 hash·offset으로 검증한다. */
export interface AnswerEvidenceSnapshot {
  evidenceId: string;
  materialId: string;
  revisionId: string;
  chunkId: string;
  contentHash: string;
  startOffset: number;
  endOffset: number;
}

export interface StoredAnswerClaim {
  text: string;
  evidenceIds: string[];
}

export const answerRequests = pgTable(
  'answer_requests',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id),
    requestId: uuid('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    configFingerprint: text('config_fingerprint').notNull(),
    consentEpoch: integer('consent_epoch').notNull(),
    reservationId: uuid('reservation_id'),
    state: text('state', { enum: answerStates }).notNull().default('REQUESTED'),
    // worker 실행에만 필요한 질문이며 terminal 전이·만료 정리에서 즉시 비운다.
    question: text('question'),
    evidence: jsonb('evidence').$type<AnswerEvidenceSnapshot[]>().notNull(),
    claims: jsonb('claims').$type<StoredAnswerClaim[]>(),
    failure: text('failure'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    answerExpiresAt: timestamp('answer_expires_at', { withTimezone: true }),
    dedupeExpiresAt: timestamp('dedupe_expires_at', { withTimezone: true }).notNull(),
    scanAfter: timestamp('scan_after', { withTimezone: true }).defaultNow().notNull(),
    answerRetentionSeconds: integer('answer_retention_seconds').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.requestId] }),
    foreignKey({
      columns: [table.ownerId, table.reservationId],
      foreignColumns: [embeddingReservations.ownerId, embeddingReservations.id],
    }),
    index('answer_request_scan_idx').on(table.scanAfter, table.requestId),
    index('answer_request_retention_idx').on(table.dedupeExpiresAt, table.requestId),
    check(
      'answer_request_state',
      sql`${table.state} in ('REQUESTED','RESERVED','RUNNING','PUBLISHED','NO_ANSWER','FAILED','EXPIRED','INVALIDATED')`,
    ),
    check(
      'answer_request_retention',
      sql`${table.answerRetentionSeconds} > 0 and ${table.expiresAt} > ${table.createdAt} and ${table.dedupeExpiresAt} > ${table.expiresAt} and (${table.answerExpiresAt} is null or ${table.dedupeExpiresAt} > ${table.answerExpiresAt})`,
    ),
    check(
      'answer_request_terminal_content',
      sql`${table.state} in ('REQUESTED','RESERVED','RUNNING') or ${table.question} is null`,
    ),
  ],
);

export const answerAttempts = pgTable(
  'answer_call_attempts',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    requestId: uuid('request_id').notNull(),
    state: text('state', { enum: ['STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN'] }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.requestId],
      foreignColumns: [answerRequests.ownerId, answerRequests.requestId],
    }).onDelete('cascade'),
    // 무료 답변은 자동 재시도하지 않는다. 응답 유실을 새 호출로 바꾸지 않는다.
    unique('answer_attempt_request_unique').on(table.ownerId, table.requestId),
    check(
      'answer_attempt_state',
      sql`${table.state} in ('STARTED','SUCCEEDED','FAILED','UNKNOWN')`,
    ),
    check(
      'answer_attempt_completion',
      sql`(${table.state} = 'STARTED') = (${table.completedAt} is null)`,
    ),
  ],
);
