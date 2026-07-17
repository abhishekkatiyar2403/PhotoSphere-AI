import dotenv from "dotenv";
import path from "node:path";

// Load the repo-root .env, matching server.ts's convention - this is a
// separate process/entrypoint from the API, so it needs its own env load.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { validateEnv } from "./lib/validateEnv";

// Fail fast on a misconfigured production deploy — same rationale as
// server.ts (this is a separate process/entrypoint, so it needs its own call).
validateEnv();

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import crypto from "node:crypto";
import { promisify } from "node:util";
import exifr from "exifr";
import heicConvert from "heic-convert";
import IORedis from "ioredis";
import { Job, Worker } from "bullmq";
import sharp from "sharp";
import { Prisma, type Collection, type Folder, type Photo } from "@prisma/client";
import { classify, parseCachedDetection, type ClassificationResult } from "./lib/classification";
import { rankCategories, UNCATEGORIZED } from "./lib/classification/categoryMapping";
import { refinePeople, GROUP_FOLDER, PEOPLE_FALLBACK_FOLDER } from "./lib/classification/faces";
import {
  looksLikeScreenshot,
  SCREENSHOT_DETECTION,
  SCREENSHOT_FILENAME_PATTERN,
} from "./lib/classification/screenshot";
import { findExactDuplicateOriginal, findNearDuplicateOriginal } from "./lib/dedup";
import { computePHash } from "./lib/phash";
import { prisma } from "./lib/prisma";
import { serializableTransaction } from "./lib/serializableTransaction";
import {
  PhotoProcessingJobData,
  PHOTO_PROCESSING_QUEUE_NAME,
  registerTrashPurgeJob,
  registerUploadSessionCleanupJob,
  TRASH_PURGE_JOB_NAME,
  UPLOAD_SESSION_CLEANUP_JOB_NAME,
} from "./lib/queue";
import { runTrashPurgeJob } from "./lib/trashPurgeJob";
import { runUploadSessionCleanupJob } from "./lib/uploadSessionCleanupJob";
import { startWorkerHeartbeat } from "./lib/workerHeartbeat";
import { logger } from "./lib/logger";
import { ensureBucketExists, getPresignedGetUrl, putObject } from "./lib/storage";
import { thumbnailKey } from "./routes/photos";

const THUMBNAIL_SIZES = [150, 400, 1200] as const;

// Formats Amazon Rekognition's DetectLabels accepts directly — everything
// else (HEIC first and foremost) needs converting via decodeToJpeg() first.
const REKOGNITION_COMPATIBLE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

const execFileAsync = promisify(execFile);

/**
 * Cross-platform HEIC fallback decoder (2026-07-13 backend audit #1) — iPhone
 * ships with Live Photo mode ON BY DEFAULT, and a Live Photo HEIC embeds
 * enough auxiliary item references (extra thumbnails, a still-frame
 * sequence) that it routinely exceeds libheif's hardcoded anti-DoS security
 * limit of 16 "iref" references (real files seen during testing: 45-48).
 * That limit is compiled into libheif itself — sharp exposes no way to
 * raise it, so a meaningful fraction of ordinary iPhone photos are
 * genuinely undecodable by sharp, not just a rare edge case.
 *
 * `heic-convert` (backed by `libheif-js`, a WASM build of libheif with the
 * same anti-DoS limit REMOVED/raised) has no native dependency at all — it
 * runs identically on macOS and Linux, unlike the `sips` fallback this
 * replaced (macOS-only, previously a real production gap: on Railway, every
 * HEIC upload — not just Live Photos — got no thumbnail, no classification,
 * and landed in Uncategorized). Verified directly against a real Live Photo
 * that reproduces the exact "iref box (48) exceeds... 16" error sharp
 * throws: `heic-convert` decodes it cleanly into a valid 3024×4032 JPEG.
 *
 * A touch slower than sharp/libvips (WASM, no native SIMD) — that's exactly
 * why it's the FALLBACK, tried only after sharp's fast path fails, not a
 * replacement for it.
 */
