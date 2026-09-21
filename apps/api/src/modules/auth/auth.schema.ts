import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
  },
  (table) => [unique().on(table.issuer, table.subject)],
);

// owner_id 가 PK 라 계정당 한 건이다 — 새 로그인이 기존 행을 덮으므로 다기기 동시 로그인은 안 된다.
export const refreshTokens = pgTable(
  'auth_refresh_tokens',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(() => accounts.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('auth_refresh_tokens_expiry_idx').on(table.expiresAt)],
);

// 로그인 이력이 아니라 callback에서 소모하는 임시 OAuth 상태다.
export const oauthStates = pgTable(
  'auth_oauth_states',
  {
    stateHash: text('state_hash').primaryKey(),
    bindingHash: text('binding_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    returnTo: text('return_to').default('/library').notNull(),
  },
  (table) => [index('auth_oauth_states_expiry_idx').on(table.expiresAt)],
);
