import { Router } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { preflightFolderDownload } from "../lib/folderDownload";
import { streamFolderZip } from "../lib/folderZip";
import { PHOTO_CARD_SELECT, toPhotoCard } from "../lib/photoCard";
import { prisma } from "../lib/prisma";
import { serializableTransaction } from "../lib/serializableTransaction";
import { folderMergeSchema, folderPhotosQuerySchema, folderRenameSchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";

/**
 * Folders routes (specs/ai-classification.md §6). This pass ships only the
 * minimal data source the reclassification UI (and Tester) needs — NOT the
 * Week 7-8 folder browser. Thumbnails are pre-signed 60s-TTL URLs only,
 * never a raw storage key.
 *
 * PHOTO_CARD_SELECT/toPhotoCard moved to lib/photoCard.ts (shared by this
 * file, routes/collections.ts, and routes/photos.ts's new GET
 * /api/photos/unfiled) - kept re-exported below for anything still
 * importing them from here.
 */
const router = Router();

// GET /api/folders/:id/photos — paginated, newest first.
router.get(
  "/:id/photos",
  requireAuth,
  asyncHandler(async (req, res) => {
    let query;
    try {
      query = folderPhotosQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    // Ownership check via folder -> collection -> ownerId. 404, never 403 -
    // never confirm a foreign folder exists.
    const folder = await prisma.folder.findUnique({
      where: { id: req.params.id },
      include: { collection: { select: { ownerId: true } } },
    });
    if (!folder || folder.collection.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Folder not found" });
    }

    const [total, photos] = await prisma.$transaction([
      prisma.photo.count({ where: { folderId: folder.id } }),
      prisma.photo.findMany({
        where: { folderId: folder.id },
        orderBy: { createdAt: "desc" },
        skip: query.offset,
        take: query.limit,
        select: PHOTO_CARD_SELECT,
      }),
    ]);

    const items = await Promise.all(photos.map(toPhotoCard));

    return res.status(200).json({
      photos: items,
      total,
      limit: query.limit,
      offset: query.offset,
    });
  }),
);

// ---------------------------------------------------------------------------
// PART P4 — folder rename / merge / delete (specs/folder-mgmt-download-search.md)
// ---------------------------------------------------------------------------

/**
 * F1 load-bearing guard. Returns true if the folder has ANY live guest
 * `folder_permission` — revokedAt null AND (expiresAt null OR in the future).
 * Merge and delete BOTH run this FIRST and block with 409 while a live share
 * points at the folder, so a shared folder is never silently merged-away
 * (privilege escalation) or severed. Owner revokes the share first, then
 * retries. Mirrors the "live" definition getPermittedFolderIds() enforces.
 */
async function hasLivePermission(folderId: string): Promise<boolean> {
  const now = new Date();
  const live = await prisma.folderPermission.findFirst({
    where: {
      folderId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true },
  });
  return live != null;
}

// Resolve a folder owned by the caller, or null. Ownership via
// folder -> collection -> ownerId (the pattern in GET /:id/photos above).
async function findOwnedFolder(folderId: string, userId: string) {
  const folder = await prisma.folder.findUnique({
    where: { id: folderId },
    include: { collection: { select: { id: true, ownerId: true } } },
  });
  if (!folder || folder.collection.ownerId !== userId) return null;
  return folder;
}

// PATCH /api/folders/:id — rename only (F6: reorder out of scope). Collision
// against @@unique([collectionId, name]) → 409 from the caught P2002, NOT an
// app pre-check (constraint 6). Does not touch photoCount/categoryType/photos/
// permissions. F5: allowed on both ai_generated and custom folders. No audit
// (F4: rename is cosmetic).
router.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = folderRenameSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const folder = await findOwnedFolder(req.params.id, req.user!.id);
    if (!folder) {
      return res.status(404).json({ error: "Folder not found" });
    }

    try {
      const updated = await prisma.folder.update({
        where: { id: folder.id },
        data: { name: input.name },
        select: { id: true, name: true, categoryType: true, photoCount: true, collectionId: true },
      });
      return res.status(200).json(updated);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return res.status(409).json({ error: "A folder with that name already exists" });
      }
      throw err;
    }
  }),
);

