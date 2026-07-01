import dotenv from "dotenv";
import path from "node:path";

// Load the repo-root .env, matching server.ts's convention - this is a
// separate process/entrypoint from the API, so it needs its own env load.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import exifr from "exifr";
import IORedis from "ioredis";
import { Job, Worker } from "bullmq";
import sharp from "sharp";
import { classify } from "./lib/classification";
import { computePHash, DUPLICATE_HAMMING_THRESHOLD, hammingDistance } from "./lib/phash";
import { prisma } from "./lib/prisma";
import { PhotoProcessingJobData, PHOTO_PROCESSING_QUEUE_NAME } from "./lib/queue";
import { ensureBucketExists, getPresignedGetUrl, putObject } from "./lib/storage";
import { thumbnailKey } from "./routes/photos";

const THUMBNAIL_SIZES = [150, 400, 1200] as const;

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

async function processPhotoPipeline(photoId: string): Promise<void> {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) {
    throw new Error(`Photo ${photoId} not found - cannot process`);
  }

  await prisma.photo.update({
    where: { id: photoId },
    data: { aiClassificationStatus: "processing" },
  });

  // Test-only forced-failure hook (acceptance criteria: "Developer should
  // provide a way to force this for testing"). Any upload whose original
  // filename starts with this exact prefix always throws here, every
  // attempt, so Tester can deterministically exercise the retry/backoff/
  // `failed` path without needing an actually-corrupt file. No production
  // code path can trigger this by accident - it's an explicit opt-in string.
  if (photo.originalFilename.startsWith("FORCE_FAIL_")) {
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

  // --- Step 3: pHash dedup gate (hard gate - never call classify() past this for a duplicate). ---
  const phash = await computePHash(originalBuffer);

  const candidates = await prisma.photo.findMany({
    where: {
      ownerId: photo.ownerId, // per-user scope only (spec Open Question 7)
      id: { not: photo.id },
      phash: { not: null },
    },
    select: { id: true, phash: true },
  });

  let duplicateOfPhotoId: string | null = null;
  for (const candidate of candidates) {
    if (!candidate.phash) continue;
    if (hammingDistance(phash, candidate.phash) < DUPLICATE_HAMMING_THRESHOLD) {
      duplicateOfPhotoId = candidate.id;
      break;
    }
  }

  if (duplicateOfPhotoId) {
    await prisma.photo.update({
      where: { id: photoId },
      data: {
        phash,
        duplicateOfPhotoId,
        aiClassificationStatus: "duplicate",
      },
    });
    // Hard gate: return here, never reaching the classify() call below.
    return;
  }

  await prisma.photo.update({ where: { id: photoId }, data: { phash } });

  // --- Step 4: mocked classification (only reached for non-duplicates). ---
  const result = await classify(originalBuffer);

  await prisma.photo.update({
    where: { id: photoId },
    data: {
      aiLabels: result.labels,
      aiConfidence: result.confidence,
      aiClassificationStatus: "done",
    },
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
      await prisma.processingJob.updateMany({
        where: { photoId: job.data.photoId },
        data: { status: "active", attempts: job.attemptsMade + 1 },
      });
      await processPhotoPipeline(job.data.photoId);
    },
    { connection, concurrency: 2 },
  );

  worker.on("completed", async (job) => {
    await prisma.processingJob.updateMany({
      where: { photoId: job.data.photoId },
      data: { status: "completed" },
    });
    // eslint-disable-next-line no-console
    console.log(`[worker] completed job for photo ${job.data.photoId}`);
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);
    await prisma.processingJob.updateMany({
      where: { photoId: job.data.photoId },
      data: {
        status: isFinalAttempt ? "failed" : "queued",
        attempts: job.attemptsMade,
        errorMessage: err.message,
      },
    });
    if (isFinalAttempt) {
      await prisma.photo.updateMany({
        where: { id: job.data.photoId },
        data: { aiClassificationStatus: "failed" },
      });
    }
    // eslint-disable-next-line no-console
    console.error(`[worker] job failed for photo ${job.data.photoId} (attempt ${job.attemptsMade}):`, err.message);
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