async function decodeHeicViaWasm(buffer: Buffer): Promise<Buffer | null> {
  try {
    const jpegArrayBuffer = await heicConvert({ buffer, format: "JPEG", quality: 0.9 });
    return Buffer.from(jpegArrayBuffer);
  } catch (err) {
    logger.error({ err }, "heic-convert (WASM) fallback also failed to decode HEIC");
    return null;
  }
}

/**
 * macOS-only LAST-RESORT decode fallback, kept as belt-and-suspenders after
 * decodeHeicViaWasm above (which now handles the vast majority of cases,
 * including on Linux) — `sips` uses Apple's own native HEIC decoder,
 * completely independent of libheif, so it can still recover a file that
 * somehow defeats both sharp AND the WASM decoder. Inert (returns null
 * immediately, harmless) on any non-macOS platform.
 */
async function decodeHeicViaSips(buffer: Buffer): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;

  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const srcPath = path.join(tmpDir, `heic-decode-${id}.heic`);
  const destPath = path.join(tmpDir, `heic-decode-${id}.jpg`);

  try {
    await fs.writeFile(srcPath, buffer);
    await execFileAsync("sips", ["-s", "format", "jpeg", srcPath, "--out", destPath]);
    return await fs.readFile(destPath);
  } catch (err) {
    logger.error({ err }, "sips fallback also failed to decode HEIC");
    return null;
  } finally {
    await fs.unlink(srcPath).catch(() => {});
    await fs.unlink(destPath).catch(() => {});
  }
}

/**
 * Best-effort decode of `buffer` into a normalized JPEG, for every step that
 * needs actual re-encoded pixel data from a non-JPEG/PNG original (i.e.
 * HEIC) — classification (Rekognition only accepts JPEG/PNG), thumbnailing,
 * and pHash all share this ONE decode attempt rather than each separately
 * trying and failing against the same undecodable bytes.
 *
 * Three-tier fallback, fastest/most-common case first:
 *   1. sharp/libvips — fast, native, works for the majority of HEIC files.
 *   2. heic-convert (WASM libheif, no native dep — see decodeHeicViaWasm) —
 *      the real fix for the Live-Photo iref-limit case, and the ONLY tier
 *      that also works in production (Linux).
 *   3. sips (macOS-only) — belt-and-suspenders last resort.
 * Returns null (never throws) if nothing can decode it, so every caller
 * degrades gracefully instead of failing the whole pipeline.
 */
async function decodeToJpeg(buffer: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer();
  } catch (err) {
    logger.error({ err }, "sharp could not decode image, trying heic-convert (WASM) fallback");
    const wasmResult = await decodeHeicViaWasm(buffer);
    if (wasmResult) return wasmResult;
    return decodeHeicViaSips(buffer);
  }
}

/**
 * macOS-only EXIF fallback for HEIC — confirmed directly against a real
 * photo that exifr (7.1.3, the latest release) has no HEIC/ISOBMFF
 * container parser at all and throws "Unknown file format" on every HEIC
 * file, not just the undecodable-by-libheif ones. `sips -g all` reads
 * Apple's own metadata parser and reliably exposes creation date + camera
 * make/model for real iPhone photos. Its plain-text output doesn't expose
 * GPS coordinates, so that's a genuine, disclosed gap here — this fallback
 * only ever recovers date/camera, never location, for a HEIC file.
 */
