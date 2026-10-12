ALTER TABLE "material_keywords" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', normalized_text)) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "material_keywords_search_vector_idx" ON "material_keywords" USING gin ("search_vector");
--> statement-breakpoint
-- 0006의 custom expression index는 저장 컬럼 index로 대체한다. trigram index는 유지한다.
DROP INDEX "material_keywords_fulltext_idx";
