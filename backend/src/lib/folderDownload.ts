import { prisma } from "./prisma";
import type { ZipPhoto } from "./folderZip";

/**
 * Shared "which photos are downloadable + how many is too many" logic for the
 * bulk download-all endpoints (specs/folder-mgmt-download-search.md PART P5),
 * used by BOTH the owner (routes/folders.ts) and guest (routes/guest.ts)
 * routes so Z3 (the cap) and Z4 (the inclusion rule) are enforced identically
 * and are unit-testable in one place.
 */

/**
 * Z3 — inline-stream guard cap. A folder with more than this many downloadable
 * photos is rejected with 409 BEFORE any byte is streamed ("narrow it down").
 * Async (BullMQ-built stored zip) is deferred until real usage hits this cap.
 */
export const DOWNLOAD_ALL_MAX_PHOTOS = 500;

/**
 * Z4 — only photos with a real stored original go in the zip: status must be
 * `done` (a genuinely stored, classified original) and the s3Key non-empty.
 * This SKIPS `failed` (no/partial original), `duplicate` (identical bytes to
 * an already-included original), and the in-flight `pending`/`processing`
 * (no stable original yet). Newest-first for a deterministic archive order.
 *
 * specs/trash-system.md audit row #20 — THE CLEAREST "existing shipped code
 * silently becomes wrong the moment trash exists" case in the whole audit.
 * A soft-deleted photo still has aiClassificationStatus: "done" and a real
 * s3Key (nothing about soft-delete touches those fields) — WITHOUT the added
 * `deletedAt: null` filter below, a trashed-but-not-yet-purged photo would
 * remain zippable through this already-shipped, already-Tester-verified
 * endpoint. The folder itself being trashed is checked separately by the
 * CALLERS (routes/folders.ts, routes/guest.ts) before this is ever reached —
 * this filter only needs to cover the photo's OWN deletedAt, since a photo
 * can be individually soft-deleted while its folder stays live.
 */
export async function queryDownloadablePhotos(folderId: string): Promise<ZipPhoto[]> {
  const photos = await prisma.photo.findMany({
    where: {
      folderId,
      aiClassificationStatus: "done",
      s3Key: { not: "" },
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    select: { s3Key: true, originalFilename: true },
  });
  return photos;
}

export type DownloadPreflight =
  | { ok: true; photos: ZipPhoto[] }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Z6 (empty → 400) + Z3 (over-cap → 409) pre-flight, run BEFORE any byte is
 * written so the ordinary failures stay clean HTTP errors. Returns the exact
 * photo set to stream on success.
 */
export async function preflightFolderDownload(folderId: string): Promise<DownloadPreflight> {
  const photos = await queryDownloadablePhotos(folderId);
  if (photos.length === 0) {
    // Z6 — a valid-but-empty zip is worse than a clean error.
    return { ok: false, status: 400, error: "This folder has no downloadable photos" };
  }
  if (photos.length > DOWNLOAD_ALL_MAX_PHOTOS) {
    // Z3 — refuse to open a giant stream; async variant deferred.
    return {
      ok: false,
      status: 409,
      error: "This folder is too large to download as a single zip — narrow it down",
    };
  }
  return { ok: true, photos };
}
