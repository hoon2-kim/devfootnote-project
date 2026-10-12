CREATE TABLE "indexing_embedding_vectors" (
	"work_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexing_embedding_vectors_work_id_chunk_id_pk" PRIMARY KEY("work_id","chunk_id"),
	CONSTRAINT "embedding_vector_nonzero" CHECK (vector_norm("indexing_embedding_vectors"."embedding") > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_embedding_call_receipts" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"tokens" integer,
	"amount" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_call_usage_pair" CHECK (("usage_embedding_call_receipts"."tokens" is null) = ("usage_embedding_call_receipts"."amount" is null)),
	CONSTRAINT "embedding_call_usage_bounds" CHECK ("usage_embedding_call_receipts"."tokens" > 0 and "usage_embedding_call_receipts"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "indexing_embedding_attempts" DROP CONSTRAINT "embedding_attempt_outcome";--> statement-breakpoint
ALTER TABLE "material_chunks" ADD CONSTRAINT "chunks_owner_revision_identity" UNIQUE("owner_id","material_id","revision_id","id");--> statement-breakpoint
ALTER TABLE "indexing_embedding_vectors" ADD CONSTRAINT "indexing_embedding_vectors_owner_id_work_id_indexing_embedding_works_owner_id_id_fk" FOREIGN KEY ("owner_id","work_id") REFERENCES "public"."indexing_embedding_works"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexing_embedding_vectors" ADD CONSTRAINT "embedding_vector_chunk_identity_fk" FOREIGN KEY ("owner_id","material_id","revision_id","chunk_id") REFERENCES "public"."material_chunks"("owner_id","material_id","revision_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_embedding_call_receipts" ADD CONSTRAINT "usage_embedding_call_receipts_owner_id_reservation_id_usage_embedding_reservations_owner_id_id_fk" FOREIGN KEY ("owner_id","reservation_id") REFERENCES "public"."usage_embedding_reservations"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "embedding_call_reservation_idx" ON "usage_embedding_call_receipts" USING btree ("reservation_id");--> statement-breakpoint
ALTER TABLE "indexing_embedding_attempts" ADD CONSTRAINT "embedding_attempt_outcome" CHECK ("indexing_embedding_attempts"."outcome" in ('STARTED', 'SUCCEEDED', 'RETRYABLE_FAILED', 'FINAL_FAILED', 'UNKNOWN', 'OBSOLETE'));
