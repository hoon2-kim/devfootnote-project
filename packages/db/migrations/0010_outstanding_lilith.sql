ALTER TABLE "embedding_intents" ADD CONSTRAINT "intents_owner_id_unique" UNIQUE("owner_id","id");
--> statement-breakpoint
CREATE TABLE "indexing_embedding_works" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"config_fingerprint" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"generation" integer NOT NULL,
	"activation_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_work_generation_unique" UNIQUE("intent_id","config_fingerprint","consent_epoch","generation"),
	CONSTRAINT "embedding_work_positive_identity" CHECK ("indexing_embedding_works"."consent_epoch" > 0 and "indexing_embedding_works"."generation" > 0),
	CONSTRAINT "embedding_work_state" CHECK ("indexing_embedding_works"."state" in ('PENDING', 'LEASED', 'CALLING', 'RETRY_WAIT', 'PUBLISHED', 'FINAL_FAILED', 'OBSOLETE')),
	CONSTRAINT "embedding_work_lease_pair" CHECK (("indexing_embedding_works"."lease_token" is null) = ("indexing_embedding_works"."lease_expires_at" is null)),
	CONSTRAINT "embedding_work_active_lease" CHECK ("indexing_embedding_works"."state" not in ('LEASED', 'CALLING') or "indexing_embedding_works"."lease_token" is not null)
);
--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD CONSTRAINT "indexing_embedding_works_owner_id_intent_id_embedding_intents_owner_id_id_fk" FOREIGN KEY ("owner_id","intent_id") REFERENCES "public"."embedding_intents"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_work_active_unique" ON "indexing_embedding_works" USING btree ("intent_id","config_fingerprint","consent_epoch") WHERE "indexing_embedding_works"."state" in ('PENDING', 'LEASED', 'CALLING', 'RETRY_WAIT', 'PUBLISHED');--> statement-breakpoint
CREATE INDEX "embedding_work_pending_idx" ON "indexing_embedding_works" USING btree ("next_attempt_at","id") WHERE "indexing_embedding_works"."state" = 'PENDING';
