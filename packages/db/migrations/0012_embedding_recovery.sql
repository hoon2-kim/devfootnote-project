CREATE TABLE "indexing_embedding_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"lease_token" uuid NOT NULL,
	"outcome" text NOT NULL,
	"failure" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "embedding_attempt_number_unique" UNIQUE("work_id","number"),
	CONSTRAINT "embedding_attempt_number_bounds" CHECK ("indexing_embedding_attempts"."number" between 1 and 5),
	CONSTRAINT "embedding_attempt_outcome" CHECK ("indexing_embedding_attempts"."outcome" in ('STARTED', 'RETRYABLE_FAILED', 'FINAL_FAILED', 'UNKNOWN', 'OBSOLETE')),
	CONSTRAINT "embedding_attempt_finished" CHECK (("indexing_embedding_attempts"."outcome" = 'STARTED') = ("indexing_embedding_attempts"."finished_at" is null)),
	CONSTRAINT "embedding_attempt_failure_class" CHECK ("indexing_embedding_attempts"."failure" in ('timeout', 'rate_limited', 'provider_error', 'invalid_response', 'unknown_outcome', 'lease_expired', 'material_obsolete', 'consent_revoked', 'config_changed', 'reservation_expired', 'reservation_missing'))
);
--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD COLUMN "last_failure" text;--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD COLUMN "delivery_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD COLUMN "exposure_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD CONSTRAINT "embedding_work_owner_identity" UNIQUE("owner_id","id");--> statement-breakpoint
ALTER TABLE "indexing_embedding_attempts" ADD CONSTRAINT "embedding_attempt_owner_work_fk" FOREIGN KEY ("owner_id","work_id") REFERENCES "public"."indexing_embedding_works"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_attempt_started_unique" ON "indexing_embedding_attempts" USING btree ("work_id") WHERE "indexing_embedding_attempts"."outcome" = 'STARTED';--> statement-breakpoint
CREATE INDEX "embedding_work_recovery_idx" ON "indexing_embedding_works" USING btree ("delivery_after","id") WHERE "indexing_embedding_works"."state" in ('PENDING', 'LEASED', 'CALLING', 'RETRY_WAIT');--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD CONSTRAINT "embedding_work_attempt_bounds" CHECK ("indexing_embedding_works"."attempt_count" between 0 and 5);--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD CONSTRAINT "embedding_work_failure_class" CHECK ("indexing_embedding_works"."last_failure" in ('timeout', 'rate_limited', 'provider_error', 'invalid_response', 'unknown_outcome', 'lease_expired', 'material_obsolete', 'consent_revoked', 'config_changed', 'reservation_expired', 'reservation_missing'));
