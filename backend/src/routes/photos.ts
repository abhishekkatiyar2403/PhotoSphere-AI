import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { sniffMimeType } from "../lib/fileSniff";
import { prisma } from "../lib/prisma";
import { serializableTransaction } from "../lib/serializableTransaction";
import { PhotoProcessingJobData, photoProcessingQueue } from "../lib/queue";
import { putObject } from "../lib/storage";
import { getPresignedGetUrl } from "../lib/storage";
import { movePhotoSchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";
import { reclassifyRateLimiter } from "../middleware/reclassifyRateLimiter";
import { uploadRateLimiter } from "../middleware/uploadRateLimiter";

const router = Router();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB ceiling, roadmap-specified

// Memory storage per spec (roadmap's Multer requirement) - the buffer is
// what gets content-sniffed and written to MinIO; nothing touches local disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const THUMBNAIL_SIZES = [150, 400, 1200] as const;

function thumbnailKey(ownerId: string, photoId: string, size: number): string {
  return `${ownerId}/${photoId}/thumb_${size}.jpg`;
}

function originalKey(ownerId: string, photoId: string, extension: string): string {
  return `${ownerId}/${photoId}/original.${extension}`;
}

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

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({
      where: { id: req.params.id },
      include: { folder: { select: { id: true, name: true } } },
    });

    // 404, not 403, on ownership mismatch - never confirm existence to a
    // non-owner (acceptance criteria).
    if (!photo || photo.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const originalUrl = await getPresignedGetUrl(photo.s3Key, 60);

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
      original: { url: originalUrl, expiresInSeconds: 60 },
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

router.get(
  "/:id/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({
      where: { id: req.params.id },
      include: {
        folder: { select: { id: true, name: true } },
        // Most recent processing_jobs row (pipeline OR reclassify) - the
        // observability surface for job lifecycle (spec Open Question 11).
        jobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    if (!photo || photo.ownerId !== req.user!.id) {
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
    if (!photo || photo.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Photo not found" });
    }

    // Ownership check on the target folder via its collection - 404, never
    // 403, never confirm a foreign folder exists.
    const folder = await prisma.folder.findUnique({
      where: { id: input.folderId },
      include: { collection: { select: { id: true, ownerId: true } } },
    });
    if (!folder || folder.collection.ownerId !== req.user!.id) {
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

// Manual re-enqueue path (specs/ai-classification.md §7): re-runs
// classification + mapping + folder assignment for a photo in a terminal
// state. Covers "retry failed classification" AND the escape hatch for
// pHash false-positive duplicates (Open Question 4).
router.post(
  "/:id/reclassify",
  requireAuth,
  reclassifyRateLimiter,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
    if (!photo || photo.ownerId !== req.user!.id) {
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

export default router;
export { THUMBNAIL_SIZES, thumbnailKey, originalKey, MAX_UPLOAD_BYTES };
