import crypto from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { sniffMimeType } from "../lib/fileSniff";
import { hasLivePermission } from "../lib/guestShareGuard";
import { prisma } from "../lib/prisma";
import { serializableTransaction } from "../lib/serializableTransaction";
import { PhotoProcessingJobData, photoProcessingQueue } from "../lib/queue";
import { putObject } from "../lib/storage";
import { getPresignedDownloadUrl, getPresignedGetUrl } from "../lib/storage";
import { originalKey, thumbnailKey } from "../lib/storageKeys";
import {
  bulkDeletePhotosSchema,
  bulkMovePhotosSchema,
  downloadManyPhotosSchema,
  folderPhotosQuerySchema,
  movePhotoSchema,
  photoRestoreSchema,
} from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";
import { reclassifyRateLimiter } from "../middleware/reclassifyRateLimiter";
import { uploadRateLimiter } from "../middleware/uploadRateLimiter";
import { PHOTO_CARD_SELECT, toPhotoCard } from "../lib/photoCard";
import { computePurgeAt, findLiveFolderByName, generateNonCollidingRecoveredName } from "./folders";
import { preflightDownloadByIds } from "../lib/folderDownload";
import { streamFolderZip } from "../lib/folderZip";

const router = Router();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB ceiling, roadmap-specified

// Memory storage per spec (roadmap's Multer requirement) - the buffer is
// what gets content-sniffed and written to MinIO; nothing touches local disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const THUMBNAIL_SIZES = [150, 400, 1200] as const;

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

router.post(
  "/upload",
  requireAuth,
  uploadRateLimiter,
  // Multer's own error (e.g. file too large) surfaces via the error-handling
  // middleware in app.ts unless we intercept it here for a clean 413.
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "File exceeds the 50MB upload limit" });
        }
        return next(err);
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file provided (expected multipart field 'file')" });
    }

    // Content-sniff by magic bytes - never trust Content-Type header or
    // extension alone (acceptance criteria: a renamed .exe must be rejected).
    const sniffedMime = sniffMimeType(file.buffer);
    if (!sniffedMime) {
      return res.status(400).json({ error: "Unsupported or unrecognized file type" });
    }

    const user = req.user!;
    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const projectedUsage = dbUser.storageUsedBytes + BigInt(file.size);
    if (projectedUsage > dbUser.storageLimitBytes) {
      return res.status(413).json({ error: "Storage quota exceeded" });
    }

    const extension = MIME_TO_EXTENSION[sniffedMime];

    // Create the photo row first to get an id for the storage key, then
    // write the original and patch the row with its real s3Key - keeps
    // the id stable for the key convention (userId/photoId/...).
    // Exact-file hash for the worker's first-pass dedup (cheap - buffer is
    // already in memory). specs/ai-classification.md §5 carry-over b.
    const fileSha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");

    const photo = await prisma.photo.create({
      data: {
        ownerId: user.id,
        s3Key: "", // patched immediately below
        originalFilename: file.originalname,
        mimeType: sniffedMime,
        sizeBytes: file.size,
        fileSha256,
        aiClassificationStatus: "pending",
      },
    });

    const s3Key = originalKey(user.id, photo.id, extension);

    try {
      await putObject(s3Key, file.buffer, sniffedMime);
    } catch (err) {
      // Roll back the row if the MinIO write failed - no orphaned "pending"
      // photo pointing at a nonexistent object.
      await prisma.photo.delete({ where: { id: photo.id } });
      throw err;
    }

    await prisma.$transaction([
      prisma.photo.update({ where: { id: photo.id }, data: { s3Key } }),
      prisma.user.update({
        where: { id: user.id },
        data: { storageUsedBytes: projectedUsage },
      }),
    ]);

    const job = await prisma.processingJob.create({
      data: {
        photoId: photo.id,
        jobType: "pipeline",
        status: "queued",
      },
    });

    const bullJob = await photoProcessingQueue.add(
      "pipeline",
      { photoId: photo.id } satisfies PhotoProcessingJobData,
      { jobId: job.id },
    );

    return res.status(202).json({
      photoId: photo.id,
      jobId: bullJob.id,
      status: "pending",
    });
  }),
);

