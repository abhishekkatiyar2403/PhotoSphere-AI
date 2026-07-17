import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { ensureBucketExists } from "../lib/storage";
import { photoProcessingQueue } from "../lib/queue";
import {
  BATCH_LIMITS,
  STORAGE_LIMITS_BYTES,
  PRIORITY_BY_PLAN,
  getBatchLimit,
  getJobPriority,
  getStorageLimitBytes,
} from "../lib/plans";
import { ABSOLUTE_MAX_BATCH_FILES } from "../lib/validation";

// Covers specs/plan-tiered-upload.md's Acceptance Criteria checklist: real
// plan-tiered batch caps/storage/priority + the PATCH /api/auth/plan
// switcher, against real local Postgres/MinIO/Redis (docker compose up -d).
// Skips gracefully if infra isn't reachable, same convention as every other
// smoke test in this directory.

const app = createApp();
const fixturePath = path.join(__dirname, "fixtures", "sample.jpg");
const fixtureBuffer = fs.readFileSync(fixturePath);

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function uniqueJpegBuffer(): Buffer {
  return Buffer.concat([fixtureBuffer, crypto.randomBytes(16)]);
}

const testEmail = `plan-tiered-smoke-${Date.now()}@example.com`;
const testPassword = "correct-password-123";
let sessionCookie: string;
let userId: string;

let infraAvailable = true;

function skipInfra(): boolean {
  if (!infraAvailable) {
    console.warn("Skipping: Postgres/MinIO/Redis not reachable. Run `docker compose up -d` first.");
    return true;
  }
  return false;
}

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
    .send({ email: testEmail, password: testPassword, name: "Plan Tiered Smoke" });
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

describe("lib/plans.ts — exported tier constants (unit-level, no infra needed)", () => {
  it("exports the exact numbers per spec: free {50, 5GB, priority 10}, pro {500, 100GB, priority 5}, studio {1500, 500GB, priority 1}", () => {
    expect(BATCH_LIMITS).toEqual({ free: 50, pro: 500, studio: 1500 });
    expect(STORAGE_LIMITS_BYTES.free).toBe(5n * 1024n * 1024n * 1024n);
    expect(STORAGE_LIMITS_BYTES.pro).toBe(100n * 1024n * 1024n * 1024n);
    expect(STORAGE_LIMITS_BYTES.studio).toBe(500n * 1024n * 1024n * 1024n);
    expect(PRIORITY_BY_PLAN).toEqual({ studio: 1, pro: 5, free: 10 });
    expect(getBatchLimit("free")).toBe(50);
    expect(getBatchLimit("pro")).toBe(500);
    expect(getBatchLimit("studio")).toBe(1500);
    expect(getStorageLimitBytes("free")).toBe(5n * 1024n * 1024n * 1024n);
    expect(getStorageLimitBytes("pro")).toBe(100n * 1024n * 1024n * 1024n);
    expect(getStorageLimitBytes("studio")).toBe(500n * 1024n * 1024n * 1024n);
  });

  it("the off-by-inversion the spec explicitly flags: getJobPriority('studio') < getJobPriority('free') numerically (BullMQ: lower = processed first)", () => {
    expect(getJobPriority("studio")).toBeLessThan(getJobPriority("pro"));
    expect(getJobPriority("pro")).toBeLessThan(getJobPriority("free"));
  });

  it("normalizes an unrecognized plan string to free (same safe-default posture as checkGuestLimit)", () => {
    expect(getBatchLimit("premium")).toBe(BATCH_LIMITS.free);
    expect(getJobPriority("")).toBe(PRIORITY_BY_PLAN.free);
  });
});

