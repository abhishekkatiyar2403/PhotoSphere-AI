import { Router } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { computePurgeAt } from "./folders";
import { purgeFolder, purgePhoto } from "../lib/purge";
import { prisma } from "../lib/prisma";
import { trashListQuerySchema, trashTypeParamSchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";

/**
 * The Trash surface backend (specs/trash-system.md). A NEW dedicated router
 * (T-permanent-route, spec's own recommendation) rather than overloading the
 * existing single-delete endpoints with a "permanent" flag — a stray
 * `?permanent=true` on a normal soft-delete call would be catastrophic and
 * hard to guard against convincingly; a separate route with an obvious,
 * narrow purpose is safer. Owner-only throughout — guests never see or touch
 * the trash (consistent with every guest route being read/download-only).
 */
const router = Router();

function daysRemaining(purgeAt: Date, now: Date): number {
  const ms = purgeAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// GET /api/trash — owner-scoped. T-trash-shape: two sections in one
// response, each item carrying deletedAt + computed purgeAt/daysRemaining
// (derived, T1 — never stored). Paginated per-section.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let query;
    try {
      query = trashListQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;
    const now = new Date();

    const [photoTotal, photos, folderTotal, folders] = await prisma.$transaction([
      prisma.photo.count({ where: { ownerId, deletedAt: { not: null } } }),
      prisma.photo.findMany({
        where: { ownerId, deletedAt: { not: null } },
        orderBy: { deletedAt: "desc" },
        skip: query.offset,
        take: query.limit,
        select: { id: true, originalFilename: true, folderId: true, deletedAt: true },
      }),
      prisma.folder.count({ where: { collection: { ownerId }, deletedAt: { not: null } } }),
      prisma.folder.findMany({
        where: { collection: { ownerId }, deletedAt: { not: null } },
        orderBy: { deletedAt: "desc" },
        skip: query.offset,
        take: query.limit,
        // Trashed-folder photos are NOT separately listed here
        // (T-folder-photos) — photoCount is informational context only.
        select: { id: true, name: true, categoryType: true, photoCount: true, deletedAt: true },
      }),
    ]);

    return res.status(200).json({
      photos: photos.map((p) => {
        const purgeAt = computePurgeAt(p.deletedAt!);
        return {
          id: p.id,
          originalFilename: p.originalFilename,
          folderId: p.folderId,
          deletedAt: p.deletedAt!.toISOString(),
          purgeAt: purgeAt.toISOString(),
          daysRemaining: daysRemaining(purgeAt, now),
        };
      }),
      photoTotal,
      folders: folders.map((f) => {
        const purgeAt = computePurgeAt(f.deletedAt!);
        return {
          id: f.id,
          name: f.name,
          categoryType: f.categoryType,
          photoCount: f.photoCount,
          deletedAt: f.deletedAt!.toISOString(),
          purgeAt: purgeAt.toISOString(),
          daysRemaining: daysRemaining(purgeAt, now),
        };
      }),
      folderTotal,
      limit: query.limit,
      offset: query.offset,
    });
  }),
);

// DELETE /api/trash/:type/:id — permanently purge ONE item now. :type is
// exactly "photo" or "folder" (Zod enum → 400 on anything else). 404 if not
// owned or not currently trashed. Reuses the EXACT hard-delete logic the
// daily auto-purge job also calls (lib/purge.ts) — not duplicated here.
router.delete(
  "/:type/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    let type;
    try {
      type = trashTypeParamSchema.parse(req.params.type);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;

    if (type === "photo") {
      const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
      if (!photo || photo.ownerId !== ownerId || photo.deletedAt == null) {
        return res.status(404).json({ error: "Photo not found" });
      }
      await purgePhoto(photo.id, { trigger: "manual", auditOwnerId: ownerId });
      return res.status(200).json({ purged: true, type: "photo", id: photo.id });
    }

    // type === "folder"
    const folder = await prisma.folder.findUnique({
      where: { id: req.params.id },
      include: { collection: { select: { ownerId: true } } },
    });
    if (!folder || folder.collection.ownerId !== ownerId || folder.deletedAt == null) {
      return res.status(404).json({ error: "Folder not found" });
    }
    await purgeFolder(folder.id, { trigger: "manual" });
    return res.status(200).json({ purged: true, type: "folder", id: folder.id });
  }),
);

// DELETE /api/trash — empty trash. Permanently purges EVERYTHING in the
// owner's trash right now: all trashed photos NOT under a trashed folder
// (avoids double-processing — those photos are purged transitively by their
// folder's cascade below) + all trashed folders (each cascading per T5).
// Owner-scoped only — every query below is ownerId/collection-ownerId
// scoped, so this can never touch another owner's trash. ONE summary audit
// row (non-load-bearing granularity choice per the spec).
router.delete(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user!.id;

    const trashedFolders = await prisma.folder.findMany({
      where: { collection: { ownerId }, deletedAt: { not: null } },
      select: { id: true },
    });
    const trashedPhotosStandalone = await prisma.photo.findMany({
      where: { ownerId, deletedAt: { not: null }, folderId: null },
      select: { id: true },
    });
    // A trashed photo whose folder is ALSO trashed is purged via the
    // folder's own cascade below (purgeFolder purges ALL of a folder's
    // photos, trashed-or-not, per T5) — only photos with folderId: null (or
    // whose folder is still LIVE — an individually-soft-deleted photo inside
    // a live folder) need to be purged standalone here. The folderId: null
    // filter above only covers the "no folder at all" case; also fetch
    // trashed photos whose folder is live.
    const trashedPhotosInLiveFolders = await prisma.photo.findMany({
      where: {
        ownerId,
        deletedAt: { not: null },
        folderId: { not: null },
        folder: { deletedAt: null },
      },
      select: { id: true },
    });

    let photosDeleted = 0;
    for (const p of trashedPhotosStandalone) {
      await purgePhoto(p.id, { trigger: "manual", auditOwnerId: ownerId });
      photosDeleted += 1;
    }
    for (const p of trashedPhotosInLiveFolders) {
      await purgePhoto(p.id, { trigger: "manual", auditOwnerId: ownerId });
      photosDeleted += 1;
    }

    let foldersDeleted = 0;
    for (const f of trashedFolders) {
      // purgeFolder's own cascade purges all its photos (T5) — those are
      // NOT double-counted in photosDeleted above (this loop is disjoint
      // from the two photo loops, which explicitly exclude photos under a
      // trashed folder).
      await purgeFolder(f.id, { trigger: "manual" });
      foldersDeleted += 1;
    }

    logAudit({
      actorType: "owner",
      actorId: ownerId,
      ownerId,
      action: "trash_emptied",
      metadata: { photosDeleted, foldersDeleted },
    });

    return res.status(200).json({ emptied: true, photosDeleted, foldersDeleted });
  }),
);

export default router;