// GET /api/photos/unfiled — paginated, newest first. User-scoped (NOT
// collection-scoped), so it works even before the user has ever had a
// collection created. Registered BEFORE GET /api/photos/:id so the literal
// "unfiled" path segment isn't swallowed by the :id param route.
//
// Bug fix (reports/2026-07-03_0731.md "New Failures" [High]): a brand-new
// user whose very first photo fails classification or resolves as a
// duplicate — before any collection has ever been created (the default "My
// Photos" collection is only lazily created at successful folder
// assignment, see worker.ts) — had that photo permanently unreachable in
// the Organize UI. GET /api/collections returned [], so the frontend's
// initial-load effect bailed out before ever calling the old
// collection-scoped GET /api/collections/:id/unfiled-photos (which itself
// requires a collection id that doesn't exist yet in this scenario).
//
// That old route's own code comment already noted it was truly scoped by
// ownerId, not collectionId — the collection id was only ever used for an
// ownership check unrelated to the actual query filter. This route is the
// same query, same PHOTO_CARD_SELECT/toPhotoCard shape and pagination
// conventions as GET /api/folders/:id/photos and the (now-superseded)
// GET /api/collections/:id/unfiled-photos, but with no collection
// dependency at all — the correct scope for something that was never
// actually collection-scoped.
//
// The old collection-scoped route is left in place (additive, not migrated)
// since nothing outside this fix depends on removing it: it still works
// correctly once a collection exists, has its own test coverage, and
// removing it would be pure churn with zero risk reduction. The frontend
// (organize/page.tsx) has been switched to call this route instead.
//
// specs/trash-system.md audit row #1: add deletedAt: null. Folder-trashed
// transitive exclusion is moot here — folderId is already null, so there's
// no folder to check.
router.get(
  "/unfiled",
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

    // "Unfiled" means: the owner's photos that are in NO folder, whatever the
    // reason. The load-bearing condition is `folderId: null` — a photo with a
    // folder is filed, full stop, and can never appear here.
    //
    // Fix (reports/mr-drafts/folder-mgmt.md, P4 deviation): the old filter was
    // `aiClassificationStatus IN ('failed','duplicate')`, which only worked by
    // accident (failed/duplicate photos also happen to have folderId null). It
    // silently DROPPED a `done` photo orphaned by DELETE /api/folders/:id (F2
    // moves the folder's photos to folderId = null but leaves status 'done') —
    // that photo had no folder AND wasn't in the status filter, so it was
    // unreachable in the UI, recreating the 2026-07-03 "photos unreachable" bug
    // class and breaking F2's "photos remain reachable" promise.
    //
    // Anchor on folderId: null and admit any TERMINAL status. We exclude the
    // in-flight statuses ('pending'/'processing') rather than enumerating the
    // terminal ones so a future terminal status is surfaced by default:
    // pending/processing photos are only transiently folderId = null while the
    // worker runs — they're mid-pipeline, not unfiled, and surfacing them would
    // be wrong and flickery. Terminal set today: done | failed | duplicate.
    const where: Prisma.PhotoWhereInput = {
      ownerId: req.user!.id,
      folderId: null,
      aiClassificationStatus: { notIn: ["pending", "processing"] },
      deletedAt: null,
    };

    const [total, photos] = await prisma.$transaction([
      prisma.photo.count({ where }),
      prisma.photo.findMany({
        where,
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

// specs/trash-system.md audit row #2: treat deletedAt != null (own OR via
// folder) as 404 — a trashed photo doesn't exist to its normal detail view;
// it's only reachable via the Trash surface. Registered BEFORE the bulk
// endpoints below since neither "unfiled" nor "bulk-delete"/":id/restore"
// collide with the :id param route (bulk-delete/restore are literal
// non-UUID-shaped segments handled by their own explicit routes, matching
// the existing "/unfiled" precedent).
router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({
      where: { id: req.params.id },
      include: { folder: { select: { id: true, name: true, deletedAt: true } } },
    });

    // 404, not 403, on ownership mismatch - never confirm existence to a
    // non-owner (acceptance criteria). Also 404 if trashed (own deletedAt OR
    // its folder's deletedAt — T-folder-photos transitive hide).
    if (
      !photo ||
      photo.ownerId !== req.user!.id ||
      photo.deletedAt != null ||
      photo.folder?.deletedAt != null
    ) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const originalUrl = await getPresignedGetUrl(photo.s3Key, 60);
    // Separate from `original.url` above — that one is used to DISPLAY the
    // photo (lightbox/viewer), so it must never carry a forced-download
    // disposition. This one is only ever used by the "Download" button.
    const downloadUrl = await getPresignedDownloadUrl(photo.s3Key, photo.originalFilename, 60);

    const thumbnails: Record<string, string> = {};
    // Only include thumbnail sizes that exist so far - the worker may not
    // have finished yet, and we never error for that, per spec.
    if (photo.s3ThumbnailKey) {
      for (const size of THUMBNAIL_SIZES) {
        const key = thumbnailKey(photo.ownerId, photo.id, size);
        try {
          thumbnails[String(size)] = await getPresignedGetUrl(key, 60);
        } catch {
          // Object doesn't exist yet for this size - omit rather than error.
        }
      }
    }

    return res.status(200).json({
      id: photo.id,
      status: photo.aiClassificationStatus,
      // Additive (organize UI, design/wireframes/reclassify-ui.svg): a
      // duplicate card's "duplicate of X" label needs the original photo's
      // filename, and this endpoint - the only per-photo detail endpoint -
      // never exposed it before. Owner-only, trivial metadata, same
      // rationale as the exif addition below.
      originalFilename: photo.originalFilename,
      original: { url: originalUrl, expiresInSeconds: 60 },
      download: { url: downloadUrl, expiresInSeconds: 60 },
      thumbnails,
      // Additive fields per specs/ai-classification.md §7 (carry-over c:
      // EXIF is finally Tester-verifiable without DB access; nulls where absent).
      exif: {
        takenAt: photo.exifTakenAt,
        gpsLat: photo.exifGpsLat,
        gpsLng: photo.exifGpsLng,
        cameraMake: photo.exifCameraMake,
        cameraModel: photo.exifCameraModel,
      },
      folder: photo.folder ? { id: photo.folder.id, name: photo.folder.name } : null,
      collectionId: photo.collectionId,
    });
  }),
);

// specs/trash-system.md audit row #3: same treatment as #2 — 404 if deletedAt
// set (own or via folder).
router.get(
  "/:id/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({
      where: { id: req.params.id },
      include: {
        folder: { select: { id: true, name: true, deletedAt: true } },
        // Most recent processing_jobs row (pipeline OR reclassify) - the
        // observability surface for job lifecycle (spec Open Question 11).
        jobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    if (
      !photo ||
      photo.ownerId !== req.user!.id ||
      photo.deletedAt != null ||
      photo.folder?.deletedAt != null
    ) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const latestJob = photo.jobs[0] ?? null;
    const isDuplicate = photo.aiClassificationStatus === "duplicate";

    return res.status(200).json({
      status: photo.aiClassificationStatus,
      aiLabels: photo.aiLabels,
      aiConfidence: photo.aiConfidence,
      folderId: photo.folderId,
      folder: photo.folder ? { id: photo.folder.id, name: photo.folder.name } : null,
      collectionId: photo.collectionId,
      duplicateOfPhotoId: isDuplicate ? photo.duplicateOfPhotoId : null,
      dedupMethod: isDuplicate ? photo.dedupMethod : null,
      job: latestJob
        ? {
            type: latestJob.jobType,
            status: latestJob.status,
            attempts: latestJob.attempts,
            errorMessage: latestJob.errorMessage,
          }
        : null,
    });
  }),
);

// Manual move between folders (specs/ai-classification.md §7). An
// organizational act, not a re-classification: aiClassificationStatus,
// aiLabels, and aiConfidence are deliberately untouched.
// specs/trash-system.md audit row #8: 404 if the PHOTO is trashed; 404 if the
// TARGET folder is trashed (can't move a photo INTO a trashed folder).
router.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = movePhotoSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
    if (!photo || photo.ownerId !== req.user!.id || photo.deletedAt != null) {
      return res.status(404).json({ error: "Photo not found" });
    }

    // Ownership check on the target folder via its collection - 404, never
    // 403, never confirm a foreign folder exists. Also 404 if the target
    // folder is trashed.
    const folder = await prisma.folder.findUnique({
      where: { id: input.folderId },
      include: { collection: { select: { id: true, ownerId: true } } },
    });
    if (!folder || folder.collection.ownerId !== req.user!.id || folder.deletedAt != null) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // Serializable + retry (see lib/serializableTransaction.ts): the
    // previousFolderId read below is stale-prone under Read Committed when
    // a worker job assigns this photo concurrently — photoCount would drift.
    await serializableTransaction(async (tx) => {
      const current = await tx.photo.findUnique({
        where: { id: photo.id },
        select: { folderId: true },
      });
      const previousFolderId = current?.folderId ?? null;

      await tx.photo.update({
        where: { id: photo.id },
        data: { folderId: folder.id, collectionId: folder.collection.id },
      });

      if (previousFolderId !== folder.id) {
        if (previousFolderId) {
          // Guarded decrement - never below 0.
          await tx.folder.updateMany({
            where: { id: previousFolderId, photoCount: { gt: 0 } },
            data: { photoCount: { decrement: 1 } },
          });
        }
        await tx.folder.update({
          where: { id: folder.id },
          data: { photoCount: { increment: 1 } },
        });
      }
    });

    return res.status(200).json({ id: photo.id, folderId: folder.id, folderName: folder.name });
  }),
);

