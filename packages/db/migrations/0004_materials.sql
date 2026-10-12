CREATE TABLE "embedding_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"content_fingerprint" text NOT NULL,
	CONSTRAINT "intents_revision_unique" UNIQUE("revision_id")
);
--> statement-breakpoint
CREATE TABLE "material_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	CONSTRAINT "chunks_revision_ordinal_unique" UNIQUE("revision_id","ordinal"),
	CONSTRAINT "chunks_valid_offsets" CHECK ("material_chunks"."ordinal" >= 0 and "material_chunks"."start_offset" >= 0 and "material_chunks"."end_offset" > "material_chunks"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "material_keywords" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"normalized_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_request_receipts" (
	"owner_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"material_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	CONSTRAINT "material_request_receipts_owner_id_idempotency_key_pk" PRIMARY KEY("owner_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "material_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"note" text,
	"context" text,
	"source_url" text,
	"content_fingerprint" text NOT NULL,
	CONSTRAINT "revisions_owner_material_id_unique" UNIQUE("owner_id","material_id","id"),
	CONSTRAINT "revisions_material_number_unique" UNIQUE("material_id","revision"),
	CONSTRAINT "revisions_positive_number" CHECK ("material_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"current_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "materials_owner_id_unique" UNIQUE("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "embedding_intents" ADD CONSTRAINT "embedding_intents_owner_id_material_id_revision_id_material_revisions_owner_id_material_id_id_fk" FOREIGN KEY ("owner_id","material_id","revision_id") REFERENCES "public"."material_revisions"("owner_id","material_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_chunks" ADD CONSTRAINT "material_chunks_owner_id_material_id_revision_id_material_revisions_owner_id_material_id_id_fk" FOREIGN KEY ("owner_id","material_id","revision_id") REFERENCES "public"."material_revisions"("owner_id","material_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_keywords" ADD CONSTRAINT "material_keywords_owner_id_material_id_revision_id_material_revisions_owner_id_material_id_id_fk" FOREIGN KEY ("owner_id","material_id","revision_id") REFERENCES "public"."material_revisions"("owner_id","material_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_request_receipts" ADD CONSTRAINT "material_request_receipts_owner_id_material_id_revision_id_material_revisions_owner_id_material_id_id_fk" FOREIGN KEY ("owner_id","material_id","revision_id") REFERENCES "public"."material_revisions"("owner_id","material_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_revisions" ADD CONSTRAINT "material_revisions_owner_id_material_id_materials_owner_id_id_fk" FOREIGN KEY ("owner_id","material_id") REFERENCES "public"."materials"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "materials_owner_updated_idx" ON "materials" USING btree ("owner_id","updated_at","id") WHERE "materials"."deleted_at" is null;