// POST /api/folders/:id/merge — merge source A (:id) into target B
// (body.targetFolderId). Both owned (else 404), same collection (F3, else 400),
// not self (else 400). F1 guard runs FIRST (409 if A is live-shared, no data
// moves). The move + BOTH counter reconciliations run in ONE
// serializableTransaction() (constraint 5), re-deriving the moved count inside
// the txn; then A is deleted. F4: one folder_merged audit row, post-commit.
router.post(
  "/:id/merge",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = folderMergeSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    if (input.targetFolderId === req.params.id) {
      return res.status(400).json({ error: "Cannot merge a folder into itself" });
    }

    // BOTH sides resolved via folder -> collection -> ownerId; either not owned
    // by the caller → 404 (never confirm a foreign folder exists).
    const source = await findOwnedFolder(req.params.id, req.user!.id);
    if (!source) {
      return res.status(404).json({ error: "Folder not found" });
    }
    const target = await findOwnedFolder(input.targetFolderId, req.user!.id);
    if (!target) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // F3: same collection only.
    if (source.collectionId !== target.collectionId) {
      return res.status(400).json({ error: "Cannot merge folders across collections" });
    }

    // F1 GUARD FIRST — before any data move.
    if (await hasLivePermission(source.id)) {
      return res
        .status(409)
        .json({ error: "This folder is shared with a guest — revoke the share first" });
    }

    // Move + reconcile BOTH counters, all-or-nothing, at Serializable isolation
    // (retries on P2034). The moved count is RE-DERIVED inside the txn from the
    // updateMany result — never a stale read (constraint 5).
    const movedCount = await serializableTransaction(async (tx) => {
      // Re-read both inside the txn (they could have changed between the
      // ownership check and here). Absence now → treat as gone (0 moved).
      const [a, b] = await Promise.all([
        tx.folder.findUnique({ where: { id: source.id }, select: { id: true } }),
        tx.folder.findUnique({ where: { id: target.id }, select: { id: true } }),
      ]);
      if (!a || !b) return 0;

      const moved = await tx.photo.updateMany({
        where: { folderId: source.id },
        data: { folderId: target.id, collectionId: target.collectionId },
      });

      if (moved.count > 0) {
        await tx.folder.update({
          where: { id: target.id },
          data: { photoCount: { increment: moved.count } },
        });
      }

      // A is now empty; delete it (no live permissions — guarded above; and
      // photos have been reparented, so no cascade takes photos with it).
      await tx.folder.delete({ where: { id: source.id } });

      return moved.count;
    });

    const targetAfter = await prisma.folder.findUnique({
      where: { id: target.id },
      select: { photoCount: true },
    });

    // F4: fire-and-forget, post-commit, success-path only.
    logAudit({
      actorType: "owner",
      actorId: req.user!.id,
      ownerId: req.user!.id,
      action: "folder_merged",
      resourceType: "folder",
      resourceId: target.id,
      metadata: {
        sourceFolderName: source.name,
        targetFolderName: target.name,
        photosMoved: movedCount,
      },
    });

    return res.status(200).json({
      merged: true,
      targetFolderId: target.id,
      photosMoved: movedCount,
      targetPhotoCount: targetAfter?.photoCount ?? 0,
    });
  }),
);

// DELETE /api/folders/:id — delete a folder. F1 guard FIRST (409 if live-shared,
// nothing touched). F2: photos move to Unfiled (folderId = null), NOT
// cascade-deleted — photo rows and MinIO originals survive. Move + delete in one
// serializableTransaction(). F4: one folder_deleted audit row, post-commit.
router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const folder = await findOwnedFolder(req.params.id, req.user!.id);
    if (!folder) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // F1 GUARD FIRST.
    if (await hasLivePermission(folder.id)) {
      return res
        .status(409)
        .json({ error: "This folder is shared with a guest — revoke the share first" });
    }

    const orphaned = await serializableTransaction(async (tx) => {
      const still = await tx.folder.findUnique({ where: { id: folder.id }, select: { id: true } });
      if (!still) return 0;

      // F2: orphan the photos to Unfiled (folderId null). collectionId is left
      // as-is; the Unfiled surface (GET /api/photos/unfiled) scopes on
      // folderId = null, not collectionId. Photo rows + MinIO objects untouched.
      const moved = await tx.photo.updateMany({
        where: { folderId: folder.id },
        data: { folderId: null },
      });

      await tx.folder.delete({ where: { id: folder.id } });
      return moved.count;
    });

    // F4: fire-and-forget, post-commit, success-path only.
    logAudit({
      actorType: "owner",
      actorId: req.user!.id,
      ownerId: req.user!.id,
      action: "folder_deleted",
      resourceType: "folder",
      resourceId: folder.id,
      metadata: {
        folderName: folder.name,
        photosOrphaned: orphaned,
      },
    });

    return res.status(200).json({ deleted: true, photosOrphaned: orphaned });
  }),
);

// ---------------------------------------------------------------------------
// PART P5 — bulk "download all" / folder zip (owner)
// ---------------------------------------------------------------------------

// GET /api/folders/:id/download-all — stream a ZIP of the owner's folder's
// downloadable photos, assembled on-the-fly from authorized MinIO reads (never
// a raw key / pre-signed URL to the client). Ownership via
// folder -> collection -> ownerId → 404 if not owned. Z4: only stored `done`
// originals. Z6: 0 downloadable → 400. Z3: > cap → 409. ALL pre-flight checks
// run BEFORE any byte is written so ordinary failures are clean 404/400/409.
// No audit for the owner's own zip (Z7 / AP1: owner-on-own-data not audited).
router.get(
  "/:id/download-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    const folder = await findOwnedFolder(req.params.id, req.user!.id);
    if (!folder) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // Z6/Z3 pre-flight BEFORE any streaming — clean HTTP errors only here.
    const pre = await preflightFolderDownload(folder.id);
    if (!pre.ok) {
      return res.status(pre.status).json({ error: pre.error });
    }

    // Hand off to the shared streaming assembly. From here bytes flow and no
    // clean JSON error is possible; a mid-stream read failure aborts+destroys
    // (Z5) inside streamFolderZip.
    await streamFolderZip(res, { folderName: folder.name, photos: pre.photos });
  }),
);

export default router;
export { PHOTO_CARD_SELECT, toPhotoCard };
