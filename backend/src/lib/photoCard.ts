import { Prisma } from "@prisma/client";
import { getPresignedGetUrl } from "./storage";
import { thumbnailKey } from "./storageKeys";
import { rankCategories, CONFIDENCE_THRESHOLD, UNCATEGORIZED } from "./classification/categoryMapping";

/**
 * Shared select + shape for a "list photos as cards" response. Used by
 * GET /api/folders/:id/photos, GET /api/collections/:id/unfiled-photos, and
 * GET /api/photos/unfiled (specs/ai-classification.md §6-7 + the organize-UI
 * additions) so all three "list photos as cards" call sites stay in
 * lockstep. Pulled out of routes/folders.ts into its own module (rather than
 * routes/photos.ts importing from routes/folders.ts, or vice versa) to avoid
 * a circular import between the two route files.
 *
 * specs/trash-system.md: `thumbnailKey` is imported directly from
 * lib/storageKeys.ts (not re-exported via routes/photos.ts) — routes/photos.ts
 * now imports `computePurgeAt`/`restoreFolderInternal` FROM routes/folders.ts
 * (photo-restore's auto-cascade into a trashed folder's restore), and
 * routes/folders.ts imports PHOTO_CARD_SELECT/toPhotoCard from THIS module —
 * so this module importing back from routes/photos.ts would complete a real
 * circular chain (photos.ts -> folders.ts -> photoCard.ts -> photos.ts).
 * storageKeys.ts has zero route-file dependents already, so this is the
 * correct place to break the cycle rather than papering over it.
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
  folderId: true,
  deletedFolderName: true,
  // Only the name, and only for computeReason's "is this actually sitting
  // in the Uncategorized folder?" gate below.
  folder: { select: { name: true } },
  // Most recent processing_jobs row only (pipeline OR reclassify) — the
  // only thing this needs from it is the error message a failed attempt
  // left behind, for the new "why is this Unfiled?" reason string below.
  jobs: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { errorMessage: true },
  },
} satisfies Prisma.PhotoSelect;

export type PhotoCardRow = Prisma.PhotoGetPayload<{ select: typeof PHOTO_CARD_SELECT }>;

/**
 * Human-readable explanation for why a photo ended up somewhere that isn't
 * a normal named category folder — Abhishek's request (2026-07-10): Unfiled
 * and "Uncategorized" cards gave no indication of WHY a photo landed there,
 * forcing a guess between "still broken", "duplicate", or "just an odd
 * photo". Returns null for a normally-filed photo (nothing to explain).
 *
 * The "Uncategorized" case deliberately re-derives its answer from the
 * photo's OWN stored aiLabels/aiConfidence via rankCategories() — the exact
 * function the worker used to decide the folder — rather than trusting the
 * current folder's name. That keeps this genuinely explanatory (it reflects
 * why the ALGORITHM produced Uncategorized) instead of just echoing the
 * folder name back, and stays correct even if the photo was manually moved
 * afterward (rankCategories then returns a real category, so no false
 * "why is this uncategorized" reason is shown for a photo that would
 * actually classify fine).
 */
export function computeReason(
  photo: Pick<
    PhotoCardRow,
    | "aiClassificationStatus"
    | "aiLabels"
    | "aiConfidence"
    | "folderId"
    | "deletedFolderName"
    | "jobs"
    | "dedupMethod"
  > & { folder: { name: string } | null },
): string | null {
  if (photo.aiClassificationStatus === "failed") {
    const lastError = photo.jobs[0]?.errorMessage;
    return lastError
      ? `Classification failed: ${lastError}. Use Reclassify to retry.`
      : "Classification failed after 3 attempts. Use Reclassify to retry.";
  }

  if (photo.aiClassificationStatus === "duplicate") {
    const method = photo.dedupMethod === "phash" ? "visual similarity to" : "being byte-identical to";
    return `Flagged as a duplicate (matched by ${method} an earlier photo). Use "Not a duplicate?" to override.`;
  }

  if (photo.aiClassificationStatus === "done" && photo.folderId === null) {
    return photo.deletedFolderName
      ? `Its folder "${photo.deletedFolderName}" was permanently deleted. Use Move to file it into a folder.`
      : "Not yet filed into a folder. Use Move to pick one.";
  }

  // Only explain "why uncategorized" for a photo actually sitting in the
  // Uncategorized folder — a photo filed anywhere else (including a
  // dynamically-created taxonomy folder whose labels aren't in the curated
  // table, so rankCategories alone can't vouch for it) needs no explanation.
  if (photo.aiClassificationStatus === "done" && photo.folder?.name === UNCATEGORIZED) {
    const confidence = photo.aiConfidence ?? 0;
    const ranked = rankCategories({ labels: photo.aiLabels, confidence });
    if (ranked.length === 0) {
      if (confidence < CONFIDENCE_THRESHOLD) {
        return `Classification confidence was too low (${Math.round(confidence * 100)}%, need ${Math.round(
          CONFIDENCE_THRESHOLD * 100,
        )}%+) to auto-categorize.`;
      }
      return photo.aiLabels.length > 0
        ? `None of the detected labels (${photo.aiLabels.join(", ")}) matched a known category.`
        : "No labels were detected for this photo.";
    }
  }

  return null;
}

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
    // Explains why a card is sitting in Unfiled or "Uncategorized" instead
    // of a normal category folder — null for a normally-filed photo.
    reason: computeReason(photo),
    // 150px thumbnail as a pre-signed 60s-TTL URL; null if the worker
    // hasn't generated thumbnails yet. Never a raw storage key.
    thumbnailUrl: photo.s3ThumbnailKey
      ? await getPresignedGetUrl(thumbnailKey(photo.ownerId, photo.id, 150), 60)
      : null,
  };
}
