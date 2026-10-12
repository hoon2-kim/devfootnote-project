ALTER TABLE "indexing_embedding_activations" ADD COLUMN "scan_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "indexing_embedding_activations" ADD COLUMN "intent_cursor" uuid;--> statement-breakpoint
ALTER TABLE "indexing_embedding_vectors" ADD COLUMN "cleanup_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "embedding_vector_cleanup_idx" ON "indexing_embedding_vectors" USING btree ("cleanup_after","work_id","chunk_id");