// POST /api/photos/bulk-move — move many selected photos (organize
// multi-select "Move to…") into one target folder in one request. Same
// partial-success/per-id shape as bulk-delete: a bad id (not owned, trashed,
// or the target folder itself not owned/trashed) is reported "not_found",
// never leaking why, and doesn't fail the whole batch. Each move reuses the
// exact same guarded-photoCount transaction as the single PATCH /:id move.
router.post(
  "/bulk-move",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = bulkMovePhotosSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const folder = await prisma.folder.findUnique({
      where: { id: input.folderId },
      include: { collection: { select: { id: true, ownerId: true } } },
    });
    if (!folder || folder.collection.ownerId !== req.user!.id || folder.deletedAt != null) {
      return res.status(404).json({ error: "Target folder not found" });
    }

    const moved: string[] = [];
    const failed: { id: string; reason: "not_found" }[] = [];

    for (const photoId of input.photoIds) {
      const photo = await prisma.photo.findUnique({ where: { id: photoId } });
      if (!photo || photo.ownerId !== req.user!.id || photo.deletedAt != null) {
        failed.push({ id: photoId, reason: "not_found" });
        continue;
      }

      await serializableTransaction(async (tx) => {
        const current = await tx.photo.findUnique({ where: { id: photo.id }, select: { folderId: true } });
        const previousFolderId = current?.folderId ?? null;

        await tx.photo.update({
          where: { id: photo.id },
          data: { folderId: folder.id, collectionId: folder.collection.id },
        });

        if (previousFolderId !== folder.id) {
          if (previousFolderId) {
            await tx.folder.updateMany({
              where: { id: previousFolderId, photoCount: { gt: 0 } },
              data: { photoCount: { decrement: 1 } },
            });
          }
          await tx.folder.update({
            where: { id: folder.id },
            data: { photoCount: { increment: 1 } },
          });
        }
      });

      moved.push(photo.id);
    }

    return res.status(200).json({ moved, failed, folderId: folder.id, folderName: folder.name });
  }),
);

