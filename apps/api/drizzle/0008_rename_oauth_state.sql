ALTER TABLE "auth_login_attempts" RENAME TO "auth_oauth_states";--> statement-breakpoint
ALTER TABLE "auth_oauth_states" RENAME CONSTRAINT "auth_login_attempts_pkey" TO "auth_oauth_states_pkey";--> statement-breakpoint
ALTER INDEX "auth_login_attempts_expiry_idx" RENAME TO "auth_oauth_states_expiry_idx";
