import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ListMultipartUploadsCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { ensureBucketExists } from "../lib/storage";
import { runUploadSessionCleanupJob } from "../lib/uploadSessionCleanupJob";
import { createMultipartUpload } from "../lib/storage";
import { getBatchLimit } from "../lib/plans";

// Covers specs/production-upload-batch.md's Acceptance Criteria checklist at
// the API layer, against real local MinIO (docker compose up -d) — presigned
// part URLs are PUT to directly, exactly as the browser would, proving the
// backend never touches file bytes for the happy path. Skips gracefully if
// Postgres/MinIO aren't reachable (same convention as upload.smoke.test.ts).

const app = createApp();
const fixturePath = path.join(__dirname, "fixtures", "sample.jpg");
const fixtureBuffer = fs.readFileSync(fixturePath);

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// A fresh JPEG-shaped buffer with a unique sha256 each call — trailing bytes
// after a real JPEG's own content are irrelevant to sniffMimeType (header-
// only) and to a real decode, so this stays a valid, sniffable JPEG while
// never colliding with another test's/earlier test's fileSha256 (avoiding
// cross-test duplicate-detection false positives against LIVE rows this
// same suite creates).
function uniqueJpegBuffer(): Buffer {
  return Buffer.concat([fixtureBuffer, crypto.randomBytes(16)]);
}

// A separate, direct S3Client mirroring lib/storage.ts's MinIO branch — used
// ONLY by this test file to independently verify MinIO's own
// ListMultipartUploads state (proving abort/cleanup genuinely reach storage,
// not just a DB flag), never by application code.
const testS3 = new S3Client({
  endpoint: `http://${process.env.MINIO_ENDPOINT ?? "localhost"}:${process.env.MINIO_PORT ?? "9000"}`,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? "photosphere",
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? "photosphere123",
  },
  forcePathStyle: true,
});
const TEST_BUCKET = process.env.MINIO_BUCKET ?? "photosphere-dev";

async function hasOutstandingMultipartUpload(key: string, uploadId: string): Promise<boolean> {
  const result = await testS3.send(new ListMultipartUploadsCommand({ Bucket: TEST_BUCKET, Prefix: key }));
  return (result.Uploads ?? []).some((u) => u.Key === key && u.UploadId === uploadId);
}

/** Uploads every part of every non-duplicate file returned by /initiate
 * directly to MinIO via the presigned part URLs — no Authorization/session
 * cookie, exactly as the browser would. Returns the parts payload shape
 * /complete expects. */
async function uploadAllParts(
  files: { clientId: string; key: string; uploadId: string; partUrls: { partNumber: number; url: string }[] }[],
  buffersByClientId: Record<string, Buffer>,
): Promise<{ clientId: string; parts: { partNumber: number; eTag: string }[] }[]> {
  const out: { clientId: string; parts: { partNumber: number; eTag: string }[] }[] = [];
  for (const file of files) {
    const buf = buffersByClientId[file.clientId];
    const parts: { partNumber: number; eTag: string }[] = [];
    // Single-part is sufficient for these small fixtures (< 8MB PART_SIZE_BYTES).
    for (const { partNumber, url } of file.partUrls) {
      const res = await fetch(url, { method: "PUT", body: buf });
      expect(res.ok).toBe(true);
      const eTag = res.headers.get("etag");
      expect(eTag).toBeTruthy();
      parts.push({ partNumber, eTag: eTag! });
    }
    out.push({ clientId: file.clientId, parts });
  }
  return out;
}

const testEmail = `upload-batch-smoke-${Date.now()}@example.com`;
const testPassword = "correct-password-123";
let sessionCookie: string;
let userId: string;

let infraAvailable = true;

beforeAll(async () => {
  try {
    await prisma.$connect();
    await ensureBucketExists();
  } catch {
    infraAvailable = false;
    return;
  }

  const signupRes = await request(app)
    .post("/api/auth/signup")
    .send({ email: testEmail, password: testPassword, name: "Upload Batch Smoke" });
  sessionCookie = signupRes.headers["set-cookie"][0];
  userId = signupRes.body.user.id;
});

