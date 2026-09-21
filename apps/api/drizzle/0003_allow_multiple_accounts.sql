ALTER TABLE "accounts" DROP CONSTRAINT "accounts_singleton_unique";--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_single_owner";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "singleton";