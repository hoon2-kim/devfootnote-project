import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './auth.js';

// 답변 생성은 임베딩과 별도의 명시적 전송 동의를 요구한다.
export const answerConsents = pgTable(
  'usage_answer_consents',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(() => accounts.id),
    epoch: integer('epoch').notNull().default(0),
    configFingerprint: text('config_fingerprint'),
    policyVersion: text('policy_version'),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    check('answer_consent_epoch_nonnegative', sql`${table.epoch} >= 0`),
    check(
      'answer_consent_grant_identity',
      sql`${table.grantedAt} is null or (${table.epoch} > 0 and ${table.configFingerprint} is not null and ${table.policyVersion} is not null)`,
    ),
  ],
);

// 현재 slice는 embedding 동의만 다룬다. 답변용 동의와 정산은 해당 기능에서 추가한다.
export const embeddingConsents = pgTable(
  'usage_embedding_consents',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(() => accounts.id),
    epoch: integer('epoch').notNull().default(0),
    configFingerprint: text('config_fingerprint'),
    policyVersion: text('policy_version'),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    check('embedding_consent_epoch_nonnegative', sql`${table.epoch} >= 0`),
    check(
      'embedding_consent_grant_identity',
      sql`${table.grantedAt} is null or (${table.epoch} > 0 and ${table.configFingerprint} is not null and ${table.policyVersion} is not null)`,
    ),
  ],
);

// attempt ID는 비용 멱등 키다. usage가 indexing 테이블을 역참조하지 않도록 FK 대신 공개 호출 경계에서 결합한다.
export const embeddingCallReceipts = pgTable(
  'usage_embedding_call_receipts',
  {
    attemptId: uuid('attempt_id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    tokens: integer('tokens'),
    amount: bigint('amount', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.reservationId],
      foreignColumns: [embeddingReservations.ownerId, embeddingReservations.id],
    }),
    index('embedding_call_reservation_idx').on(table.reservationId),
    check('embedding_call_usage_pair', sql`(${table.tokens} is null) = (${table.amount} is null)`),
    check('embedding_call_usage_bounds', sql`${table.tokens} > 0 and ${table.amount} >= 0`),
  ],
);

// budget ID는 승인 설정이 지정한다. owner/config가 바뀌었다고 서비스 예산을 새로 만들지 않는다.
export const embeddingBudgets = pgTable(
  'usage_embedding_budgets',
  {
    id: uuid('id').primaryKey(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    currency: text('currency').notNull(),
    unitScale: integer('unit_scale').notNull(),
    limit: bigint('limit', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    check(
      'embedding_budget_bounds',
      sql`${table.limit} > 0 and ${table.unitScale} > 0 and ${table.periodEnd} > ${table.periodStart}`,
    ),
  ],
);

export const embeddingReservations = pgTable(
  'usage_embedding_reservations',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => accounts.id),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => embeddingBudgets.id),
    requestId: uuid('request_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    configFingerprint: text('config_fingerprint').notNull(),
    purpose: text('purpose', { enum: ['embedding', 'grounded-answer'] })
      .default('embedding')
      .notNull(),
    consentEpoch: integer('consent_epoch').notNull(),
    reservedMaximum: bigint('reserved_maximum', { mode: 'bigint' }).notNull(),
    pricingSnapshot: jsonb('pricing_snapshot')
      .$type<{
        version: string;
        currency: string;
        unitScale: number;
        maximumPerChunk?: string;
        pricePerToken?: string;
        inputPricePerToken?: string;
        outputPricePerToken?: string;
        requestMaximum?: string;
      }>()
      .notNull(),
    state: text('state', { enum: ['reserved', 'released', 'expired', 'settled'] })
      .notNull()
      .default('reserved'),
    settledAmount: bigint('settled_amount', { mode: 'bigint' }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    exposureStartedAt: timestamp('exposure_started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cleanupAfter: timestamp('cleanup_after', { withTimezone: true })
      .default(sql`now() + interval '90 days'`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('embedding_reservation_request_unique').on(
      table.ownerId,
      table.purpose,
      table.requestId,
    ),
    unique('embedding_reservation_owner_identity').on(table.ownerId, table.id),
    check('ai_reservation_purpose', sql`${table.purpose} in ('embedding', 'grounded-answer')`),
    check(
      'ai_reservation_usage',
      sql`(${table.inputTokens} is null and ${table.outputTokens} is null) or (${table.inputTokens} is not null and ${table.outputTokens} is not null and ${table.inputTokens} >= 0 and ${table.outputTokens} >= 0)`,
    ),
    index('embedding_reservation_budget_idx').on(table.budgetId, table.state, table.expiresAt),
    index('embedding_reservation_cleanup_idx').on(table.cleanupAfter, table.id),
    check(
      'embedding_reservation_bounds',
      sql`${table.reservedMaximum} > 0 and ${table.consentEpoch} > 0 and ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'embedding_reservation_state',
      sql`${table.state} in ('reserved', 'released', 'expired', 'settled')`,
    ),
    check(
      'embedding_reservation_settlement',
      sql`(${table.state} = 'settled') = (${table.settledAmount} is not null) and (${table.settledAmount} is null or (${table.settledAmount} >= 0 and ${table.settledAmount} <= ${table.reservedMaximum}))`,
    ),
  ],
);
