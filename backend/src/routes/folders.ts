import { Router } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/prisma";
import { getPresignedGetUrl } from "../lib/storage";
import { folderPhotosQuerySchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";
import { thumbnailKey } from "./photos";

/**
 * Folders routes (specs/ai-classification.md §6). This pass ships only the
 * minimal data source the reclassification UI (and Tester) needs — NOT the
 * Week 7-8 folder browser. Thumbnails are pre-signed 60s-TTL URLs only,
 * never a raw storage key.
 */
const router = Router();

// Shared select + shape for a folder-photos-style listing response. Used by
// both GET /api/folders/:id/photos and (organize-UI addition, see
// routes/collections.ts) GET /api/collections/:id/unfiled-photos, so the two
// "list photos as cards" call sites stay in lockstep.
const PHOTO_CARD_SELECT = {
  id: true,
  ownerId: true,
  originalFilename: true,
  aiClassificationStatus: true,
  aiLabels: true,
  aiConfidence: true,
  s3ThumbnailKey: true,
  duplicateOfPhotoId: true,
  dedupMethod: true,
} satisfies Prisma.PhotoSelect;

type PhotoCardRow = Prisma.PhotoGetPayload<{ select: typeof PHOTO_CARD_SELECT }>;

async function toPhotoCard(photo: PhotoCardRow) {
  const isDuplicate = photo.aiClassificationStatus === "duplicate";
  return {
    id: photo.id,
    originalFilename: photo.originalFilename,
    status: photo.aiClassificationStatus,
    aiLabels: photo.aiLabels,
    aiConfidence: photo.aiConfidence,
    // Additive fields (organize UI, design/wireframes/reclassify-ui.svg):
    // the "duplicate of X (method)" label needs both. Only meaningful when
    // status is duplicate; null otherwise, same null-vs-error convention as
    // the rest of this codebase's additive fields.
    duplicateOfPhotoId: isDuplicate ? photo.duplicateOfPhotoId : null,
    dedupMethod: isDuplicate ? photo.dedupMethod : null,
    // 150px thumbnail as a pre-signed 60s-TTL URL; null if the worker
    // hasn't generated thumbnails yet. Never a raw storage key.
    thumbnailUrl: photo.s3ThumbnailKey
      ? await getPresignedGetUrl(thumbnailKey(photo.ownerId, photo.id, 150), 60)
      : null,
  };
}

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
