import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const materials = pgTable(
  'materials',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    // 순환 참조의 deferred composite FK와 account FK는 후속 custom migration이 소유한다.
    currentRevisionId: uuid('current_revision_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('materials_owner_id_unique').on(table.ownerId, table.id),
    index('materials_owner_updated_idx')
      .on(table.ownerId, table.updatedAt, table.id)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const materialRevisions = pgTable(
  'material_revisions',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    materialId: uuid('material_id').notNull(),
    revision: integer('revision').notNull(),
    title: text('title'),
    body: text('body').notNull(),
    note: text('note'),
    context: text('context'),
    sourceUrl: text('source_url'),
    contentFingerprint: text('content_fingerprint').notNull(),
  },
  (table) => [
    unique('revisions_owner_material_id_unique').on(table.ownerId, table.materialId, table.id),
    unique('revisions_material_number_unique').on(table.materialId, table.revision),
    check('revisions_positive_number', sql`${table.revision} > 0`),
    foreignKey({
      columns: [table.ownerId, table.materialId],
      foreignColumns: [materials.ownerId, materials.id],
    }),
  ],
);

export const materialChunks = pgTable(
  'material_chunks',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    materialId: uuid('material_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
  },
  (table) => [
    unique('chunks_revision_ordinal_unique').on(table.revisionId, table.ordinal),
    check(
      'chunks_valid_offsets',
      sql`${table.ordinal} >= 0 and ${table.startOffset} >= 0 and ${table.endOffset} > ${table.startOffset}`,
    ),
    foreignKey({
      columns: [table.ownerId, table.materialId, table.revisionId],
      foreignColumns: [
        materialRevisions.ownerId,
        materialRevisions.materialId,
        materialRevisions.id,
      ],
    }),
  ],
);

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const materialKeywords = pgTable(
  'material_keywords',
  {
    revisionId: uuid('revision_id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    materialId: uuid('material_id').notNull(),
    normalizedText: text('normalized_text').notNull(),
    searchVector: tsvector('search_vector')
      .generatedAlwaysAs(sql`to_tsvector('simple', normalized_text)`)
      .notNull(),
  },
  (table) => [
    index('material_keywords_search_vector_idx').using('gin', table.searchVector),
    foreignKey({
      columns: [table.ownerId, table.materialId, table.revisionId],
      foreignColumns: [
        materialRevisions.ownerId,
        materialRevisions.materialId,
        materialRevisions.id,
      ],
    }),
  ],
);

export const materialReceipts = pgTable(
  'material_request_receipts',
  {
    ownerId: uuid('owner_id').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    materialId: uuid('material_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.ownerId, table.materialId, table.revisionId],
      foreignColumns: [
        materialRevisions.ownerId,
        materialRevisions.materialId,
        materialRevisions.id,
      ],
    }),
  ],
);

export const embeddingIntents = pgTable(
  'embedding_intents',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    materialId: uuid('material_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
  },
  (table) => [
    unique('intents_revision_unique').on(table.revisionId),
    foreignKey({
      columns: [table.ownerId, table.materialId, table.revisionId],
      foreignColumns: [
        materialRevisions.ownerId,
        materialRevisions.materialId,
        materialRevisions.id,
      ],
    }),
  ],
);