// POST /api/photos/download-many — zip a caller-chosen set of photos
// (organize multi-select "Download selected"), reusing the exact same
// streaming zip assembly as folder download-all. An id that isn't owned,
// isn't a stored `done` original, or is trashed is silently excluded (Z4),
// not an error, matching bulk-delete/bulk-move's partial-success spirit —
// but a request where NOTHING is downloadable, or too much is, still gets a
// clean 400/409 (Z6/Z3) before any byte is streamed.
router.post(
  "/download-many",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = downloadManyPhotosSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const pre = await preflightDownloadByIds(input.photoIds, req.user!.id);
    if (!pre.ok) {
      return res.status(pre.status).json({ error: pre.error });
    }

    await streamFolderZip(res, { folderName: "Selected Photos", photos: pre.photos });
  }),
);

// Manual re-enqueue path (specs/ai-classification.md §7): re-runs
// classification + mapping + folder assignment for a photo in a terminal
// state. Covers "retry failed classification" AND the escape hatch for
// pHash false-positive duplicates (Open Question 4).
// specs/trash-system.md audit row #9: 404 if the photo is trashed (can't
// reclassify something in the trash — restore first).
router.post(
  "/:id/reclassify",
  requireAuth,
  reclassifyRateLimiter,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
    if (!photo || photo.ownerId !== req.user!.id || photo.deletedAt != null) {
      return res.status(404).json({ error: "Photo not found" });
    }

    if (photo.aiClassificationStatus === "pending" || photo.aiClassificationStatus === "processing") {
      return res.status(409).json({ error: "Classification already in progress" });
    }

    // Atomic claim (review finding, 2026-07-02): the guard above is a plain
    // check-then-act, so N concurrent requests could all pass it and
    // double-enqueue. This single conditional UPDATE is the real arbiter —
    // only the request whose UPDATE matches (count === 1) may create a job
    // row and enqueue; everyone else gets the 409. The status filter (not
    // the read above) decides, so exactly one claim per terminal->pending
    // transition is possible.
    const claimed = await prisma.photo.updateMany({
      where: {
        id: photo.id,
        ownerId: req.user!.id,
        aiClassificationStatus: { notIn: ["pending", "processing"] },
      },
      data: { aiClassificationStatus: "pending" },
    });
    if (claimed.count !== 1) {
      return res.status(409).json({ error: "Classification already in progress" });
    }

    let job: { id: string } | undefined;
    try {
      job = await prisma.processingJob.create({
        data: {
          photoId: photo.id,
          jobType: "reclassify",
          status: "queued",
        },
      });

      // Same PK-as-BullMQ-id pattern as the upload handler - required by the
      // worker's by-job-id bookkeeping (specs/ai-classification.md §4).
      const bullJob = await photoProcessingQueue.add(
        "reclassify",
        { photoId: photo.id } satisfies PhotoProcessingJobData,
        { jobId: job.id },
      );

      return res.status(202).json({
        photoId: photo.id,
        jobId: bullJob.id,
        status: "pending",
      });
    } catch (err) {
      // Compensation (review finding, 2026-07-02): if the Redis enqueue (or
      // the job-row insert) throws after the claim, the photo would be stuck
      // 'pending' forever — no job exists to move it on, and every future
      // reclassify would 409. Release the claim (only if still 'pending' —
      // nothing else can touch it while we hold the claim, since the job was
      // never enqueued) and remove the orphan job row, then rethrow so
      // asyncHandler returns a 500 with consistent state.
      // Note: photo.aiClassificationStatus is the pre-claim terminal status
      // read above; a terminal->terminal change between that read and the
      // claim would require a full worker cycle in between, which the
      // 'pending' filter here makes harmless anyway (we'd simply not revert).
      if (job) {
        await prisma.processingJob
          .delete({ where: { id: job.id } })
          .catch(() => undefined); // best-effort - never mask the original error
      }
      await prisma.photo
        .updateMany({
          where: { id: photo.id, aiClassificationStatus: "pending" },
          data: { aiClassificationStatus: photo.aiClassificationStatus },
        })
        .catch(() => undefined);
      throw err;
    }
  }),
);

