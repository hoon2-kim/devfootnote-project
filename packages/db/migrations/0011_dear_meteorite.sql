CREATE TABLE "indexing_activation_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"config_fingerprint" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"work_ids" uuid[] NOT NULL,
	"reserved_maximum" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_activation_request_unique" UNIQUE("owner_id","request_id"),
	CONSTRAINT "embedding_activation_receipt_bounds" CHECK ("indexing_activation_receipts"."consent_epoch" > 0 and "indexing_activation_receipts"."reserved_maximum" >= 0)
);
--> statement-breakpoint
CREATE TABLE "indexing_embedding_activations" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"config_fingerprint" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"request_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_embedding_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"unit_scale" integer NOT NULL,
	"limit" bigint NOT NULL,
	CONSTRAINT "embedding_budget_bounds" CHECK ("usage_embedding_budgets"."limit" > 0 and "usage_embedding_budgets"."unit_scale" > 0 and "usage_embedding_budgets"."period_end" > "usage_embedding_budgets"."period_start")
);
--> statement-breakpoint
CREATE TABLE "usage_embedding_consents" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"config_fingerprint" text,
	"policy_version" text,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "embedding_consent_epoch_nonnegative" CHECK ("usage_embedding_consents"."epoch" >= 0),
	CONSTRAINT "embedding_consent_grant_identity" CHECK ("usage_embedding_consents"."granted_at" is null or ("usage_embedding_consents"."epoch" > 0 and "usage_embedding_consents"."config_fingerprint" is not null and "usage_embedding_consents"."policy_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "usage_embedding_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"config_fingerprint" text NOT NULL,
	"consent_epoch" integer NOT NULL,
	"reserved_maximum" bigint NOT NULL,
	"pricing_snapshot" jsonb NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"settled_amount" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "embedding_reservation_request_unique" UNIQUE("owner_id","request_id"),
	CONSTRAINT "embedding_reservation_owner_identity" UNIQUE("owner_id","id"),
	CONSTRAINT "embedding_reservation_bounds" CHECK ("usage_embedding_reservations"."reserved_maximum" > 0 and "usage_embedding_reservations"."consent_epoch" > 0 and "usage_embedding_reservations"."expires_at" > "usage_embedding_reservations"."created_at"),
	CONSTRAINT "embedding_reservation_state" CHECK ("usage_embedding_reservations"."state" in ('reserved', 'released', 'expired', 'settled')),
	CONSTRAINT "embedding_reservation_settlement" CHECK (("usage_embedding_reservations"."state" = 'settled') = ("usage_embedding_reservations"."settled_amount" is not null) and ("usage_embedding_reservations"."settled_amount" is null or ("usage_embedding_reservations"."settled_amount" >= 0 and "usage_embedding_reservations"."settled_amount" <= "usage_embedding_reservations"."reserved_maximum")))
);
--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD COLUMN "reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "indexing_activation_receipts" ADD CONSTRAINT "indexing_activation_receipts_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexing_embedding_activations" ADD CONSTRAINT "indexing_embedding_activations_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_embedding_consents" ADD CONSTRAINT "usage_embedding_consents_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD CONSTRAINT "usage_embedding_reservations_owner_id_accounts_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD CONSTRAINT "usage_embedding_reservations_budget_id_usage_embedding_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."usage_embedding_budgets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embedding_reservation_budget_idx" ON "usage_embedding_reservations" USING btree ("budget_id","state","expires_at");--> statement-breakpoint
ALTER TABLE "indexing_embedding_works" ADD CONSTRAINT "indexing_embedding_works_owner_id_reservation_id_usage_embedding_reservations_owner_id_id_fk" FOREIGN KEY ("owner_id","reservation_id") REFERENCES "public"."usage_embedding_reservations"("owner_id","id") ON DELETE no action ON UPDATE no action;