describe("PATCH /api/auth/plan — no-billing testing-only switcher", () => {
  it("401 with no session", async () => {
    const res = await request(app).patch("/api/auth/plan").send({ plan: "pro" });
    expect(res.status).toBe(401);
  });

  it("400 on an invalid plan value, user.plan unchanged", async () => {
    if (skipInfra()) return;

    const before = await prisma.user.findUnique({ where: { id: userId } });

    const res = await request(app)
      .patch("/api/auth/plan")
      .set("Cookie", sessionCookie)
      .send({ plan: "premium" });
    expect(res.status).toBe(400);

    const after = await prisma.user.findUnique({ where: { id: userId } });
    expect(after?.plan).toBe(before?.plan);
  });

  it("switches free -> pro -> studio, syncing storageLimitBytes in the SAME call, confirmed via GET /api/auth/me and GET /api/dashboard each time, and writes a plan_changed audit row each switch", async () => {
    if (skipInfra()) return;

    for (const plan of ["pro", "studio", "free"] as const) {
      const switchRes = await request(app)
        .patch("/api/auth/plan")
        .set("Cookie", sessionCookie)
        .send({ plan });
      expect(switchRes.status).toBe(200);
      expect(switchRes.body.user.plan).toBe(plan);
      expect(switchRes.body.storage.limitBytes).toBe(getStorageLimitBytes(plan).toString());

      const meRes = await request(app).get("/api/auth/me").set("Cookie", sessionCookie);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.plan).toBe(plan);

      const dashRes = await request(app).get("/api/dashboard").set("Cookie", sessionCookie);
      expect(dashRes.status).toBe(200);
      expect(dashRes.body.storage.limitBytes).toBe(getStorageLimitBytes(plan).toString());
    }

    const auditRes = await request(app).get("/api/audit").set("Cookie", sessionCookie);
    expect(auditRes.status).toBe(200);
    const planChangedEntries = auditRes.body.entries.filter(
      (e: { action: string }) => e.action === "plan_changed",
    );
    // 3 switches above (pro, studio, free) — at least that many rows, scoped
    // to this owner only.
    expect(planChangedEntries.length).toBeGreaterThanOrEqual(3);
    const last = planChangedEntries[0]; // newest-first
    expect(last.metadata).toMatchObject({ toPlan: "free" });
  });

  it("downgrading while storageUsedBytes is over the NEW (lower) limit doesn't crash or block the switch — the switch succeeds, and the EXISTING 413 quota check fires exactly as it would for any other over-quota user on the next upload attempt", async () => {
    if (skipInfra()) return;

    // Put the account on studio (500GB) with usage that would exceed free's
    // 5GB limit, then downgrade straight to free.
    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "studio" });
    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: 10n * 1024n * 1024n * 1024n }, // 10GB, over free's 5GB
    });

    const downgradeRes = await request(app)
      .patch("/api/auth/plan")
      .set("Cookie", sessionCookie)
      .send({ plan: "free" });
    expect(downgradeRes.status).toBe(200); // no special "can't downgrade" guard (PTU3)
    expect(downgradeRes.body.user.plan).toBe("free");

    // Next upload attempt (single-file route) -> the SAME 413 quota check
    // that already exists, no new/different error path.
    const uploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fixturePath);
    expect(uploadRes.status).toBe(413);

    // Restore a sane state for later tests in this file.
    await prisma.user.update({ where: { id: userId }, data: { storageUsedBytes: 0n } });
    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "free" });
  });
});