// ---------------------------------------------------------------------------
// specs/trash-system.md — soft-delete (trash), bulk soft-delete, restore.
// ---------------------------------------------------------------------------

/**
 * Shared single-photo soft-delete. Runs T2's guest-share guard, PD3a's
 * cascade-null, PD4's guarded folder-count decrement — all inside one
 * serializableTransaction() — and writes the audit row on success. Returns a
 * discriminated result so both the single-delete route and the bulk-delete
 * loop can share this without duplicating the guard/transaction logic.
 */
type SoftDeleteResult =
  | { ok: true; photoId: string; folderId: string | null; deletedAt: Date }
  | { ok: false; reason: "not_found" | "shared" };

async function softDeletePhoto(photoId: string, ownerId: string): Promise<SoftDeleteResult> {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo || photo.ownerId !== ownerId || photo.deletedAt != null) {
    return { ok: false, reason: "not_found" };
  }

  // T2 (FINAL DECISION, REVERSED): block if the photo's folder is live-shared
  // — same posture as F1, no special-casing for single photos. A photo with
  // no folder (folderId null) has nothing to check.
  if (photo.folderId && (await hasLivePermission(photo.folderId))) {
    return { ok: false, reason: "shared" };
  }

  const deletedAt = new Date();
  const result = await serializableTransaction(async (tx) => {
    // Re-check inside the transaction — tolerate a concurrent delete/restore
    // racing in between the read above and here.
    const claimed = await tx.photo.updateMany({
      where: { id: photo.id, deletedAt: null },
      data: { deletedAt },
    });
    if (claimed.count !== 1) {
      return null;
    }

    // PD3a: cascade-null any OTHER photo's duplicateOfPhotoId pointing at
    // this one — data hygiene, run at delete time (unchanged from
    // photo-deletion.md, independent of hard-vs-soft).
    await tx.photo.updateMany({
      where: { duplicateOfPhotoId: photo.id },
      data: { duplicateOfPhotoId: null },
    });

    // PD4: guarded decrement, never below 0. Only if the photo was actually
    // filed — the folder's live view no longer includes this photo.
    if (photo.folderId) {
      await tx.folder.updateMany({
        where: { id: photo.folderId, photoCount: { gt: 0 } },
        data: { photoCount: { decrement: 1 } },
      });
    }

    return deletedAt;
  });

  if (!result) {
    return { ok: false, reason: "not_found" };
  }

  logAudit({
    actorType: "owner",
    actorId: ownerId,
    ownerId,
    action: "photo_deleted",
    resourceType: "photo",
    resourceId: photo.id,
    metadata: { folderId: photo.folderId, soft: true, deletedAt: deletedAt.toISOString() },
  });

  return { ok: true, photoId: photo.id, folderId: photo.folderId, deletedAt };
}

