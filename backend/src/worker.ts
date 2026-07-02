import dotenv from "dotenv";
import path from "node:path";

// Load the repo-root .env, matching server.ts's convention - this is a
// separate process/entrypoint from the API, so it needs its own env load.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import exifr from "exifr";
import IORedis from "ioredis";
import { Job, Worker } from "bullmq";
import sharp from "sharp";
import { Prisma, type Collection, type Folder, type Photo } from "@prisma/client";
import { classify, type ClassificationResult } from "./lib/classification";
import { mapToCategory } from "./lib/classification/categoryMapping";
import { findExactDuplicateOriginal, findNearDuplicateOriginal } from "./lib/dedup";
import { computePHash } from "./lib/phash";
import { prisma } from "./lib/prisma";
import { serializableTransaction } from "./lib/serializableTransaction";
import { PhotoProcessingJobData, PHOTO_PROCESSING_QUEUE_NAME } from "./lib/queue";
import { ensureBucketExists, getPresignedGetUrl, putObject } from "./lib/storage";
import { thumbnailKey } from "./routes/photos";

const THUMBNAIL_SIZES = [150, 400, 1200] as const;

// Test-only hooks (specs/ai-classification.md §4 "Hook scoping, explicit"):
// - FORCE_FAIL_ applies ONLY to the initial "pipeline" job type, so Tester
//   can exercise the full failed -> reclassify -> done recovery path with
//   the same file.
// - FORCE_LOWCONF_ applies to BOTH job types ("pipeline" and "reclassify"):
//   overrides the mock's confidence to 0.42 pre-mapping, deterministically
//   exercising the <0.60 -> Uncategorized bucket (the mock's real range
//   never dips below 0.60).
const FORCE_FAIL_PREFIX = "FORCE_FAIL_";
const FORCE_LOWCONF_PREFIX = "FORCE_LOWCONF_";
const FORCED_LOW_CONFIDENCE = 0.42;

const DEFAULT_COLLECTION_NAME = "My Photos";

/**
 * Downloads the original from MinIO via a short-lived pre-signed URL
 * (worker never touches storage credentials directly beyond what
 * storage.ts already wraps - reuses the same permission-checked path the
 * API uses, no raw key reads).
 */
