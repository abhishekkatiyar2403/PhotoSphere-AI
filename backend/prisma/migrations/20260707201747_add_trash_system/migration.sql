-- ============================================================================
-- specs/trash-system.md — Trash system (soft delete + 7-day retention).
--
-- *** LOUD WARNING — HAND-EDITED MIGRATION, DO NOT REGENERATE / "FIX" ***
--
-- T7 (FINAL DECISION 3): the old `folders_collection_id_name_key` plain
-- UNIQUE constraint is dropped (Prisma-generated, below) and is DELIBERATELY
-- NOT replaced with another plain `@@unique`. Instead, this migration adds a
-- Postgres PARTIAL unique index below:
--
--     CREATE UNIQUE INDEX folder_active_name_unique
--       ON folders (collection_id, name) WHERE deleted_at IS NULL;
--
-- Prisma's schema DSL (schema.prisma) CANNOT express a partial index with a
-- WHERE clause — the `@@index([collectionId, name])` in schema.prisma is a
-- PLAIN, NON-UNIQUE index that exists only for query performance. The REAL
-- uniqueness constraint on (collection_id, name) lives ONLY here, in this raw
-- SQL. If a future `prisma migrate dev`/`db push` ever tries to "reconcile"
-- schema.prisma back to a plain `@@unique`, or if someone manually drops this
-- partial index thinking it's redundant with the schema.prisma index, that
-- will SILENTLY remove the T7 fix: a trashed folder would once again occupy
-- its name slot and block creating a new live folder with the same name.
-- See schema.prisma's comment on the Folder model's @@index([collectionId,
-- name]) line for the mirror of this warning.
-- ============================================================================

-- DropIndex
DROP INDEX "folders_collection_id_name_key";

-- AlterTable
ALTER TABLE "folders" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "photos" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "folders_collection_id_name_idx" ON "folders"("collection_id", "name");

-- CreateIndex (T7 — the REAL uniqueness constraint, WHERE deleted_at IS NULL.
-- A trashed folder (deleted_at NOT NULL) no longer occupies its name slot, so
-- a new live folder with the same (collection_id, name) can be created
-- immediately with no 409. Two BOTH-live folders with the same name still
-- correctly collide (P2002 from the app's perspective).)
CREATE UNIQUE INDEX "folder_active_name_unique" ON "folders"("collection_id", "name") WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "folders_deleted_at_idx" ON "folders"("deleted_at");

-- CreateIndex
CREATE INDEX "photos_owner_id_deleted_at_idx" ON "photos"("owner_id", "deleted_at");