// DELETE /api/photos/:id — soft-delete (specs/trash-system.md, supersedes
// photo-deletion.md's PD1 hard-delete recommendation). 404 not-owned/
// not-found/already-trashed. T2: 409 if the photo's folder is live-shared.
// Decrements the folder's photoCount; cascade-nulls duplicate references;
// audited; returns { deleted, photoId, folderId, deletedAt, purgeAt }.
router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await softDeletePhoto(req.params.id, req.user!.id);
    if (!result.ok) {
      if (result.reason === "shared") {
        return res
          .status(409)
          .json({ error: "This folder is shared with a guest — revoke the share first" });
      }
      return res.status(404).json({ error: "Photo not found" });
    }
    return res.status(200).json({
      deleted: true,
      photoId: result.photoId,
      folderId: result.folderId,
      deletedAt: result.deletedAt.toISOString(),
      purgeAt: computePurgeAt(result.deletedAt).toISOString(),
    });
  }),
);

// POST /api/photos/bulk-delete — PD5 (reused, unchanged shape): partial
// success, per-id processing (each independently ownership/trashed/T2
// checked — a bad id is uniformly reported "not_found", never leaking WHY,
// same 404-not-403 spirit applied per-item). Batches the photoCount
// decrements per affected folder as one reconciliation pass (each photo's
// own softDeletePhoto call already does its own guarded decrement inside its
// own transaction — "batched" here means "one independent attempt per id in
// a loop", not one shared transaction, matching PD5's per-item-attempt design;
// each decrement is still individually guarded/correct, just not merged into
// a single multi-row transaction, which would fight the per-id "shared"
// guard needing its own read-then-decide anyway).
router.post(
  "/bulk-delete",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = bulkDeletePhotosSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const deleted: string[] = [];
    const failed: { id: string; reason: "not_found" }[] = [];

    for (const photoId of input.photoIds) {
      const result = await softDeletePhoto(photoId, req.user!.id);
      if (result.ok) {
        deleted.push(result.photoId);
      } else {
        // T2's "shared" refusal is reported the same as "not_found" — same
        // 404-not-403 spirit, per-item: don't leak WHY a specific id failed
        // via a different reason string.
        failed.push({ id: photoId, reason: "not_found" });
      }
    }

    return res.status(200).json({ deleted, failed });
  }),
);

