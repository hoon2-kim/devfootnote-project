CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- 한국어 부분 문자열은 trigram, 영문/식별자 토큰은 simple full-text로 검색한다.
CREATE INDEX material_keywords_trigram_idx ON material_keywords USING gin (normalized_text gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX material_keywords_fulltext_idx ON material_keywords USING gin (to_tsvector('simple', normalized_text));
