import { Prisma } from "@prisma/client";
import { getPresignedGetUrl } from "./storage";
import { thumbnailKey } from "../routes/photos";

/**
 * Shared select + shape for a "list photos as cards" response. Used by
 * GET /api/folders/:id/photos, GET /api/collections/:id/unfiled-photos, and
 * GET /api/photos/unfiled (specs/ai-classification.md §6-7 + the organize-UI
 * additions) so all three "list photos as cards" call sites stay in
 * lockstep. Pulled out of routes/folders.ts into its own module (rather than
 * routes/photos.ts importing from routes/folders.ts, or vice versa) to avoid
 * a circular import between the two route files.
 */
export const PHOTO_CARD_SELECT = {
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

export type PhotoCardRow = Prisma.PhotoGetPayload<{ select: typeof PHOTO_CARD_SELECT }>;

export async function toPhotoCard(photo: PhotoCardRow) {
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
