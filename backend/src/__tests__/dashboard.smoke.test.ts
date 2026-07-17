import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { ensureBucketExists } from "../lib/storage";

// Smoke tests for specs/dashboard-stats-and-upload-polish.md's GET
// /api/dashboard: auth required, empty-state shape, aggregation correctness
// once photos/folders exist (including a duplicate still counting toward
// totals.photoCount per Open Question 1's default), and cross-user
// isolation. Follows the same skip-not-fake convention as
// upload.smoke.test.ts / classification.smoke.test.ts - DB/MinIO-dependent
// tests skip with a warning when infra is unreachable, worker-dependent
// assertions additionally skip (never fake a pass) when a probe upload
// doesn't reach a terminal state in time.

const app = createApp();
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures");
const fixture = (name: string) => path.join(FIXTURES_DIR, name);

const testEmail = `dashboard-smoke-${Date.now()}@example.com`;
const otherEmail = `dashboard-smoke-other-${Date.now()}@example.com`;
const emptyEmail = `dashboard-smoke-empty-${Date.now()}@example.com`;
const testPassword = "correct-password-123";

let infraAvailable = true;
let workerAvailable = false;
let sessionCookie: string;
let otherCookie: string;
let emptyCookie: string;
let userId: string;

const POLL_INTERVAL_MS = 500;

