import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { ensureBucketExists } from "../lib/storage";

// Smoke test covering specs/upload-pipeline.md's success signal at the API
// layer: upload -> 202 fast -> photos/processing_jobs rows exist -> quota
// and content-sniffing rejections happen before any DB/MinIO write ->
// ownership check on GET routes returns 404 (not 403) for a non-owner.
//
// Full worker-pipeline behavior (thumbnails/EXIF/pHash-dedup/mock
// classification actually running end-to-end, retry/backoff, TTL expiry)
// requires the separate `npm run worker -w backend` process running - this
// suite intentionally does not start the worker (per asyncHandler/session
// test conventions, keeps this file fast and DB/MinIO-only). The Developer
// Agent verified the full round-trip (including worker + TTL expiry)
// manually against a live stack; see the MR draft / STATUS.md for that
// evidence. Requires Postgres + MinIO reachable (docker compose up -d) -
// skips gracefully otherwise, same convention as auth.smoke.test.ts.

const app = createApp();
const fixturePath = path.join(__dirname, "fixtures", "sample.jpg");

const testEmail = `upload-smoke-${Date.now()}@example.com`;
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
    .send({ email: testEmail, password: testPassword, name: "Upload Smoke" });
  sessionCookie = signupRes.headers["set-cookie"][0];
  userId = signupRes.body.user.id;
});

afterAll(async () => {
  if (infraAvailable) {
    await prisma.photo.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { email: testEmail } });
    await prisma.$disconnect();
  }
});

describe("photo upload pipeline (smoke)", () => {
  it("rejects an unauthenticated upload with 401", async () => {
    const res = await request(app).post("/api/photos/upload").attach("file", fixturePath);
    expect(res.status).toBe(401);
  });

  it("accepts a valid JPEG fast (202) and creates photos/processing_jobs rows", async () => {
    if (!infraAvailable) {
      console.warn("Skipping: Postgres/MinIO not reachable. Run `docker compose up -d` first.");
      return;
    }

    const start = Date.now();
    const res = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fixturePath);
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(202);
    expect(res.body.photoId).toBeDefined();
    expect(res.body.status).toBe("pending");
    expect(elapsedMs).toBeLessThan(1000); // proves thumbnails/EXIF/pHash/classification are not awaited inline

    const photo = await prisma.photo.findUnique({ where: { id: res.body.photoId } });
    expect(photo).not.toBeNull();
    expect(photo?.aiClassificationStatus).toBe("pending");
    expect(photo?.s3Key).toContain(res.body.photoId);

    const job = await prisma.processingJob.findFirst({ where: { photoId: res.body.photoId } });
    expect(job).not.toBeNull();
    expect(job?.jobType).toBe("pipeline");
  });

  it("rejects a disallowed MIME type (content-sniffed, not extension-trusted) with 400 before any write", async () => {
    if (!infraAvailable) return;

    const fakeBuffer = Buffer.from("MZ\x90\x00\x03\x00\x00\x00fake-exe-bytes");
    const countBefore = await prisma.photo.count({ where: { ownerId: userId } });

    const res = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fakeBuffer, { filename: "not-a-photo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);

    const countAfter = await prisma.photo.count({ where: { ownerId: userId } });
    expect(countAfter).toBe(countBefore); // no orphaned row created
  });

  it("returns 413 with no photo row created when storage quota would be exceeded", async () => {
    if (!infraAvailable) return;

    await prisma.user.update({ where: { id: userId }, data: { storageLimitBytes: BigInt(10) } });
    const countBefore = await prisma.photo.count({ where: { ownerId: userId } });

    const res = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fixturePath);

    expect(res.status).toBe(413);

    const countAfter = await prisma.photo.count({ where: { ownerId: userId } });
    expect(countAfter).toBe(countBefore);

    // restore quota for any subsequent test in this file
    await prisma.user.update({
      where: { id: userId },
      data: { storageLimitBytes: BigInt("5368709120") },
    });
  });

  it("GET /api/photos/:id returns 404 (not 403) for a photo owned by a different user", async () => {
    if (!infraAvailable) return;

    const uploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fixturePath);

    const otherEmail = `upload-smoke-other-${Date.now()}@example.com`;
    const otherSignup = await request(app)
      .post("/api/auth/signup")
      .send({ email: otherEmail, password: testPassword, name: "Other" });
    const otherCookie = otherSignup.headers["set-cookie"][0];

    const res = await request(app)
      .get(`/api/photos/${uploadRes.body.photoId}`)
      .set("Cookie", otherCookie);

    expect(res.status).toBe(404);

    await prisma.user.deleteMany({ where: { email: otherEmail } });
  });

  it("GET /api/photos/:id/status returns 404 for a nonexistent photo id", async () => {
    if (!infraAvailable) return;

    const res = await request(app)
      .get("/api/photos/00000000-0000-0000-0000-000000000000/status")
      .set("Cookie", sessionCookie);

    expect(res.status).toBe(404);
  });
});

// Sanity check that the fixture actually exists (fails loudly rather than
// every test silently no-op'ing if someone deletes the fixture file).
if (!fs.existsSync(fixturePath)) {
  throw new Error(`Missing test fixture: ${fixturePath}`);
}
