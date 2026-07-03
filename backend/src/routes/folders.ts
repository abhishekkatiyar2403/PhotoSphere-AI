import { Router } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { PHOTO_CARD_SELECT, toPhotoCard } from "../lib/photoCard";
import { prisma } from "../lib/prisma";
import { folderPhotosQuerySchema } from "../lib/validation";
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

export default router;
export { PHOTO_CARD_SELECT, toPhotoCard };