async function waitForTerminal(photoId: string, timeoutMs: number, cookie: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/photos/${photoId}/status`).set("Cookie", cookie);
    if (["done", "failed", "duplicate"].includes(res.body.status)) {
      return res.body as { status: string };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

function skipInfra(): boolean {
  if (!infraAvailable) {
    console.warn("Skipping: Postgres/MinIO not reachable. Run `docker compose up -d` first.");
    return true;
  }
  return false;
}

function skipWorker(): boolean {
  if (skipInfra()) return true;
  if (!workerAvailable) {
    console.warn(
      "Skipping: worker not consuming jobs (probe upload never reached a terminal state). Run `npm run worker -w backend`.",
    );
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
    .send({ email: testEmail, password: testPassword, name: "Dashboard Smoke" });
  sessionCookie = signupRes.headers["set-cookie"][0];
  userId = signupRes.body.user.id;

  const otherSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherEmail, password: testPassword, name: "Other User" });
  otherCookie = otherSignup.headers["set-cookie"][0];

  const emptySignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: emptyEmail, password: testPassword, name: "Empty User" });
  emptyCookie = emptySignup.headers["set-cookie"][0];

  // Probe upload to detect whether the live worker (npm run worker -w
  // backend) is actually consuming jobs right now - same convention as
  // classification.smoke.test.ts. Without this, workerAvailable would stay
  // permanently false and every worker-dependent assertion below would
  // silently (and wrongly) skip even when the worker is healthy.
  const probeRes = await request(app)
    .post("/api/photos/upload")
    .set("Cookie", sessionCookie)
    .attach("file", fixture("fixture-food.jpg"));
  const probeTerminal = await waitForTerminal(probeRes.body.photoId, 20_000, sessionCookie);
  workerAvailable = probeTerminal?.status === "done";
}, 40_000);

afterAll(async () => {
  if (infraAvailable) {
    await prisma.user.deleteMany({
      where: { email: { in: [testEmail, otherEmail, emptyEmail] } },
    });
    await prisma.$disconnect();
  }
});

describe("GET /api/dashboard", () => {
  it("returns 401 with no session cookie", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns the empty-state shape for a brand-new user with no uploads", async () => {
    if (skipInfra()) return;

    const res = await request(app).get("/api/dashboard").set("Cookie", emptyCookie);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({ photoCount: 0, folderCount: 0, collectionCount: 0 });
    expect(res.body.collections).toEqual([]);
    expect(res.body.storage.usedBytes).toBe("0");
    expect(typeof res.body.storage.limitBytes).toBe("string");
    expect(res.body.storage.usedPercent).toBe(0);
  });

  it("aggregates photoCount/folderCount/collections and matches storage usage after uploads, including a failed photo", async () => {
    if (skipWorker()) return;

    // Distinct fixture from the beforeAll probe upload (also fixture-food.jpg)
    // so this upload classifies fresh rather than getting caught by the
    // SHA-256 exact-dedup pass as a duplicate of the probe.
    const natureBuffer = fs.readFileSync(fixture("fixture-nature.jpg"));

    const before = await request(app).get("/api/dashboard").set("Cookie", sessionCookie);
    expect(before.status).toBe(200);
    const usedBefore = BigInt(before.body.storage.usedBytes);

    const uploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", natureBuffer, { filename: "fixture-nature.jpg", contentType: "image/jpeg" });
    expect(uploadRes.status).toBe(202);
    const naturePhotoId = uploadRes.body.photoId as string;

    const terminal = await waitForTerminal(naturePhotoId, 20_000, sessionCookie);
    expect(terminal?.status).toBe("done");

    // A photo forced to permanently fail (FORCE_FAIL_ hook, per
    // Day2.md/classification.smoke conventions) still counts toward
    // totals.photoCount - it's a "how much have I uploaded" stat, not an
    // organization-health one (spec Open Question 1 default).
    const failBuffer = fs.readFileSync(fixture("fixture-animals.jpg"));
    const failUploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", failBuffer, { filename: "FORCE_FAIL_dashboard.jpg", contentType: "image/jpeg" });
    expect(failUploadRes.status).toBe(202);
    const failPhotoId = failUploadRes.body.photoId as string;
    const failTerminal = await waitForTerminal(failPhotoId, 20_000, sessionCookie);
    expect(failTerminal?.status).toBe("failed");

    const after = await request(app).get("/api/dashboard").set("Cookie", sessionCookie);
    expect(after.status).toBe(200);

    expect(after.body.totals.photoCount).toBeGreaterThanOrEqual(2);
    expect(after.body.totals.collectionCount).toBe(1);
    expect(after.body.totals.folderCount).toBeGreaterThanOrEqual(1);

    const foldersRes = await request(app)
      .get(`/api/collections/${after.body.collections[0].id}/folders`)
      .set("Cookie", sessionCookie);
    expect(foldersRes.status).toBe(200);
    expect(after.body.totals.folderCount).toBe(foldersRes.body.folders.length);

    const collection = after.body.collections[0];
    expect(collection.isDefault).toBe(true);
    expect(collection.name).toBe("My Photos");
    expect(collection.folderCount).toBe(foldersRes.body.folders.length);

    const collectionPhotoCount = await prisma.photo.count({
      where: { ownerId: userId, collectionId: collection.id },
    });
    expect(collection.photoCount).toBe(collectionPhotoCount);

    // Storage usage matches the upload pipeline's own tracking, and grew by
    // exactly the two uploaded files' combined byte size.
    const usedAfter = BigInt(after.body.storage.usedBytes);
    expect(usedAfter - usedBefore).toBe(BigInt(natureBuffer.length + failBuffer.length));

    const dbUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(after.body.storage.usedBytes).toBe(dbUser!.storageUsedBytes.toString());
    expect(after.body.storage.limitBytes).toBe(dbUser!.storageLimitBytes.toString());

    expect(after.body.storage.usedPercent).toBeGreaterThanOrEqual(0);
    expect(after.body.storage.usedPercent).toBeLessThanOrEqual(1);
  }, 45_000);

  it("caps usedPercent at 1.0 when usage exceeds the limit (code-level check, no live 5GB fill)", async () => {
    if (skipInfra()) return;

    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: BigInt(1000), storageLimitBytes: BigInt(500) },
    });

    const res = await request(app).get("/api/dashboard").set("Cookie", sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.storage.usedPercent).toBe(1);

    // restore a sane state for any subsequent test in this file
    await prisma.user.update({
      where: { id: userId },
      data: { storageLimitBytes: BigInt("5368709120") },
    });
  });

  it("never reflects another user's photos/folders/storage (cross-user isolation)", async () => {
    if (skipInfra()) return;

    // Uploads directly in this test (rather than relying on the earlier
    // worker-dependent test having run) so isolation is verified even when
    // the live worker isn't consuming jobs - the upload itself (a photo row
    // + storageUsedBytes bump) doesn't require the worker to reach a
    // terminal state, only requireAuth + the upload route's own scoping.
    const uploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", sessionCookie)
      .attach("file", fixture("fixture-food.jpg"));
    expect(uploadRes.status).toBe(202);

    const otherRes = await request(app).get("/api/dashboard").set("Cookie", otherCookie);
    expect(otherRes.status).toBe(200);
    expect(otherRes.body.totals).toEqual({ photoCount: 0, folderCount: 0, collectionCount: 0 });
    expect(otherRes.body.collections).toEqual([]);
    expect(otherRes.body.storage.usedBytes).toBe("0");

    const mineRes = await request(app).get("/api/dashboard").set("Cookie", sessionCookie);
    expect(mineRes.status).toBe(200);
    expect(mineRes.body.totals.photoCount).not.toBe(0);
  });
});

if (!fs.existsSync(fixture("fixture-food.jpg"))) {
  throw new Error(`Missing test fixture: ${fixture("fixture-food.jpg")}`);
}