// POST /api/photos/:id/restore — specs/trash-system.md FINAL DECISION 5,
// REVISED 2026-07-09 (supersedes the original auto-restore-the-folder
// cascade — Abhishek found in live testing that restoring one photo brought
// back the ENTIRE trashed folder and every other photo in it, which was
// confusing). NEW BEHAVIOR: the trashed folder the photo used to belong to is
// NEVER touched by this endpoint — no restoring it, no touching its
// deletedAt/photoCount/other photos. Only the requested photo comes back, and
// it always lands in a LIVE folder (existing or freshly created):
//   1. 404 if not owned or not currently trashed (unchanged).
//   2. folderId null (was Unfiled) -> restore directly (unchanged).
//   2b. folderId null AND deletedFolderName is set (its folder was
//       PERMANENTLY purged while this photo was already independently
//       trashed, see lib/purge.ts) -> do NOT silently drop it in Unfiled.
//       Ask instead:
//         - no onConflict -> 409 { error: "folder_deleted", originalFolderName,
//           liveFolders: [{id,name}] } (every live folder in the photo's
//           collection, not just a same-name match — the old folder is gone
//           for good, any folder is a fair pick).
//         - onConflict "existing" + targetFolderId -> restore into that
//           folder (must be live and in the same collection).
//         - onConflict "new" (+ optional newName) -> create a brand-new
//           folder (newName or the original folder's name, collision-
//           tolerant) and restore into it.
//       deletedFolderName is cleared the moment the photo actually restores.
//   3. folder is LIVE -> restore directly into it, guarded-increment
//      photoCount inside serializableTransaction() (unchanged, already correct).
//   4. folder is TRASHED -> look for a LIVE folder in the same collection
//      with the trashed folder's name:
//        - found, no onConflict -> 409 conflict (photo NOT restored yet).
//        - found, onConflict "existing" -> restore into conflictingFolderId,
//          guarded-increment its photoCount.
//        - found, onConflict "new" -> create a BRAND NEW folder (newName or
//          auto-generated "<name> (recovered)", bumping a numeric suffix on
//          further collision, capped retry), restore into it (photoCount=1).
//        - not found at all -> skip the conflict step, auto-create a new
//          folder with the ORIGINAL name and restore into it.
//      The original trashed folder's deletedAt/photoCount/other photos are
//      untouched in every branch.
router.post(
  "/:id/restore",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = photoRestoreSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const photo = await prisma.photo.findUnique({
      where: { id: req.params.id },
      include: { folder: true },
    });
    if (!photo || photo.ownerId !== req.user!.id || photo.deletedAt == null) {
      return res.status(404).json({ error: "Photo not found" });
    }

    // Case 2b: this photo's folder was PERMANENTLY purged while the photo
    // was already independently trashed (lib/purge.ts decoupled it, leaving
    // deletedFolderName as a breadcrumb). Never silently drop it in Unfiled —
    // ask the user to pick a live folder or create a new one.
    if (photo.folderId == null && photo.deletedFolderName) {
      if (!input?.onConflict) {
        const liveFolders = await prisma.folder.findMany({
          where: { collectionId: photo.collectionId ?? undefined, deletedAt: null },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        });
        return res.status(409).json({
          error: "folder_deleted",
          originalFolderName: photo.deletedFolderName,
          liveFolders,
        });
      }

      if (input.onConflict === "existing") {
        if (!input.targetFolderId) {
          return res.status(400).json({ error: "targetFolderId is required for onConflict=existing" });
        }
        const target = await prisma.folder.findUnique({ where: { id: input.targetFolderId } });
        if (!target || target.deletedAt != null || target.collectionId !== photo.collectionId) {
          return res.status(404).json({ error: "Target folder not found" });
        }
        return restorePhotoInto(req, res, photo.id, target.id);
      }

      // onConflict === "new": create a brand-new folder (newName or the
      // original folder's name, collision-tolerant) and restore into it.
      const collectionId = photo.collectionId!;
      const desiredName = input.newName ?? photo.deletedFolderName;
      const newFolder = await createFolderTolerantly(collectionId, desiredName);
      return restorePhotoInto(req, res, photo.id, newFolder.id);
    }

    // Case 2: photo was Unfiled when trashed — simple direct restore, no
    // folder or photoCount involved at all.
    if (photo.folderId == null) {
      return restorePhotoInto(req, res, photo.id, null);
    }

    // Case 3: photo's folder is LIVE — restore directly into it (unchanged,
    // already-correct behavior).
    if (photo.folder && photo.folder.deletedAt == null) {
      return restorePhotoInto(req, res, photo.id, photo.folder.id);
    }

    // Case 4: photo's folder is TRASHED — the fix. `trashedFolder` is read
    // ONLY for its name/collectionId; it is never written to below, and none
    // of its other photos are touched.
    const trashedFolder = photo.folder!;
    const conflict = await findLiveFolderByName(trashedFolder.collectionId, trashedFolder.name);

    if (conflict && !input?.onConflict) {
      // A live same-named folder exists and the caller hasn't said what to
      // do — do NOT restore yet, let the frontend offer the choice.
      return res.status(409).json({
        error: "conflict",
        conflictingFolderId: conflict.id,
        conflictingFolderName: conflict.name,
      });
    }

    if (conflict && input?.onConflict === "existing") {
      return restorePhotoInto(req, res, photo.id, conflict.id, {
        movedFromTrashedFolderId: trashedFolder.id,
      });
    }

    // Reaching here means either: (a) conflict + onConflict === "new", or
    // (b) no live same-named folder exists at all — both create a brand-new
    // folder (never the trashed one) and restore the photo into it. Case (b)
    // reuses the original name (nothing to collide with); case (a) uses the
    // caller's newName or an auto-generated "<name> (recovered)" variant.
    const desiredName =
      conflict && input?.onConflict === "new"
        ? input.newName ??
          (await generateNonCollidingRecoveredName(trashedFolder.collectionId, trashedFolder.name))
        : trashedFolder.name;

    const newFolder = await createFolderTolerantly(trashedFolder.collectionId, desiredName);
    return restorePhotoInto(req, res, photo.id, newFolder.id, {
      movedFromTrashedFolderId: trashedFolder.id,
    });
  }),
);

