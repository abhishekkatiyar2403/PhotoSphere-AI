import { Router } from "express";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { asyncHandler } from "../lib/asyncHandler";
import { sniffMimeType } from "../lib/fileSniff";
import { prisma } from "../lib/prisma";
import { PhotoProcessingJobData, photoProcessingQueue } from "../lib/queue";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  getObjectStream,
  getPresignedUploadPartUrl,
} from "../lib/storage";
import { abortUploadSchema, completeUploadSchema, initiateUploadSchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";
import { initiateUploadRateLimiter } from "../middleware/initiateUploadRateLimiter";
import { logger } from "../lib/logger";

const router = Router();

// PUB2 (recommended default): fixed 8MB parts, computed the same way
// client-side — comfortably above S3/MinIO's 5MB-per-part minimum (except
// the last part), small enough to keep individual part retries cheap.
const PART_SIZE_BYTES = 8 * 1024 * 1024;

// PUB3 (recommended default): 1 hour, longer than the read-side 60s helpers
// since a part on a slow connection can legitimately take a while and a
// whole batch's issuance-to-completion window can span many minutes.
const PART_URL_TTL_SECONDS = 3600;

// Not itself one of PUB1-10, but implied by the spec's "expiresAt = now +
// UPLOAD_SESSION_TTL_HOURS" language — a session that's still in_progress
// this long after initiate is considered stale by the daily cleanup job
// (lib/uploadSessionCleanupJob.ts).
const UPLOAD_SESSION_TTL_HOURS = 24;

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

function batchOriginalKey(ownerId: string, sessionId: string, clientId: string, extension: string): string {
  // Distinct namespace from the single-file route's originalKey(ownerId,
  // photoId, ext) convention — no photoId exists yet at /initiate time
  // (Photo-row creation is deferred to /complete, PUB6). The Photo row
  // created at /complete simply keeps this key as its s3Key; there is no
  // requirement anywhere that s3Key be derived from the photo's own id.
  return `${ownerId}/batch/${sessionId}/${clientId}/original.${extension}`;
}

function partCountFor(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / PART_SIZE_BYTES));
}

router.use(requireAuth);

// POST /api/upload/initiate
router.post(
  "/initiate",
  initiateUploadRateLimiter,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = initiateUploadSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const user = req.user!;
    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Whole-batch quota check (mirrors the single-file route's pre-check,
    // just summed) — 413, nothing created, no createMultipartUpload calls
    // made against MinIO for any file in this batch.
    const summedBytes = input.files.reduce((sum, f) => sum + f.sizeBytes, 0);
    const projectedUsage = dbUser.storageUsedBytes + BigInt(summedBytes);
    if (projectedUsage > dbUser.storageLimitBytes) {
      return res.status(413).json({ error: "Storage quota exceeded" });
    }

    // Whole-batch duplicate pre-check — respects the trash system: a
    // trashed photo's hash does NOT block a re-upload (deletedAt: null).
    const hashes = input.files.map((f) => f.sha256.toLowerCase());
    const existingByHash = await prisma.photo.findMany({
      where: { ownerId: user.id, fileSha256: { in: hashes }, deletedAt: null },
      select: { id: true, fileSha256: true },
    });
    const existingHashMap = new Map(existingByHash.map((p) => [p.fileSha256, p.id]));

    const duplicates: { clientId: string; existingPhotoId: string }[] = [];
    const nonDuplicateFiles = input.files.filter((f) => {
      const existingPhotoId = existingHashMap.get(f.sha256.toLowerCase());
      if (existingPhotoId) {
        duplicates.push({ clientId: f.clientId, existingPhotoId });
        return false;
      }
      return true;
    });

    const sessionId = randomUUID();
    const nonDuplicateBytes = nonDuplicateFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

    const files: {
      clientId: string;
      key: string;
      uploadId: string;
      partUrls: { partNumber: number; url: string }[];
    }[] = [];

    // Best-effort rollback bookkeeping: if a LATER file's createMultipartUpload
    // call fails, abort every multipart upload already started for THIS
    // initiate call rather than leaving orphaned in-progress uploads with no
    // session/file row pointing at them.
    const startedUploads: { key: string; uploadId: string }[] = [];

    try {
      for (const file of nonDuplicateFiles) {
        const extension = MIME_TO_EXTENSION[file.mimeType] ?? "bin";
        const key = batchOriginalKey(user.id, sessionId, file.clientId, extension);
        const { uploadId } = await createMultipartUpload(key, file.mimeType);
        startedUploads.push({ key, uploadId });

        const partCount = partCountFor(file.sizeBytes);
        const partUrls: { partNumber: number; url: string }[] = [];
        for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
          const url = await getPresignedUploadPartUrl(key, uploadId, partNumber, PART_URL_TTL_SECONDS);
          partUrls.push({ partNumber, url });
        }

        files.push({ clientId: file.clientId, key, uploadId, partUrls });
      }
    } catch (err) {
      await Promise.all(
        startedUploads.map((u) => abortMultipartUpload(u.key, u.uploadId).catch(() => undefined)),
      );
      throw err;
    }

    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_HOURS * 60 * 60 * 1000);

    const session = await prisma.uploadSession.create({
      data: {
        id: sessionId,
        ownerId: user.id,
        collectionId: input.collectionId ?? null,
        totalFiles: nonDuplicateFiles.length,
        totalBytes: BigInt(nonDuplicateBytes),
        status: nonDuplicateFiles.length === 0 ? "completed" : "in_progress",
        expiresAt,
        files: {
          create: nonDuplicateFiles.map((file, i) => ({
            clientId: file.clientId,
            key: files[i].key,
            uploadId: files[i].uploadId,
            sizeBytes: BigInt(file.sizeBytes),
            sha256: file.sha256.toLowerCase(),
            mimeType: file.mimeType,
            originalFilename: file.filename,
            status: "pending",
          })),
        },
      },
    });

    return res.status(201).json({
      sessionId: session.id,
      files,
      duplicates,
    });
  }),
);