async function extractExifViaSips(
  buffer: Buffer,
): Promise<{ takenAt: Date | null; cameraMake: string | null; cameraModel: string | null } | null> {
  if (process.platform !== "darwin") return null;

  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const srcPath = path.join(tmpDir, `heic-exif-${id}.heic`);

  try {
    await fs.writeFile(srcPath, buffer);
    const { stdout } = await execFileAsync("sips", ["-g", "all", srcPath]);

    // sips prints "key: value" lines (see decodeHeicViaSips's sibling — this
    // is the SAME tool, a different flag). Date comes as EXIF-style
    // "YYYY:MM:DD HH:MM:SS" (colons in the date portion), not ISO — convert
    // just the date separators so `new Date(...)` parses it correctly.
    const creationMatch = stdout.match(/^\s*creation:\s*(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2})/m);
    const makeMatch = stdout.match(/^\s*make:\s*(.+)$/m);
    const modelMatch = stdout.match(/^\s*model:\s*(.+)$/m);

    const takenAt = creationMatch
      ? new Date(`${creationMatch[1]}-${creationMatch[2]}-${creationMatch[3]}T${creationMatch[4]}`)
      : null;

    return {
      takenAt: takenAt && !Number.isNaN(takenAt.getTime()) ? takenAt : null,
      cameraMake: makeMatch ? makeMatch[1].trim() : null,
      cameraModel: modelMatch ? modelMatch[1].trim() : null,
    };
  } catch (err) {
    logger.error({ err }, "sips EXIF fallback failed");
    return null;
  } finally {
    await fs.unlink(srcPath).catch(() => {});
  }
}

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
 * catch-unique-violation-and-refetch pattern the old plain
 * @@unique([collectionId, name]) enabled — but specs/trash-system.md's T7
 * (FINAL DECISION 3) replaced that with a PARTIAL unique index
 * (`WHERE deleted_at IS NULL`), so `collectionId_name` no longer exists as a
 * compound-unique Prisma input. Look up only the LIVE folder with this name
 * (findFirst + deletedAt: null) — a TRASHED folder with the same name must
 * NOT be "found" and silently reused by the worker (that would resurrect a
 * trashed folder's identity without going through restore); the create
 * attempt below will succeed even if a trashed same-named row exists, since
 * the partial unique index only blocks two LIVE rows from colliding.
 */
async function findOrCreateFolder(collectionId: string, name: string): Promise<Folder> {
  const where = { collectionId, name, deletedAt: null } as const;
  const existing = await prisma.folder.findFirst({ where });
  if (existing) return existing;

  try {
    return await prisma.folder.create({
      data: { collectionId, name, categoryType: "ai_generated" },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await prisma.folder.findFirst({ where });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Resolves a face-recognition person (a Rekognition FaceId) to their folder
 * via the person_faces registry — folder link is by ID, so a renamed person
 * folder ("Person 1" -> "Mom") keeps receiving that person's photos. A face
 * with no live mapping (brand-new person, or their folder was trashed/
 * purged) gets the next "Person N" folder created and the mapping (re)pointed
 * at it. Never re-indexes a face — identity stays 1 face = 1 registry row
 * ((ownerId, faceId) unique).
 */
async function resolvePersonFolder(
  ownerId: string,
  collectionId: string,
  faceId: string,
): Promise<Folder> {
  const existing = await prisma.personFace.findUnique({
    where: { ownerId_faceId: { ownerId, faceId } },
    include: { folder: true },
  });
  if (existing && existing.folder.deletedAt === null) {
    return existing.folder;
  }

  // New person (or their folder is trashed — don't resurrect it, spawn a
  // fresh one). Number from the registry size, not folder-name parsing:
  // renamed folders make name-parsing lie.
  const personNumber = (await prisma.personFace.count({ where: { ownerId } })) + 1;
  const folder = await findOrCreateFolder(collectionId, `Person ${personNumber}`);

  if (existing) {
    await prisma.personFace.update({ where: { id: existing.id }, data: { folderId: folder.id } });
  } else {
    try {
      await prisma.personFace.create({ data: { ownerId, faceId, folderId: folder.id } });
    } catch (err) {
      // Concurrent sibling job enrolled the same face first — theirs wins.
      if (isUniqueViolation(err)) {
        const winner = await prisma.personFace.findUnique({
          where: { ownerId_faceId: { ownerId, faceId } },
          include: { folder: true },
        });
        if (winner && winner.folder.deletedAt === null) return winner.folder;
      } else {
        throw err;
      }
    }
  }
  return folder;
}

/**
 * Pipeline step 5 / reclassify final step (specs/ai-classification.md §4):
 * classification result -> category -> find-or-create default collection +
 * folder -> single transaction updating the photo and reconciling both
 * folders' photoCount (never below 0).
 *
 * `getPixelBuffer` is LAZY — reclassify-from-cache never touches storage at
 * all unless the photo actually ranks as People and needs face analysis.
 * `detection` (when provided) is the raw provider result to persist as the
 * photo's cached detection (see schema.prisma aiDetection).
 */
async function assignPhotoToFolder(
  photo: Photo,
  result: ClassificationResult,
  options: {
    clearDuplicateVerdict: boolean;
    getPixelBuffer?: () => Promise<Buffer | null>;
    detection?: ClassificationResult;
  },
): Promise<void> {
  const collection = await findOrCreateDefaultCollection(photo.ownerId);

  const ranked = rankCategories(result);
  let rankIndex = 0;
  let category = ranked[0]?.category ?? UNCATEGORIZED;
  let personFolder: Folder | null = null;

  // Face-based People refinement (lib/classification/faces.ts): a People
  // verdict fans out into per-person / "Group" / plain "People" folders by
  // actually looking at the faces' SIZE in frame, not just the labels.
  // A "reject" verdict (faces exist but none prominent — incidental
  // passer-by, Bugs.md #16) means this isn't really a People photo: fall
  // through to the next-highest-scoring category the labels matched.
  // Everything else is strictly best-effort — the no-op provider (mock mode
  // / tests) and every face-API failure path yield "fallback", i.e. the
  // plain "People" folder, the pre-feature behavior.
  while (category === PEOPLE_FALLBACK_FOLDER && options.getPixelBuffer) {
    const pixelBuffer = await options.getPixelBuffer();
    if (!pixelBuffer) break;

    const verdict = await refinePeople(photo.ownerId, pixelBuffer);
    if (verdict.kind === "reject") {
      // Only fall through when the label evidence AGREES the photo isn't
      // really about the person. A full-body/turned-away shot can fail the
      // face-geometry test while the labels are still overwhelmingly about
      // the subject (Pants/Jeans/Shoe/Walking... — live case 2026-07-11,
      // where falling through landed the photo in Electronics via the
      // subject's own headphones). If People's score at least doubles the
      // next category's, trust the labels and keep the plain People folder.
      const peopleScore = ranked[rankIndex]?.score ?? 0;
      const nextScore = ranked[rankIndex + 1]?.score ?? 0;
      if (peopleScore >= nextScore * 2) {
        break; // stays "People"
      }
      rankIndex += 1;
      category = ranked[rankIndex]?.category ?? UNCATEGORIZED;
      continue;
    }
    if (verdict.kind === "group") {
      category = GROUP_FOLDER;
    } else if (verdict.kind === "person") {
      personFolder = await resolvePersonFolder(photo.ownerId, collection.id, verdict.faceId);
    }
    break; // group / person / fallback are all terminal
  }

  const folder = personFolder ?? (await findOrCreateFolder(collection.id, category));

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
        // Persist the raw detection so future reclassifies re-run only the
        // local mapping — no repeat provider billing (aiDetection cache).
        ...(options.detection
          ? { aiDetection: options.detection as unknown as Prisma.InputJsonValue }
          : {}),
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

/**
 * Header-only dimension probe for the screenshot detector — sharp reads
 * just the image header, no pixel decode. Nulls (never a throw) when the
 * format is unreadable; the detector treats unknown dimensions as
 * "not a screenshot by the resolution rule" (filename rule still applies).
 */
async function imageDimensions(buffer: Buffer): Promise<{ width: number | null; height: number | null }> {
  try {
    const meta = await sharp(buffer).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
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

  // Decode ONCE, shared by thumbnailing, pHash, and classification below —
  // rather than each independently attempting (and separately failing) the
  // same raw HEIC decode. An already-JPEG/PNG original is used as-is
  // (matches every existing behavior/test exactly, no re-encode/quality
  // loss). A HEIC (or any other non-JPEG/PNG) original goes through
  // decodeToJpeg() — sharp first, then sips as a macOS-only fallback for
  // the Live-Photo case sharp/libheif can't handle at all (see
  // decodeHeicViaSips's comment for why this is common on real iPhone
  // photos, not a rare edge case). `null` means genuinely undecodable by
  // anything available — every step below degrades gracefully rather than
  // failing the whole pipeline, since a retry against the same bytes could
  // never succeed differently.
  const pixelBuffer = REKOGNITION_COMPATIBLE_MIME_TYPES.has(photo.mimeType)
    ? originalBuffer
    : await decodeToJpeg(originalBuffer);

  // --- Step 1: thumbnails (Sharp), in strict order before anything else. ---
  let thumbnailsGenerated = false;
  if (pixelBuffer) {
    try {
      for (const size of THUMBNAIL_SIZES) {
        const thumbBuffer = await sharp(pixelBuffer)
          .rotate() // normalize EXIF orientation before resizing
          .resize(size, size, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();

        await putObject(thumbnailKey(photo.ownerId, photo.id, size), thumbBuffer, "image/jpeg");
      }
      thumbnailsGenerated = true;
    } catch (err) {
      logger.error({ err, photoId }, "thumbnail generation failed (continuing without one)");
    }
  }

  if (thumbnailsGenerated) {
    await prisma.photo.update({
      where: { id: photoId },
      data: { s3ThumbnailKey: thumbnailKey(photo.ownerId, photo.id, 400) },
    });
  }

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
    // exifr (as installed, 7.1.3) genuinely has no HEIC/ISOBMFF container
    // parser at all — confirmed directly against a real photo: it throws
    // "Unknown file format" on every HEIC file, not just problematic ones.
    // Fall through to the sips fallback below rather than just swallowing
    // this as "no EXIF data" for every iPhone photo.
  }

  // macOS-only fallback (see decodeHeicViaSips's comment for the same
  // cross-platform caveat) — only attempted when exifr found nothing, so an
  // already-successful exifr parse (JPEG/PNG, or a HEIC library that later
  // gains real support) is never overridden. GPS isn't exposed by `sips -g
  // all`'s plain-text output, so that stays null here — a real, disclosed
  // gap, not silently pretended away.
  if (exifTakenAt === null && process.platform === "darwin") {
    const sipsExif = await extractExifViaSips(originalBuffer);
    if (sipsExif) {
      exifTakenAt = sipsExif.takenAt;
      exifCameraMake = sipsExif.cameraMake;
      exifCameraModel = sipsExif.cameraModel;
    }
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
  // Uses the same shared pixelBuffer as thumbnailing — null means
  // undecodable (see above), so near-dup detection is skipped for this
  // photo rather than failing the pipeline; the exact-bytes (sha256) pass
  // above is unaffected either way.
  let phash: string | null = null;
  if (!duplicateOfPhotoId && pixelBuffer) {
    try {
      phash = await computePHash(pixelBuffer);
      duplicateOfPhotoId = await findNearDuplicateOriginal(photo, phash);
      if (duplicateOfPhotoId) dedupMethod = "phash";
    } catch (err) {
      logger.error({ err, photoId }, "pHash computation failed (skipping near-dup check)");
      phash = null;
    }
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

  // --- Step 4: classification (only reached for non-duplicates). ---
  // SCREENSHOT SHORT-CIRCUIT first (lib/classification/screenshot.ts):
  // screenshots are identified from metadata (filename pattern, or PNG +
  // no camera EXIF + exact device-screen dimensions) because Rekognition
  // has no "Screenshot" label — it would describe a screenshot by its
  // CONTENT and misfile it. Detecting here also skips the DetectLabels
  // call entirely (real spend saved on 10-30% of a typical phone library).
  // The synthetic result flows through the same mapping/caching machinery
  // as a real detection, so the verdict is durable across reclassifies.
  //
  // Otherwise: reuses the same shared pixelBuffer decoded above —
  // Rekognition only accepts JPEG/PNG, so a HEIC original could never
  // classify against its raw bytes even when sharp/sips CAN decode it, and
  // a genuinely undecodable one (null) lands in Uncategorized (empty
  // labels, 0 confidence) same as any other low-confidence/unmappable
  // result, rather than a dead-end "failed" status a retry could never fix.
  const isScreenshot = looksLikeScreenshot({
    mimeType: photo.mimeType,
    originalFilename: photo.originalFilename,
    hasCameraExif: exifCameraMake !== null || exifCameraModel !== null || exifTakenAt !== null,
    ...(await imageDimensions(originalBuffer)),
  });
  const rawResult: ClassificationResult = isScreenshot
    ? { ...SCREENSHOT_DETECTION, labels: [...SCREENSHOT_DETECTION.labels] }
    : pixelBuffer
      ? await classify(pixelBuffer)
      : { labels: [], confidence: 0 };
  const result = applyLowConfidenceHook(photo, rawResult);

  // --- Step 5: category mapping + folder auto-creation + assignment. ---
  // `detection: rawResult` persists the raw (pre-hook) provider result as
  // the photo's cached detection — future reclassifies map from the cache.
  await assignPhotoToFolder(photo, result, {
    clearDuplicateVerdict: false,
    getPixelBuffer: async () => pixelBuffer,
    detection: rawResult,
  });
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

  // Lazy, memoized decode — only ever touches storage if actually needed
  // (live provider call below, or face refinement for a People verdict).
  // Same HEIC reasoning as processPhotoPipeline's Step 4: Rekognition only
  // accepts JPEG/PNG, so non-JPEG/PNG originals convert first, and a
  // genuinely undecodable one falls back to Uncategorized rather than
  // failing the reclassify attempt outright.
  let decoded: Promise<Buffer | null> | null = null;
  const getPixelBuffer = (): Promise<Buffer | null> => {
    decoded ??= fetchOriginalBuffer(photo.s3Key).then((originalBuffer) =>
      REKOGNITION_COMPATIBLE_MIME_TYPES.has(photo.mimeType)
        ? originalBuffer
        : decodeToJpeg(originalBuffer),
    );
    return decoded;
  };

  // SCREENSHOT CHECK FIRST — deliberately BEFORE the detection cache: a
  // screenshot classified before this detector existed carries a
  // content-based cache ("Text"->Documents, "Beach"->Nature...), and
  // replaying that cache would keep the misfile forever. Checking metadata
  // first means a user-triggered reclassify genuinely FIXES old misfiled
  // screenshots, and re-persists the durable Screenshot detection into the
  // cache. Cheap: the filename/mime/EXIF pre-filter below touches only DB
  // fields already in hand; the buffer is fetched solely for the
  // dimensions of PNG candidates (a PNG's getPixelBuffer IS the original
  // bytes — png is Rekognition-compatible, so no conversion happens).
  const screenshotCandidate =
    SCREENSHOT_FILENAME_PATTERN.test(photo.originalFilename) ||
    (photo.mimeType === "image/png" &&
      photo.exifCameraMake === null &&
      photo.exifCameraModel === null &&
      photo.exifTakenAt === null);

  let rawResult: ClassificationResult | null = null;
  let detection: ClassificationResult | undefined;

  if (screenshotCandidate) {
    const dims =
      photo.mimeType === "image/png"
        ? await getPixelBuffer().then((b) => (b ? imageDimensions(b) : { width: null, height: null }))
        : { width: null, height: null };
    const isScreenshot = looksLikeScreenshot({
      mimeType: photo.mimeType,
      originalFilename: photo.originalFilename,
      hasCameraExif:
        photo.exifCameraMake !== null || photo.exifCameraModel !== null || photo.exifTakenAt !== null,
      ...dims,
    });
    if (isScreenshot) {
      rawResult = { ...SCREENSHOT_DETECTION, labels: [...SCREENSHOT_DETECTION.labels] };
      detection = rawResult;
    }
  }

  // Detection-cache fast path: if this photo already carries a stored raw
  // detection (aiDetection), reclassify re-runs ONLY the local mapping over
  // it — zero provider calls, zero storage reads (unless faces are needed).
  // Every mapping-rule fix so far re-billed the whole library through the
  // provider for detections that were identical every time; now a mapping
  // change costs nothing to roll out. Cache miss (pre-cache photos, or a
  // first-ever classify) takes the live path and populates the cache.
  if (!rawResult) {
    const cached = parseCachedDetection(photo.aiDetection);
    if (cached) {
      rawResult = cached;
    } else {
      const pixelBuffer = await getPixelBuffer();
      rawResult = pixelBuffer ? await classify(pixelBuffer) : { labels: [], confidence: 0 };
      detection = rawResult;
    }
  }
  const result = applyLowConfidenceHook(photo, rawResult);

  await assignPhotoToFolder(photo, result, {
    clearDuplicateVerdict: photo.duplicateOfPhotoId !== null || photo.dedupMethod !== null,
    getPixelBuffer,
    detection,
  });
}

async function main() {
  await ensureBucketExists();

  // specs/trash-system.md T4: idempotent registration — safe on every boot,
  // upserts rather than duplicating the scheduled job.
  await registerTrashPurgeJob();
  // specs/production-upload-batch.md PUB4 (DECIDED): same idempotent
  // registration pattern, one call added alongside the existing one above —
  // no other change to this file's worker-pipeline logic.
  await registerUploadSessionCleanupJob();

  const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

  // 2026-07-13 backend audit #14: a hung/crashed worker was previously
  // invisible — this is the ONLY liveness signal it emits (see
  // lib/workerHeartbeat.ts; /health, in app.ts, reads it back).
  const stopHeartbeat = startWorkerHeartbeat(connection);

  const worker = new Worker<PhotoProcessingJobData>(
    PHOTO_PROCESSING_QUEUE_NAME,
    async (job: Job<PhotoProcessingJobData>) => {
      // specs/trash-system.md T4: the repeatable purge job has NO
      // processing_jobs bookkeeping (it isn't tied to a single Photo row —
      // it's a batch sweep) and no photoId. Handled first, before the
      // by-job-id bookkeeping below which assumes a photoId-carrying job.
      if (job.name === TRASH_PURGE_JOB_NAME) {
        const result = await runTrashPurgeJob();
        logger.info(
          {
            photosPurged: result.photosPurged,
            foldersPurged: result.foldersPurged,
            ...result.housekeeping,
            ...result.staleReconciliation,
          },
          "trash-purge job completed",
        );
        return;
      }

      // specs/production-upload-batch.md PUB4: same "no processing_jobs
      // bookkeeping, no photoId" shape as the trash-purge job above — this
      // is a batch sweep, not tied to a single Photo row.
      if (job.name === UPLOAD_SESSION_CLEANUP_JOB_NAME) {
        const result = await runUploadSessionCleanupJob();
        logger.info(result, "upload-session-cleanup job completed");
        return;
      }

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
        await processReclassify((job.data as { photoId: string }).photoId);
      } else {
        await processPhotoPipeline((job.data as { photoId: string }).photoId);
      }
    },
    { connection, concurrency: 2 },
  );

  worker.on("completed", async (job) => {
    // specs/trash-system.md T4 / specs/production-upload-batch.md PUB4: both
    // repeatable sweep jobs have no processing_jobs row and no photoId —
    // their own success/failure logging happens inside the processor above,
    // not here.
    if (job.name === TRASH_PURGE_JOB_NAME || job.name === UPLOAD_SESSION_CLEANUP_JOB_NAME) return;
    if (!job.id) return;
    await updateProcessingJobById(job.id, { status: "completed" });
    logger.info(
      { jobName: job.name, photoId: (job.data as { photoId?: string }).photoId },
      "job completed",
    );
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    if (job.name === TRASH_PURGE_JOB_NAME) {
      logger.error({ err, attempts: job.attemptsMade }, "trash-purge job failed");
      return;
    }
    if (job.name === UPLOAD_SESSION_CLEANUP_JOB_NAME) {
      logger.error({ err, attempts: job.attemptsMade }, "upload-session-cleanup job failed");
      return;
    }
    if (!job.id) return;
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);
    await updateProcessingJobById(job.id, {
      status: isFinalAttempt ? "failed" : "queued",
      attempts: job.attemptsMade,
      errorMessage: err.message,
    });
    const photoId = (job.data as { photoId?: string }).photoId;
    if (isFinalAttempt && photoId) {
      await prisma.photo.updateMany({
        where: { id: photoId },
        data: { aiClassificationStatus: "failed" },
      });
    }
    logger.error({ err, jobName: job.name, photoId, attempts: job.attemptsMade }, "job failed");
  });

  logger.info({ queue: PHOTO_PROCESSING_QUEUE_NAME }, "worker listening for jobs");

  process.on("SIGTERM", async () => {
    stopHeartbeat();
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    stopHeartbeat();
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