afterAll(async () => {
  if (infraAvailable) {
    await prisma.uploadSessionFile.deleteMany({ where: { session: { ownerId: userId } } });
    await prisma.uploadSession.deleteMany({ where: { ownerId: userId } });
    await prisma.processingJob.deleteMany({ where: { photo: { ownerId: userId } } });
    await prisma.photo.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { email: testEmail } });
    await prisma.$disconnect();
  }
});

describe("batch upload (specs/production-upload-batch.md, smoke)", () => {
  it("POST /api/upload/initiate with no session cookie -> 401", async () => {
    const res = await request(app)
      .post("/api/upload/initiate")
      .send({ files: [] });
    expect(res.status).toBe(401);
  });

  it("413 with no UploadSession row created when the batch would exceed quota", async () => {
    if (!infraAvailable) {
      console.warn("Skipping: Postgres/MinIO not reachable. Run `docker compose up -d` first.");
      return;
    }

    await prisma.user.update({ where: { id: userId }, data: { storageLimitBytes: BigInt(10) } });
    const sessionCountBefore = await prisma.uploadSession.count({ where: { ownerId: userId } });

    const res = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({
        files: [
          {
            clientId: crypto.randomUUID(),
            filename: "a.jpg",
            sizeBytes: fixtureBuffer.length,
            mimeType: "image/jpeg",
            sha256: sha256Hex(fixtureBuffer),
          },
        ],
      });

    expect(res.status).toBe(413);
    const sessionCountAfter = await prisma.uploadSession.count({ where: { ownerId: userId } });
    expect(sessionCountAfter).toBe(sessionCountBefore);

    await prisma.user.update({ where: { id: userId }, data: { storageLimitBytes: BigInt("5368709120") } });
  });

  // specs/plan-tiered-upload.md: this test's user is on the default `free`
  // plan (getBatchLimit("free") === 50), so a request over that plan's cap
  // now 400s via the NEW plan-aware batch_limit_exceeded shape, not the old
  // flat MAX_BATCH_FILES=1000 ceiling — fixture updated to reflect that
  // (this file's own dedicated plan-tiered coverage lives in
  // plan-tiered-upload.smoke.test.ts, including the ABSOLUTE_MAX_BATCH_FILES
  // cross-tier ceiling case).
  it("over the free plan's batch limit -> 400 batch_limit_exceeded, nothing created", async () => {
    if (!infraAvailable) return;

    const sessionCountBefore = await prisma.uploadSession.count({ where: { ownerId: userId } });
    const freeLimit = getBatchLimit("free");

    const files = Array.from({ length: freeLimit + 1 }, (_, i) => ({
      clientId: crypto.randomUUID(),
      filename: `f${i}.jpg`,
      sizeBytes: 100,
      mimeType: "image/jpeg",
      sha256: crypto.randomBytes(32).toString("hex"),
    }));

    const res = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({ files });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("batch_limit_exceeded");
    expect(res.body.plan).toBe("free");
    expect(res.body.limit).toBe(freeLimit);
    expect(res.body.requested).toBe(freeLimit + 1);
    const sessionCountAfter = await prisma.uploadSession.count({ where: { ownerId: userId } });
    expect(sessionCountAfter).toBe(sessionCountBefore);
  });

  it("duplicate pre-check excludes an existing LIVE photo's hash, but NOT one that's since been trashed", async () => {
    if (!infraAvailable) return;

    // Seed an existing photo via the single-file endpoint so its fileSha256
    // is a real, queryable row.
    const uploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fixturePath);
    expect(uploadRes.status).toBe(202);
    const existingPhotoId = uploadRes.body.photoId as string;
    const existingHash = sha256Hex(fixtureBuffer);

    const dupClientId = crypto.randomUUID();
    const initRes = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({
        files: [
          {
            clientId: dupClientId,
            filename: "dup.jpg",
            sizeBytes: fixtureBuffer.length,
            mimeType: "image/jpeg",
            sha256: existingHash,
          },
        ],
      });

    expect(initRes.status).toBe(201);
    expect(initRes.body.duplicates).toEqual([{ clientId: dupClientId, existingPhotoId }]);
    expect(initRes.body.files).toHaveLength(0);

    // Trash the existing photo, then re-initiate the SAME hash — it must now
    // be treated as new (T-system: a trashed photo's hash never blocks a
    // re-upload).
    const deleteRes = await request(app)
      .delete(`/api/photos/${existingPhotoId}`)
      .set("Cookie", sessionCookie);
    expect(deleteRes.status).toBe(200);

    const freshClientId = crypto.randomUUID();
    const initRes2 = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({
        files: [
          {
            clientId: freshClientId,
            filename: "dup.jpg",
            sizeBytes: fixtureBuffer.length,
            mimeType: "image/jpeg",
            sha256: existingHash,
          },
        ],
      });

    expect(initRes2.status).toBe(201);
    expect(initRes2.body.duplicates).toEqual([]);
    expect(initRes2.body.files).toHaveLength(1);
    expect(initRes2.body.files[0].clientId).toBe(freshClientId);

    // Abort this session's real multipart upload (test cleanup — nothing
    // asserted about abort itself here, that's covered in its own test).
    await request(app)
      .delete("/api/upload/abort")
      .set("Cookie", sessionCookie)
      .send({ sessionId: initRes2.body.sessionId });
  });

  it("a real multi-file batch: parts PUT directly to MinIO (no auth header) -> /complete creates Photo rows shaped like the single-file route, jobs enqueued", async () => {
    if (!infraAvailable) return;

    const files = [
      { clientId: crypto.randomUUID(), filename: "batch-1.jpg", buffer: uniqueJpegBuffer() },
      { clientId: crypto.randomUUID(), filename: "batch-2.jpg", buffer: uniqueJpegBuffer() },
      { clientId: crypto.randomUUID(), filename: "batch-3.jpg", buffer: uniqueJpegBuffer() },
    ];

    const initRes = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({
        files: files.map((f) => ({
          clientId: f.clientId,
          filename: f.filename,
          sizeBytes: f.buffer.length,
          mimeType: "image/jpeg",
          sha256: sha256Hex(f.buffer),
        })),
      });

    expect(initRes.status).toBe(201);
    expect(initRes.body.files).toHaveLength(3);
    expect(initRes.body.duplicates).toEqual([]);

    // Confirm the presigned part URL genuinely targets MinIO directly, not
    // this backend's own /api/* namespace.
    const firstUrl: string = initRes.body.files[0].partUrls[0].url;
    expect(firstUrl).toContain(`:${process.env.MINIO_PORT ?? "9000"}`);
    expect(firstUrl).not.toContain("/api/");

    const buffersByClientId: Record<string, Buffer> = {};
    for (const f of files) buffersByClientId[f.clientId] = f.buffer;

    const uploadedParts = await uploadAllParts(initRes.body.files, buffersByClientId);

    const completeRes = await request(app)
      .post("/api/upload/complete")
      .set("Cookie", sessionCookie)
      .send({ sessionId: initRes.body.sessionId, files: uploadedParts });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.results).toHaveLength(3);
    for (const result of completeRes.body.results) {
      expect(result.status).toBe("queued");
      expect(result.photoId).toBeDefined();

      const sourceFile = files.find((f) => f.clientId === result.clientId)!;
      const photo = await prisma.photo.findUnique({ where: { id: result.photoId } });
      expect(photo).not.toBeNull();
      expect(photo?.ownerId).toBe(userId);
      // A live dev worker may already be processing/have-finished this job by
      // the time we read it back — the SHAPE (not the exact terminal-timing)
      // of the row is what this test is verifying, matching upload.smoke.
      // test.ts's own "same fields present" spirit rather than its narrower
      // "checked within 1s of a fresh 202" timing assumption.
      expect(["pending", "processing", "done", "duplicate", "failed"]).toContain(
        photo?.aiClassificationStatus,
      );
      expect(photo?.mimeType).toBe("image/jpeg");
      expect(photo?.sizeBytes).toBe(sourceFile.buffer.length);
      expect(photo?.fileSha256).toBe(sha256Hex(sourceFile.buffer));
      expect(photo?.s3Key).toContain(initRes.body.sessionId);

      const job = await prisma.processingJob.findFirst({ where: { photoId: result.photoId } });
      expect(job).not.toBeNull();
      expect(job?.jobType).toBe("pipeline");
    }

    const session = await prisma.uploadSession.findUnique({ where: { id: initRes.body.sessionId } });
    expect(session?.status).toBe("completed");
    expect(session?.completedFiles).toBe(3);
    expect(session?.failedFiles).toBe(0);
  });

  it("partial success: a tampered ETag fails ONLY that file, the other still completes; storageUsedBytes reflects only the real success", async () => {
    if (!infraAvailable) return;

    const goodClientId = crypto.randomUUID();
    const badClientId = crypto.randomUUID();
    const goodBuffer = uniqueJpegBuffer();
    const badBuffer = uniqueJpegBuffer();

    const dbUserBefore = await prisma.user.findUnique({ where: { id: userId } });
    const usedBefore = dbUserBefore!.storageUsedBytes;

    const initRes = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({
        files: [
          {
            clientId: goodClientId,
            filename: "good.jpg",
            sizeBytes: goodBuffer.length,
            mimeType: "image/jpeg",
            sha256: sha256Hex(goodBuffer),
          },
          {
            clientId: badClientId,
            filename: "bad.jpg",
            sizeBytes: badBuffer.length,
            mimeType: "image/jpeg",
            sha256: sha256Hex(badBuffer),
          },
        ],
      });
    expect(initRes.status).toBe(201);

    const buffersByClientId = { [goodClientId]: goodBuffer, [badClientId]: badBuffer };
    const uploadedParts = await uploadAllParts(initRes.body.files, buffersByClientId);

    // Tamper the bad file's ETag — a bogus value S3/MinIO will reject at
    // CompleteMultipartUpload time.
    const tamperedParts = uploadedParts.map((f) =>
      f.clientId === badClientId
        ? { clientId: f.clientId, parts: f.parts.map((p) => ({ ...p, eTag: '"0000deadbeef0000deadbeef0000dead"' })) }
        : f,
    );

    const completeRes = await request(app)
      .post("/api/upload/complete")
      .set("Cookie", sessionCookie)
      .send({ sessionId: initRes.body.sessionId, files: tamperedParts });

    expect(completeRes.status).toBe(200);
    const goodResult = completeRes.body.results.find((r: { clientId: string }) => r.clientId === goodClientId);
    const badResult = completeRes.body.results.find((r: { clientId: string }) => r.clientId === badClientId);

    expect(goodResult.status).toBe("queued");
    expect(goodResult.photoId).toBeDefined();
    expect(badResult.failed).toBe(true);
    expect(badResult.reason).toBe("assembly_failed");

    const badPhoto = await prisma.photo.findFirst({ where: { ownerId: userId, originalFilename: "bad.jpg" } });
    expect(badPhoto).toBeNull();

    const session = await prisma.uploadSession.findUnique({ where: { id: initRes.body.sessionId } });
    expect(session?.completedFiles).toBe(1);
    expect(session?.failedFiles).toBe(1);
    expect(session?.status).toBe("completed"); // 1 + 1 === totalFiles(2), terminal

    const dbUserAfter = await prisma.user.findUnique({ where: { id: userId } });
    const usedAfter = dbUserAfter!.storageUsedBytes;
    expect(usedAfter - usedBefore).toBe(BigInt(goodBuffer.length)); // only the ONE real success, not the declared batch total
  });

  it("content-sniff failure on assembly -> invalid_file_type, assembled object deleted, no Photo row", async () => {
    if (!infraAvailable) return;

    const garbage = Buffer.from("this is definitely not a real image file, just plain ascii padding bytes");
    const clientId = crypto.randomUUID();

    const initRes = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({
        files: [
          {
            clientId,
            filename: "fake.jpg",
            sizeBytes: garbage.length,
            mimeType: "image/jpeg", // honest claim per the spec's scenario, real bytes disagree
            sha256: sha256Hex(garbage),
          },
        ],
      });
    expect(initRes.status).toBe(201);

    const uploadedParts = await uploadAllParts(initRes.body.files, { [clientId]: garbage });

    const completeRes = await request(app)
      .post("/api/upload/complete")
      .set("Cookie", sessionCookie)
      .send({ sessionId: initRes.body.sessionId, files: uploadedParts });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.results[0].failed).toBe(true);
    expect(completeRes.body.results[0].reason).toBe("invalid_file_type");

    const photo = await prisma.photo.findFirst({ where: { ownerId: userId, originalFilename: "fake.jpg" } });
    expect(photo).toBeNull();
  });

  it("DELETE /api/upload/abort genuinely aborts the multipart upload in MinIO, and /complete afterward -> 409", async () => {
    if (!infraAvailable) return;

    const clientId = crypto.randomUUID();
    const initRes = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({
        files: [
          {
            clientId,
            filename: "abort-me.jpg",
            sizeBytes: fixtureBuffer.length,
            mimeType: "image/jpeg",
            sha256: sha256Hex(fixtureBuffer),
          },
        ],
      });
    expect(initRes.status).toBe(201);
    const { key, uploadId } = initRes.body.files[0];

    expect(await hasOutstandingMultipartUpload(key, uploadId)).toBe(true);

    const abortRes = await request(app)
      .delete("/api/upload/abort")
      .set("Cookie", sessionCookie)
      .send({ sessionId: initRes.body.sessionId });
    expect(abortRes.status).toBe(200);
    expect(abortRes.body.aborted).toBe(true);

    expect(await hasOutstandingMultipartUpload(key, uploadId)).toBe(false);

    const completeRes = await request(app)
      .post("/api/upload/complete")
      .set("Cookie", sessionCookie)
      .send({ sessionId: initRes.body.sessionId, files: [{ clientId, parts: [{ partNumber: 1, eTag: '"x"' }] }] });
    expect(completeRes.status).toBe(409);
  });

  it("a stale in_progress session past its expiresAt is reconciled by the cleanup job: aborted in MinIO, session -> expired", async () => {
    if (!infraAvailable) return;

    const key = `${userId}/batch/stale-test/${crypto.randomUUID()}/original.jpg`;
    const { uploadId } = await createMultipartUpload(key, "image/jpeg");

    const session = await prisma.uploadSession.create({
      data: {
        ownerId: userId,
        totalFiles: 1,
        totalBytes: BigInt(fixtureBuffer.length),
        status: "in_progress",
        expiresAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour in the past
        files: {
          create: [
            {
              clientId: crypto.randomUUID(),
              key,
              uploadId,
              sizeBytes: BigInt(fixtureBuffer.length),
              sha256: sha256Hex(fixtureBuffer),
              mimeType: "image/jpeg",
              originalFilename: "stale.jpg",
              status: "pending",
            },
          ],
        },
      },
    });

    expect(await hasOutstandingMultipartUpload(key, uploadId)).toBe(true);

    const result = await runUploadSessionCleanupJob();
    expect(result.sessionsExpired).toBeGreaterThanOrEqual(1);

    const updated = await prisma.uploadSession.findUnique({ where: { id: session.id }, include: { files: true } });
    expect(updated?.status).toBe("expired");
    expect(updated?.files[0].status).toBe("aborted");
    expect(await hasOutstandingMultipartUpload(key, uploadId)).toBe(false);
  });
});

if (!fs.existsSync(fixturePath)) {
  throw new Error(`Missing test fixture: ${fixturePath}`);
}