// POST /api/upload/complete
router.post(
  "/complete",
  initiateUploadRateLimiter,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = completeUploadSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const session = await prisma.uploadSession.findUnique({ where: { id: input.sessionId } });
    if (!session || session.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Upload session not found" });
    }
    if (session.status !== "in_progress") {
      return res.status(409).json({ error: `Upload session is already ${session.status}` });
    }

    const results: (
      | { clientId: string; photoId: string; status: "queued" }
      | { clientId: string; failed: true; reason: string }
    )[] = [];

    let completedDelta = 0;
    let failedDelta = 0;
    let uploadedBytesDelta = 0n;

    for (const item of input.files) {
      const result = await completeOneFile(session.id, session.ownerId, item);
      results.push(result);
      if ("photoId" in result) {
        completedDelta += 1;
        const file = await prisma.uploadSessionFile.findUnique({
          where: { sessionId_clientId: { sessionId: session.id, clientId: item.clientId } },
        });
        if (file) uploadedBytesDelta += file.sizeBytes;
      } else {
        failedDelta += 1;
      }
    }

    const updated = await prisma.uploadSession.update({
      where: { id: session.id },
      data: {
        completedFiles: { increment: completedDelta },
        failedFiles: { increment: failedDelta },
        uploadedBytes: { increment: uploadedBytesDelta },
      },
    });

    if (updated.completedFiles + updated.failedFiles >= updated.totalFiles) {
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "completed" } });
    }

    return res.status(200).json({ sessionId: session.id, results });
  }),
);

/**
 * Processes ONE file of a /complete call — content-sniff, quota, Photo-row
 * creation, job enqueue — all independently of every other file in the same
 * request (partial-success semantics per spec: one file's failure never
 * blocks the others).
 */
async function completeOneFile(
  sessionId: string,
  ownerId: string,
  item: { clientId: string; parts: { partNumber: number; eTag: string }[] },
): Promise<
  { clientId: string; photoId: string; status: "queued" } | { clientId: string; failed: true; reason: string }