async function fetchOriginalBuffer(s3Key: string): Promise<Buffer> {
  const url = await getPresignedGetUrl(s3Key, 60);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch original from storage (status ${res.status})`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * processing_jobs bookkeeping, keyed by the BullMQ job id, which IS the
 * ProcessingJob row's primary key (both enqueue paths pass
 * { jobId: processingJobRow.id }). NEVER key by photoId: once a photo has
 * both a "pipeline" and a "reclassify" row, updateMany-by-photoId clobbers
 * both rows on every worker event (specs/ai-classification.md §4).
 *
 * Tolerates a missing row (P2025): the row can be cascade-deleted (e.g.
 * test cleanup removing a photo) while its BullMQ job is still in Redis —
 * that must not crash the worker via an unhandled rejection in an event
 * handler.
 */
async function updateProcessingJobById(
  jobId: string,
  data: Prisma.ProcessingJobUpdateInput,
): Promise<void> {
  try {
    await prisma.processingJob.update({ where: { id: jobId }, data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return; // row deleted out from under the queue - nothing to book-keep
    }
    throw err;
  }
}

/**
 * Race-safe find-or-create of the user's default collection (lazy, at first
 * folder assignment - spec Open Question 1). Plain find-then-create is NOT
 * safe at worker concurrency 2; the @@unique([ownerId, name]) constraint is
 * the arbiter — on a P2002 collision we refetch the winner's row.
 */
async function findOrCreateDefaultCollection(ownerId: string): Promise<Collection> {
  const where = { ownerId_name: { ownerId, name: DEFAULT_COLLECTION_NAME } };
  const existing = await prisma.collection.findUnique({ where });
  if (existing) return existing;

  try {
    return await prisma.collection.create({
      data: { ownerId, name: DEFAULT_COLLECTION_NAME, isDefault: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await prisma.collection.findUnique({ where });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Race-safe find-or-create of a category folder inside a collection, same
 * catch-unique-violation-and-refetch pattern via @@unique([collectionId, name]).
 */
async function findOrCreateFolder(collectionId: string, name: string): Promise<Folder> {
  const where = { collectionId_name: { collectionId, name } };
  const existing = await prisma.folder.findUnique({ where });
  if (existing) return existing;

  try {
    return await prisma.folder.create({
      data: { collectionId, name, categoryType: "ai_generated" },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await prisma.folder.findUnique({ where });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Pipeline step 5 / reclassify final step (specs/ai-classification.md §4):
 * classification result -> category -> find-or-create default collection +
 * folder -> single transaction updating the photo and reconciling both
 * folders' photoCount (never below 0).
 */
async function assignPhotoToFolder(
  photo: Photo,
  result: ClassificationResult,
  options: { clearDuplicateVerdict: boolean },
): Promise<void> {
  const category = mapToCategory(result);
  const collection = await findOrCreateDefaultCollection(photo.ownerId);
  const folder = await findOrCreateFolder(collection.id, category);

  // Serializable + retry (see lib/serializableTransaction.ts): under plain
  // Read Committed the previousFolderId read below can be stale by the time
  // the photo row is written (concurrent manual move / second worker job),
  // silently drifting photoCount. Serializable makes Postgres abort one of
  // the conflicting transactions instead, and the helper retries it.
  await serializableTransaction(async (tx) => {
    // Re-read folderId inside the transaction so a concurrent manual move
    // can't desync the counts.
    const current = await tx.photo.findUnique({
      where: { id: photo.id },
      select: { folderId: true },
    });
    const previousFolderId = current?.folderId ?? null;

    await tx.photo.update({
      where: { id: photo.id },
      data: {
        aiLabels: result.labels,
        aiConfidence: result.confidence,
        folderId: folder.id,
        collectionId: collection.id,
        aiClassificationStatus: "done",
        ...(options.clearDuplicateVerdict
          ? { duplicateOfPhotoId: null, dedupMethod: null }
          : {}),
      },
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
}

/** Applies the FORCE_LOWCONF_ hook (both job types) before mapping. */
function applyLowConfidenceHook(photo: Photo, result: ClassificationResult): ClassificationResult {
  if (photo.originalFilename.startsWith(FORCE_LOWCONF_PREFIX)) {
    return { labels: result.labels, confidence: FORCED_LOW_CONFIDENCE };
  }
  return result;
}

async function processPhotoPipeline(photoId: string): Promise<void> {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) {
    throw new Error(`Photo ${photoId} not found - cannot process`);
  }

  await prisma.photo.update({
    where: { id: photoId },
    data: { aiClassificationStatus: "processing" },
  });

  // Test-only forced-failure hook - PIPELINE JOBS ONLY (deliberately not
  // applied to "reclassify" jobs, so Tester can exercise the
  // failed -> reclassify -> done recovery path with the same file).
  if (photo.originalFilename.startsWith(FORCE_FAIL_PREFIX)) {
    throw new Error("Forced failure for testing (FORCE_FAIL_ filename prefix)");
  }

  const originalBuffer = await fetchOriginalBuffer(photo.s3Key);

  // --- Step 1: thumbnails (Sharp), in strict order before anything else. ---
  for (const size of THUMBNAIL_SIZES) {
    const thumbBuffer = await sharp(originalBuffer)
      .rotate() // normalize EXIF orientation before resizing
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();

    await putObject(thumbnailKey(photo.ownerId, photo.id, size), thumbBuffer, "image/jpeg");
  }

  await prisma.photo.update({
    where: { id: photoId },
    data: { s3ThumbnailKey: thumbnailKey(photo.ownerId, photo.id, 400) },
  });

  // --- Step 2: EXIF extraction (exifr). Null (not an error) when absent. ---
  let exifTakenAt: Date | null = null;
  let exifGpsLat: number | null = null;
  let exifGpsLng: number | null = null;
  let exifCameraMake: string | null = null;
  let exifCameraModel: string | null = null;

  try {
    const exifData = await exifr.parse(originalBuffer, { gps: true, tiff: true, exif: true });
    if (exifData) {
      exifTakenAt = exifData.DateTimeOriginal ?? exifData.CreateDate ?? null;
      exifGpsLat = typeof exifData.latitude === "number" ? exifData.latitude : null;
      exifGpsLng = typeof exifData.longitude === "number" ? exifData.longitude : null;
      exifCameraMake = exifData.Make ?? null;
      exifCameraModel = exifData.Model ?? null;
    }
  } catch {
    // Corrupt/absent EXIF segment - treat as "no EXIF data", not a pipeline failure.
  }

  await prisma.photo.update({
    where: { id: photoId },
    data: { exifTakenAt, exifGpsLat, exifGpsLng, exifCameraMake, exifCameraModel },
  });

  // --- Step 3: two-phase dedup gate (hard gate - never call classify() past
  // this for a duplicate). Specs/ai-classification.md §5. Both phases live
  // in lib/dedup.ts and enforce ONE invariant: all dedup edges point to
  // strictly-older ((createdAt, id) total order), non-duplicate photos —
  // cycles are structurally impossible, through any mix of sha256/phash
  // edges (see lib/dedup.ts for the full derivation + the 2026-07-02
  // circular-duplicate repro both constraints close).
  //
  // Trade-off (documented in the MR draft): the newer sibling of a rapid
  // double-upload is flagged duplicate-of the older one even if the older
  // hasn't finished its own pipeline yet — the older always proceeds to
  // classify, and if it ends up `failed` the reclassify endpoint remains
  // the escape hatch for the duplicate-flagged sibling.
  let duplicateOfPhotoId: string | null = null;
  let dedupMethod: string | null = null;

  // Phase 1 - exact pass (SHA-256, set by the upload handler at row
  // creation; pre-existing rows keep null and never match).
  if (photo.fileSha256) {
    duplicateOfPhotoId = await findExactDuplicateOriginal(photo, photo.fileSha256);
    if (duplicateOfPhotoId) dedupMethod = "sha256";
  }

  // Phase 2 - near-dup pass (pHash), only when the exact pass found
  // nothing (also skips the pHash computation entirely for exact dups).
  // Degenerate flat-image guard lives inside findNearDuplicateOriginal.
  let phash: string | null = null;
  if (!duplicateOfPhotoId) {
    phash = await computePHash(originalBuffer);
    duplicateOfPhotoId = await findNearDuplicateOriginal(photo, phash);
    if (duplicateOfPhotoId) dedupMethod = "phash";
  }

  if (duplicateOfPhotoId) {
    await prisma.photo.update({
      where: { id: photoId },
      data: {
        duplicateOfPhotoId,
        dedupMethod,
        aiClassificationStatus: "duplicate",
        // Duplicates get no folder - folderId stays null until/unless reclassified.
        // Rows marked duplicate never carry a phash — explicitly nulled (not
        // just omitted) so a BullMQ retry that flips a previously-non-dup
        // attempt's verdict can't leave a stale phash behind. Even a future
        // query that forgets the invariant's exclusions can then never match
        // a duplicate row in the pHash pass (third layer of the
        // belt-and-suspenders fix; rationale + trade-off in the MR draft).
        phash: null,
      },
    });
    // Hard gate: return here, never reaching the classify() call below.
    return;
  }

  await prisma.photo.update({ where: { id: photoId }, data: { phash } });

  // --- Step 4: mocked classification (only reached for non-duplicates). ---
  const result = applyLowConfidenceHook(photo, await classify(originalBuffer));

  // --- Step 5: category mapping + folder auto-creation + assignment. ---
  await assignPhotoToFolder(photo, result, { clearDuplicateVerdict: false });
}

/**
 * "reclassify" job (specs/ai-classification.md §4): classify -> hook ->
 * mapping -> folder assignment ONLY. Skips thumbnails, EXIF, and the dedup
 * gate entirely (they ran at first ingest and are unchanged). If the photo
 * was a duplicate, the verdict (duplicateOfPhotoId + dedupMethod) is cleared
 * — the user is explicitly overriding the dedup gate (Open Question 4).
 */
async function processReclassify(photoId: string): Promise<void> {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) {
    throw new Error(`Photo ${photoId} not found - cannot reclassify`);
  }

  await prisma.photo.update({
    where: { id: photoId },
    data: { aiClassificationStatus: "processing" },
  });

  // Note: no FORCE_FAIL_ check here, deliberately (see hook scoping above).

  const originalBuffer = await fetchOriginalBuffer(photo.s3Key);

  const result = applyLowConfidenceHook(photo, await classify(originalBuffer));

  await assignPhotoToFolder(photo, result, {
    clearDuplicateVerdict: photo.duplicateOfPhotoId !== null || photo.dedupMethod !== null,
  });
}

async function main() {
  await ensureBucketExists();

  const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker<PhotoProcessingJobData>(
    PHOTO_PROCESSING_QUEUE_NAME,
    async (job: Job<PhotoProcessingJobData>) => {
      // Bookkeeping keyed by BullMQ job id === ProcessingJob PK (see
      // updateProcessingJobById above).
      if (!job.id) {
        throw new Error("Job has no id - cannot update processing_jobs bookkeeping");
      }
      await updateProcessingJobById(job.id, {
        status: "active",
        attempts: job.attemptsMade + 1,
      });

      if (job.name === "reclassify") {
        await processReclassify(job.data.photoId);
      } else {
        await processPhotoPipeline(job.data.photoId);
      }
    },
    { connection, concurrency: 2 },
  );

  worker.on("completed", async (job) => {
    if (!job.id) return;
    await updateProcessingJobById(job.id, { status: "completed" });
    // eslint-disable-next-line no-console
    console.log(`[worker] completed ${job.name} job for photo ${job.data.photoId}`);
  });

  worker.on("failed", async (job, err) => {
    if (!job || !job.id) return;
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);
    await updateProcessingJobById(job.id, {
      status: isFinalAttempt ? "failed" : "queued",
      attempts: job.attemptsMade,
      errorMessage: err.message,
    });
    if (isFinalAttempt) {
      await prisma.photo.updateMany({
        where: { id: job.data.photoId },
        data: { aiClassificationStatus: "failed" },
      });
    }
    // eslint-disable-next-line no-console
    console.error(
      `[worker] ${job.name} job failed for photo ${job.data.photoId} (attempt ${job.attemptsMade}):`,
      err.message,
    );
  });

  // eslint-disable-next-line no-console
  console.log("[worker] listening for jobs on queue:", PHOTO_PROCESSING_QUEUE_NAME);

  process.on("SIGTERM", async () => {
    await worker.close();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await worker.close();
    process.exit(0);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] fatal startup error:", err);
  process.exit(1);
});
