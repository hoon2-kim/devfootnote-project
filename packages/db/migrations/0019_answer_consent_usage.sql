CREATE TABLE "usage_answer_consents" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"config_fingerprint" text,
	"policy_version" text,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "answer_consent_epoch_nonnegative" CHECK ("usage_answer_consents"."epoch" >= 0),
	CONSTRAINT "answer_consent_grant_identity" CHECK ("usage_answer_consents"."granted_at" is null or ("usage_answer_consents"."epoch" > 0 and "usage_answer_consents"."config_fingerprint" is not null and "usage_answer_consents"."policy_version" is not null))
);
--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "usage_answer_consents" ADD CONSTRAINT "usage_answer_consents_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD CONSTRAINT "ai_reservation_usage" CHECK (("usage_embedding_reservations"."input_tokens" is null and "usage_embedding_reservations"."output_tokens" is null) or ("usage_embedding_reservations"."input_tokens" is not null and "usage_embedding_reservations"."output_tokens" is not null and "usage_embedding_reservations"."input_tokens" >= 0 and "usage_embedding_reservations"."output_tokens" >= 0));