> {
  // Atomic claim (same pattern as the reclassify endpoint's claimed.count
  // check) — guards against the SAME clientId being completed twice by a
  // retried/overlapping chunked /complete call.
  const claimed = await prisma.uploadSessionFile.updateMany({
    where: { sessionId, clientId: item.clientId, status: "pending" },
    data: { status: "completed" }, // optimistic; reverted to failed below on any error
  });
  if (claimed.count !== 1) {
    return { clientId: item.clientId, failed: true, reason: "not_found_or_already_processed" };
  }

  const file = await prisma.uploadSessionFile.findUnique({
    where: { sessionId_clientId: { sessionId, clientId: item.clientId } },
  });
  if (!file) {
    return { clientId: item.clientId, failed: true, reason: "not_found_or_already_processed" };
  }

  const markFailed = async (reason: string) => {
    await prisma.uploadSessionFile.update({ where: { id: file.id }, data: { status: "failed" } });
    return { clientId: item.clientId, failed: true as const, reason };
  };

  try {
    await completeMultipartUpload(file.key, file.uploadId, item.parts);
  } catch (err) {
    logger.error({ err, sessionId, clientId: item.clientId }, "upload/complete: completeMultipartUpload failed");
    return markFailed("assembly_failed");
  }

  // Content-sniff is not possible pre-assembly (the backend never held the
  // bytes) — sniff the assembled object's first few KB immediately after
  // assembly, before creating any Photo row.
  let sniffedMime: ReturnType<typeof sniffMimeType> = null;
  try {
    const head = await readLeadingBytes(file.key, 4096);
    sniffedMime = sniffMimeType(head);
  } catch (err) {
    logger.error({ err, sessionId, clientId: item.clientId }, "upload/complete: post-assembly sniff failed");
    await deleteObject(file.key).catch(() => undefined);
    return markFailed("invalid_file_type");
  }

  if (!sniffedMime) {
    await deleteObject(file.key).catch(() => undefined);
    return markFailed("invalid_file_type");
  }

  try {
    const photo = await prisma.$transaction(async (tx) => {
      const created = await tx.photo.create({
        data: {
          ownerId,
          s3Key: file.key,
          originalFilename: file.originalFilename,
          mimeType: sniffedMime!,
          sizeBytes: Number(file.sizeBytes),
          fileSha256: file.sha256,
          aiClassificationStatus: "pending",
        },
      });
      await tx.user.update({
        where: { id: ownerId },
        data: { storageUsedBytes: { increment: file.sizeBytes } },
      });
      return created;
    });

    const job = await prisma.processingJob.create({
      data: { photoId: photo.id, jobType: "pipeline", status: "queued" },
    });

    await photoProcessingQueue.add(
      "pipeline",
      { photoId: photo.id } satisfies PhotoProcessingJobData,
      { jobId: job.id },
    );

    return { clientId: item.clientId, photoId: photo.id, status: "queued" };
  } catch (err) {
    logger.error({ err, sessionId, clientId: item.clientId }, "upload/complete: Photo-row creation failed");
    return markFailed("internal_error");
  }
}

/** Reads up to `maxBytes` from the start of an object, then stops the
 * stream — never buffers the whole file just to sniff a handful of magic
 * bytes (keeps the batch flow's "0 bytes of file content held by the Node
 * process for longer than necessary" posture even at this one unavoidable
 * post-assembly checkpoint). */
async function readLeadingBytes(key: string, maxBytes: number): Promise<Buffer> {
  const stream = await getObjectStream(key);
  const chunks: Buffer[] = [];
  let total = 0;

  return new Promise<Buffer>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) {
        stream.destroy();
      }
    });
    stream.on("close", () => resolve(Buffer.concat(chunks).subarray(0, maxBytes)));
    stream.on("end", () => resolve(Buffer.concat(chunks).subarray(0, maxBytes)));
    stream.on("error", (err: Error & { code?: string }) => {
      // destroy() itself surfaces as a stream error in some Node versions -
      // treat it as a clean early-stop, not a failure, once we already have
      // enough bytes.
      if (total >= maxBytes) {
        resolve(Buffer.concat(chunks).subarray(0, maxBytes));
      } else {
        reject(err);
      }
    });
  });
}

// DELETE /api/upload/abort
router.delete(
  "/abort",
  initiateUploadRateLimiter,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = abortUploadSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const session = await prisma.uploadSession.findUnique({ where: { id: input.sessionId } });
    if (!session || session.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Upload session not found" });
    }
    if (session.status !== "in_progress") {
      return res.status(409).json({ error: `Upload session is already ${session.status}` });
    }

    const outstanding = await prisma.uploadSessionFile.findMany({
      where: { sessionId: session.id, status: "pending" },
    });

    for (const file of outstanding) {
      try {
        await abortMultipartUpload(file.key, file.uploadId);
      } catch (err) {
        // Best-effort (spec) - log and continue rather than aborting the
        // whole abort over one file's cleanup failure.
        logger.error({ err, sessionId: session.id, fileId: file.id }, "upload/abort: abortMultipartUpload failed");
      }
    }

    await prisma.$transaction([
      prisma.uploadSessionFile.updateMany({
        where: { sessionId: session.id, status: "pending" },
        data: { status: "aborted" },
      }),
      prisma.uploadSession.update({ where: { id: session.id }, data: { status: "aborted" } }),
    ]);

    return res.status(200).json({ sessionId: session.id, aborted: true });
  }),
);

export default router;
