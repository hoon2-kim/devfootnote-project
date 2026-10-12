CREATE TABLE "answer_call_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "answer_attempt_state" CHECK ("answer_call_attempts"."state" in ('STARTED','SUCCEEDED','FAILED','UNKNOWN')),
	CONSTRAINT "answer_attempt_completion" CHECK (("answer_call_attempts"."state" = 'STARTED') = ("answer_call_attempts"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "answer_requests" (
	"owner_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"config_fingerprint" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"reservation_id" uuid,
	"state" text DEFAULT 'REQUESTED' NOT NULL,
	"question" text,
	"evidence" jsonb NOT NULL,
	"claims" jsonb,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"answer_expires_at" timestamp with time zone,
	"dedupe_expires_at" timestamp with time zone NOT NULL,
	"scan_after" timestamp with time zone DEFAULT now() NOT NULL,
	"answer_retention_seconds" integer NOT NULL,
	CONSTRAINT "answer_requests_owner_id_request_id_pk" PRIMARY KEY("owner_id","request_id"),
	CONSTRAINT "answer_request_state" CHECK ("answer_requests"."state" in ('REQUESTED','RESERVED','RUNNING','PUBLISHED','NO_ANSWER','FAILED','EXPIRED','INVALIDATED')),
	CONSTRAINT "answer_request_retention" CHECK ("answer_requests"."answer_retention_seconds" > 0 and "answer_requests"."expires_at" > "answer_requests"."created_at" and "answer_requests"."dedupe_expires_at" > "answer_requests"."expires_at" and ("answer_requests"."answer_expires_at" is null or "answer_requests"."dedupe_expires_at" > "answer_requests"."answer_expires_at")),
	CONSTRAINT "answer_request_terminal_content" CHECK ("answer_requests"."state" in ('REQUESTED','RESERVED','RUNNING') or "answer_requests"."question" is null)
);
--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD COLUMN "purpose" text DEFAULT 'embedding' NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_call_attempts" ADD CONSTRAINT "answer_call_attempts_owner_id_request_id_answer_requests_owner_id_request_id_fk" FOREIGN KEY ("owner_id","request_id") REFERENCES "public"."answer_requests"("owner_id","request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_requests" ADD CONSTRAINT "answer_requests_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_requests" ADD CONSTRAINT "answer_requests_owner_id_reservation_id_usage_embedding_reservations_owner_id_id_fk" FOREIGN KEY ("owner_id","reservation_id") REFERENCES "public"."usage_embedding_reservations"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_attempt_request_idx" ON "answer_call_attempts" USING btree ("owner_id","request_id");--> statement-breakpoint
CREATE INDEX "answer_request_pending_idx" ON "answer_requests" USING btree ("scan_after","request_id") WHERE "answer_requests"."state" in ('RESERVED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "answer_request_retention_idx" ON "answer_requests" USING btree ("dedupe_expires_at","request_id");--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD CONSTRAINT "ai_reservation_purpose" CHECK ("usage_embedding_reservations"."purpose" in ('embedding', 'grounded-answer'));