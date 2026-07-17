-- specs/plan-tiered-upload.md PTU1 (RESOLVED, Abhishek 2026-07-13): promote
-- users.plan from a plain TEXT column (default 'free') to a real Postgres
-- enum. Hand-written (not `prisma migrate dev`-generated) because Prisma's
-- default diff for a String->Enum column change is a DROP+re-ADD, which
-- would data-lose every existing row's value — confirmed via psql that every
-- existing row is already exactly 'free' (67/67), so a plain USING cast is
-- safe and lossless here; this migration is written explicitly to preserve
-- that value rather than trust the default drop/recreate diff.

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'pro', 'studio');

-- AlterTable: drop the old text default, cast the column to the new enum
-- type (values are already exactly one of 'free'/'pro'/'studio' for every
-- row, so the cast cannot fail), then set the new enum default.
ALTER TABLE "users" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "plan" TYPE "Plan" USING ("plan"::"Plan");
ALTER TABLE "users" ALTER COLUMN "plan" SET DEFAULT 'free';
