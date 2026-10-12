ALTER TABLE "auth_login_attempts" ADD COLUMN "return_to" text DEFAULT '/library' NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_login_attempts_expiry_idx" ON "auth_login_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_refresh_tokens_expiry_idx" ON "auth_refresh_tokens" USING btree ("expires_at");