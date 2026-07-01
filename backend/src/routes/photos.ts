import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../lib/asyncHandler";
import { sniffMimeType } from "../lib/fileSniff";
import { prisma } from "../lib/prisma";
import { PhotoProcessingJobData, photoProcessingQueue } from "../lib/queue";
import { putObject } from "../lib/storage";
import { getPresignedGetUrl } from "../lib/storage";
import { requireAuth } from "../middleware/requireAuth";
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
    const photo = await prisma.photo.create({
      data: {
        ownerId: user.id,
        s3Key: "", // patched immediately below
        originalFilename: file.originalname,
        mimeType: sniffedMime,
        sizeBytes: file.size,
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
    const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });

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
    });
  }),
);

router.get(
  "/:id/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });

    if (!photo || photo.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Photo not found" });
    }

    return res.status(200).json({
      status: photo.aiClassificationStatus,
      aiLabels: photo.aiLabels,
      aiConfidence: photo.aiConfidence,
      folderId: photo.folderId,
      duplicateOfPhotoId: photo.aiClassificationStatus === "duplicate" ? photo.duplicateOfPhotoId : null,
    });
  }),
);

export default router;
export { THUMBNAIL_SIZES, thumbnailKey, originalKey, MAX_UPLOAD_BYTES };
