ALTER TABLE "auth_login_attempts" DROP COLUMN "nonce";--> statement-breakpoint
ALTER TABLE "auth_login_attempts" DROP COLUMN "verifier";--> statement-breakpoint
ALTER TABLE "auth_login_attempts" DROP COLUMN "callback_url";