describe("POST /api/upload/initiate — plan-aware batch cap (PTU4/batch_limit_exceeded)", () => {
  it("free plan: one over the cap (51) -> 400 batch_limit_exceeded, nothing created", async () => {
    if (skipInfra()) return;

    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "free" });
    const sessionCountBefore = await prisma.uploadSession.count({ where: { ownerId: userId } });

    const limit = getBatchLimit("free");
    const files = Array.from({ length: limit + 1 }, (_, i) => ({
      clientId: crypto.randomUUID(),
      filename: `free-cap-${i}.jpg`,
      sizeBytes: 100,
      mimeType: "image/jpeg",
      sha256: crypto.randomBytes(32).toString("hex"),
    }));

    const res = await request(app).post("/api/upload/initiate").set("Cookie", sessionCookie).send({ files });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "batch_limit_exceeded", plan: "free", limit, requested: limit + 1 });

    const sessionCountAfter = await prisma.uploadSession.count({ where: { ownerId: userId } });
    expect(sessionCountAfter).toBe(sessionCountBefore);
  });

  it("the SAME 51-file batch succeeds on the pro plan (under pro's 500 cap)", async () => {
    if (skipInfra()) return;

    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "pro" });

    const files = Array.from({ length: getBatchLimit("free") + 1 }, (_, i) => ({
      clientId: crypto.randomUUID(),
      filename: `pro-cap-${i}.jpg`,
      sizeBytes: 100,
      mimeType: "image/jpeg",
      sha256: crypto.randomBytes(32).toString("hex"),
    }));

    const res = await request(app).post("/api/upload/initiate").set("Cookie", sessionCookie).send({ files });
    expect(res.status).toBe(201);

    // Cleanup — abort the created session so it doesn't linger as
    // in_progress.
    await request(app).delete("/api/upload/abort").set("Cookie", sessionCookie).send({ sessionId: res.body.sessionId });
    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "free" });
  });

  it("studio plan, 1501 files (one over the ABSOLUTE cross-tier ceiling) -> still 400, but at the Zod-schema layer (generic Validation failed, never reaches batch_limit_exceeded) — proving the two-layer design", async () => {
    if (skipInfra()) return;

    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "studio" });

    const files = Array.from({ length: ABSOLUTE_MAX_BATCH_FILES + 1 }, (_, i) => ({
      clientId: crypto.randomUUID(),
      filename: `studio-ceiling-${i}.jpg`,
      sizeBytes: 100,
      mimeType: "image/jpeg",
      sha256: crypto.randomBytes(32).toString("hex"),
    }));

    const res = await request(app).post("/api/upload/initiate").set("Cookie", sessionCookie).send({ files });
    expect(res.status).toBe(400);
    // The Zod-layer shape, NOT batch_limit_exceeded — proves this never
    // reached the DB/plan lookup (getBatchLimit("studio") === 1500, so a
    // 1501-file batch under studio's OWN cap would otherwise be allowed).
    expect(res.body.error).toBe("Validation failed");

    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "free" });
  });
});

describe("BullMQ job priority — studio < pro < free, same for BOTH the single-file and batch code paths", () => {
  it("single-file route (POST /api/photos/upload): a studio-plan user's job carries priority 1, a free-plan user's job carries priority 10", async () => {
    if (skipInfra()) return;

    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "studio" });
    const studioUploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fixturePath);
    expect(studioUploadRes.status).toBe(202);
    const studioJob = await photoProcessingQueue.getJob(studioUploadRes.body.jobId);
    expect(studioJob?.opts.priority).toBe(getJobPriority("studio"));
    expect(studioJob?.opts.priority).toBe(1);

    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "free" });
    const freeUploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fixturePath);
    expect(freeUploadRes.status).toBe(202);
    const freeJob = await photoProcessingQueue.getJob(freeUploadRes.body.jobId);
    expect(freeJob?.opts.priority).toBe(getJobPriority("free"));
    expect(freeJob?.opts.priority).toBe(10);
  });

  it("batch route (POST /api/upload/complete): a studio-plan user's job carries the SAME priority (1) as the single-file route for the same plan", async () => {
    if (skipInfra()) return;

    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "studio" });

    const buffer = uniqueJpegBuffer();
    const clientId = crypto.randomUUID();
    const initRes = await request(app)
      .post("/api/upload/initiate")
      .set("Cookie", sessionCookie)
      .send({
        files: [
          {
            clientId,
            filename: "priority-check.jpg",
            sizeBytes: buffer.length,
            mimeType: "image/jpeg",
            sha256: sha256Hex(buffer),
          },
        ],
      });
    expect(initRes.status).toBe(201);

    const file = initRes.body.files[0];
    const parts: { partNumber: number; eTag: string }[] = [];
    for (const { partNumber, url } of file.partUrls) {
      const putRes = await fetch(url, { method: "PUT", body: buffer });
      expect(putRes.ok).toBe(true);
      const eTag = putRes.headers.get("etag");
      parts.push({ partNumber, eTag: eTag! });
    }

    const completeRes = await request(app)
      .post("/api/upload/complete")
      .set("Cookie", sessionCookie)
      .send({ sessionId: initRes.body.sessionId, files: [{ clientId, parts }] });
    expect(completeRes.status).toBe(200);
    const result = completeRes.body.results[0];
    expect(result.status).toBe("queued");

    const job = await prisma.processingJob.findFirst({ where: { photoId: result.photoId } });
    const bullJob = await photoProcessingQueue.getJob(job!.id);
    expect(bullJob?.opts.priority).toBe(getJobPriority("studio"));
    expect(bullJob?.opts.priority).toBe(1);

    await request(app).patch("/api/auth/plan").set("Cookie", sessionCookie).send({ plan: "free" });
  });
});
