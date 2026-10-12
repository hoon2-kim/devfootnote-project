ALTER TABLE "indexing_embedding_works" ADD COLUMN "terminal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD COLUMN "cleanup_after" timestamp with time zone DEFAULT now() + interval '90 days' NOT NULL;--> statement-breakpoint
CREATE INDEX "embedding_reservation_cleanup_idx" ON "usage_embedding_reservations" USING btree ("cleanup_after","id");--> statement-breakpoint
-- 과거 종료 시각은 추정하지 않는다. 업그레이드 이후 90일을 더 보존한다.
UPDATE "indexing_embedding_works" SET "terminal_at" = now()
WHERE "state" IN ('PUBLISHED', 'FINAL_FAILED', 'OBSOLETE');--> statement-breakpoint
UPDATE "usage_embedding_reservations" SET "completed_at" = now()
WHERE "state" IN ('settled', 'released', 'expired');
