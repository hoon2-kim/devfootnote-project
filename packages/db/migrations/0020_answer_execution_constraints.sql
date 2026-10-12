ALTER TABLE "usage_embedding_reservations" DROP CONSTRAINT "embedding_reservation_request_unique";--> statement-breakpoint
DROP INDEX "answer_attempt_request_idx";--> statement-breakpoint
DROP INDEX "answer_request_pending_idx";--> statement-breakpoint
CREATE INDEX "answer_request_scan_idx" ON "answer_requests" USING btree ("scan_after","request_id");--> statement-breakpoint
ALTER TABLE "usage_embedding_reservations" ADD CONSTRAINT "embedding_reservation_request_unique" UNIQUE("owner_id","purpose","request_id");--> statement-breakpoint
ALTER TABLE "answer_call_attempts" ADD CONSTRAINT "answer_attempt_request_unique" UNIQUE("owner_id","request_id");