// Creates a new LIVE, empty ("custom") folder for the photo-restore
// new-folder paths. Attempts `name` as-is first (cheap common case — either
// it's the original folder's name with nothing live colliding, or an
// already-Zod-validated caller-supplied/auto-generated name). On a rare P2002
// race (something else created a live folder with this exact name between
// our earlier check and this create), fall back to the numeric-suffix
// auto-naming logic (generateNonCollidingRecoveredName, capped at 20
// attempts) rather than failing the whole restore.
async function createFolderTolerantly(collectionId: string, name: string) {
  try {
    return await prisma.folder.create({
      data: { collectionId, name, categoryType: "custom", photoCount: 0 },
      select: { id: true, name: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const fallbackName = await generateNonCollidingRecoveredName(collectionId, name);
      return prisma.folder.create({
        data: { collectionId, name: fallbackName, categoryType: "custom", photoCount: 0 },
        select: { id: true, name: true },
      });
    }
    throw err;
  }
}

// Clears the photo's own deletedAt and, if landing in a folder, guarded-
// increments that folder's photoCount — all inside one
// serializableTransaction() for consistency with every other counter touch in
// this codebase. `targetFolderId` is the folder the photo will live in after
// restore (may differ from its original folderId — see `extra`). Writes the
// photo_restored audit row and returns the standard restore response shape.
async function restorePhotoInto(
  req: import("express").Request,
  res: import("express").Response,
  photoId: string,
  targetFolderId: string | null,
  extra?: { movedFromTrashedFolderId: string },
) {
  const restored = await serializableTransaction(async (tx) => {
    const claimed = await tx.photo.updateMany({
      where: { id: photoId, deletedAt: { not: null } },
      data: { deletedAt: null, folderId: targetFolderId, deletedFolderName: null },
    });
    if (claimed.count !== 1) return null;
    if (targetFolderId) {
      await tx.folder.update({
        where: { id: targetFolderId },
        data: { photoCount: { increment: 1 } },
      });
    }
    return true;
  });

  if (!restored) {
    return res.status(404).json({ error: "Photo not found" });
  }

  logAudit({
    actorType: "owner",
    actorId: req.user!.id,
    ownerId: req.user!.id,
    action: "photo_restored",
    resourceType: "photo",
    resourceId: photoId,
    metadata: extra ?? {},
  });

  const final = await prisma.photo.findUnique({
    where: { id: photoId },
    include: { folder: { select: { id: true, name: true } } },
  });

  return res.status(200).json({
    restored: true,
    id: final!.id,
    folderId: final!.folderId,
    folder: final!.folder ? { id: final!.folder.id, name: final!.folder.name } : null,
  });
}

export default router;
export { THUMBNAIL_SIZES, MAX_UPLOAD_BYTES };
// Re-exported for backward compatibility (worker.ts, routes/folders.ts
// import these from here) - the real implementations now live in
// lib/storageKeys.ts to avoid a circular import with lib/photoCard.ts.
export { thumbnailKey, originalKey };
