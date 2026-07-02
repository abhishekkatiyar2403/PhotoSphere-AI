import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "../app";
import { computePHash, DEGENERATE_PHASH } from "../lib/phash";
import { prisma } from "../lib/prisma";
import { ensureBucketExists } from "../lib/storage";
import { reclassifyRateLimiter } from "../middleware/reclassifyRateLimiter";
import { uploadRateLimiter } from "../middleware/uploadRateLimiter";

// Smoke tests for specs/ai-classification.md: category mapping -> folder
// auto-creation -> confidence bucketing -> move/reclassify endpoints ->
// two-phase dedup -> auth rate-limit split.
//
// E2E worker tests rely on the REAL worker process (`npm run worker -w
// backend`) consuming the shared BullMQ queue while this suite runs -
// this file does not start it. Follows the established skip-not-fake
// convention: DB/MinIO-dependent tests skip with a warning when infra is
// unreachable, and worker-dependent tests additionally skip (never fake a
// pass) when a probe upload doesn't reach a terminal state in time.

const app = createApp();
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures");

const fixture = (name: string) => path.join(FIXTURES_DIR, name);

// Deterministic second Food-mapping image (sha256[0] % 7 === 1, pHash
// distance >= 20 from every committed fixture), regenerated in-process from
// the same seeded-noise generator the fixtures were built with. Used to
// prove folder REUSE (two different images -> same folder row).
const NOISE_SIZE = 96;
function seededNoise(seed: number): Buffer {
  const raw = Buffer.alloc(NOISE_SIZE * NOISE_SIZE * 3);
  let s = seed >>> 0;
  for (let i = 0; i < raw.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    raw[i] = (s >>> 16) & 0xff;
  }
  return raw;
}
const SECOND_FOOD_SEED = 102;

// Same generator, verified offline: sha256[0] % 7 === 2 (-> ["Document",
// "Text"] -> Documents) with pairwise dHash distance >= 20 from every
// committed fixture AND the seed-102 second-food image. Used by the
// concurrent same-new-category test (exactly one folder row under worker
// concurrency 2).
const SECOND_DOCUMENTS_SEED = 200;

async function noiseJpeg(seed: number): Promise<Buffer> {
  return sharp(seededNoise(seed), {
    raw: { width: NOISE_SIZE, height: NOISE_SIZE, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Solid-color JPEG — always hashes to the degenerate all-zeros dHash. */
async function flatJpeg(r: number, g: number, b: number): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r, g, b } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

const testEmail = `classification-smoke-${Date.now()}@example.com`;
const otherEmail = `classification-smoke-other-${Date.now()}@example.com`;
const limiterEmail = `classification-smoke-limiter-${Date.now()}@example.com`;
const testPassword = "correct-password-123";

let infraAvailable = true;
let workerAvailable = false;
let sessionCookie: string;
let otherCookie: string;
let userId: string;
let otherUserId: string;

// Populated by the beforeAll probe upload (fixture-food.jpg).
let foodPhotoId: string;
let foodFolderId: string | null = null;
let collectionId: string | null = null;

// Populated by the multi-category fixtures test; consumed by the parallel
// reclassify + exif tests below it (declaration order = execution order).
let naturePhotoId: string | null = null;

const POLL_INTERVAL_MS = 500;

type StatusBody = {
  status: string;
  aiLabels: string[];
  aiConfidence: number | null;
  folderId: string | null;
  folder: { id: string; name: string } | null;
  collectionId: string | null;
  duplicateOfPhotoId: string | null;
  dedupMethod: string | null;
  job: { type: string; status: string; attempts: number; errorMessage: string | null } | null;
};

async function getStatus(photoId: string, cookie = sessionCookie): Promise<StatusBody> {
  const res = await request(app).get(`/api/photos/${photoId}/status`).set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as StatusBody;
}

/** Polls the status endpoint until the photo reaches a terminal state (or times out -> null). */
async function waitForTerminal(
  photoId: string,
  timeoutMs: number,
  cookie = sessionCookie,
): Promise<StatusBody | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await getStatus(photoId, cookie);
    if (["done", "failed", "duplicate"].includes(body.status)) {
      return body;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

async function uploadBuffer(buffer: Buffer, filename: string, cookie = sessionCookie) {
  const res = await request(app)
    .post("/api/photos/upload")
    .set("Cookie", cookie)
    .attach("file", buffer, { filename, contentType: "image/jpeg" });
  expect(res.status).toBe(202);
  return res.body.photoId as string;
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
    .send({ email: testEmail, password: testPassword, name: "Classification Smoke" });
  sessionCookie = signupRes.headers["set-cookie"][0];
  userId = signupRes.body.user.id;

  const otherSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherEmail, password: testPassword, name: "Other User" });
  otherCookie = otherSignup.headers["set-cookie"][0];
  otherUserId = otherSignup.body.user.id;

  // Probe upload doubles as the folder-auto-creation subject: if the live
  // worker is running, fixture-food.jpg reaches `done` within seconds.
  foodPhotoId = await uploadBuffer(fs.readFileSync(fixture("fixture-food.jpg")), "fixture-food.jpg");
  const terminal = await waitForTerminal(foodPhotoId, 20_000);
  if (terminal && terminal.status === "done") {
    workerAvailable = true;
    foodFolderId = terminal.folderId;
    collectionId = terminal.collectionId;
  }
}, 40_000);

afterAll(async () => {
  if (infraAvailable) {
    // User delete cascades photos, sessions, collections -> folders.
    await prisma.user.deleteMany({
      where: { email: { in: [testEmail, otherEmail, limiterEmail] } },
    });
    await prisma.$disconnect();
  }
});

describe("classification -> mapping -> folder auto-creation (live worker e2e)", () => {
  it("auto-creates the default collection and the mapped category folder", async () => {
    if (skipWorker()) return;

    const status = await getStatus(foodPhotoId);
    expect(status.status).toBe("done");
    expect(status.aiLabels).toEqual(["Food", "Meal"]);
    expect(status.folderId).not.toBeNull();
    expect(status.collectionId).not.toBeNull();
    expect(status.folder?.name).toBe("Food");
    // Job observability (spec Open Question 11): pipeline row completed.
    expect(status.job?.type).toBe("pipeline");
    expect(status.job?.status).toBe("completed");

    const collectionsRes = await request(app).get("/api/collections").set("Cookie", sessionCookie);
    expect(collectionsRes.status).toBe(200);
    expect(collectionsRes.body.collections).toHaveLength(1);
    expect(collectionsRes.body.collections[0].name).toBe("My Photos");
    expect(collectionsRes.body.collections[0].isDefault).toBe(true);
    expect(collectionsRes.body.collections[0].id).toBe(status.collectionId);

    const foldersRes = await request(app)
      .get(`/api/collections/${status.collectionId}/folders`)
      .set("Cookie", sessionCookie);
    expect(foldersRes.status).toBe(200);
    const foodFolder = foldersRes.body.folders.find((f: { name: string }) => f.name === "Food");
    expect(foodFolder).toBeDefined();
    expect(foodFolder.categoryType).toBe("ai_generated");
    expect(foodFolder.photoCount).toBe(1);
  }, 15_000);

  it("reuses the same folder row for a second image mapping to the same category", async () => {
    if (skipWorker()) return;

    const secondFood = await sharp(seededNoise(SECOND_FOOD_SEED), {
      raw: { width: NOISE_SIZE, height: NOISE_SIZE, channels: 3 },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    // Sanity: bytes must hit the Food label set (sha256[0] % 7 === 1).
    expect(crypto.createHash("sha256").update(secondFood).digest()[0] % 7).toBe(1);

    const photoId = await uploadBuffer(secondFood, "second-food.jpg");
    const terminal = await waitForTerminal(photoId, 20_000);
    expect(terminal?.status).toBe("done");
    expect(terminal?.folderId).toBe(foodFolderId); // same folder row, no duplicate folder

    const foldersRes = await request(app)
      .get(`/api/collections/${collectionId}/folders`)
      .set("Cookie", sessionCookie);
    const foodFolder = foldersRes.body.folders.find((f: { name: string }) => f.name === "Food");
    expect(foodFolder.photoCount).toBe(2);
  }, 30_000);

  it("buckets unmappable labels into Uncategorized", async () => {
    if (skipWorker()) return;

    const photoId = await uploadBuffer(
      fs.readFileSync(fixture("fixture-unmappable.jpg")),
      "fixture-unmappable.jpg",
    );
    const terminal = await waitForTerminal(photoId, 20_000);
    expect(terminal?.status).toBe("done");
    expect(terminal?.aiLabels).toEqual(["Abstract", "Pattern"]);
    expect(terminal?.folder?.name).toBe("Uncategorized");

    const foldersRes = await request(app)
      .get(`/api/collections/${collectionId}/folders`)
      .set("Cookie", sessionCookie);
    const uncategorized = foldersRes.body.folders.find(
      (f: { name: string }) => f.name === "Uncategorized",
    );
    expect(uncategorized.categoryType).toBe("ai_generated");
  }, 30_000);

  it("FORCE_LOWCONF_ forces confidence below threshold -> Uncategorized despite mappable labels", async () => {
    if (skipWorker()) return;

    // fixture-vehicles bytes (-> ["Car","Truck"], normally the Vehicles
    // folder) renamed: rename does not change bytes/labels, but the worker
    // hook overrides confidence to 0.42 -> threshold beats mapping.
    const photoId = await uploadBuffer(
      fs.readFileSync(fixture("fixture-vehicles.jpg")),
      "FORCE_LOWCONF_vehicles.jpg",
    );
    const terminal = await waitForTerminal(photoId, 20_000);
    expect(terminal?.status).toBe("done");
    expect(terminal?.aiLabels).toEqual(["Car", "Truck"]);
    expect(terminal?.aiConfidence).toBeLessThan(0.6);
    expect(terminal?.folder?.name).toBe("Uncategorized");

    // Reclassify re-resolves deterministically to Uncategorized (the
    // low-conf hook fires on BOTH job types, spec §4 hook scoping).
    const reclassifyRes = await request(app)
      .post(`/api/photos/${photoId}/reclassify`)
      .set("Cookie", sessionCookie);
    expect(reclassifyRes.status).toBe(202);

    const after = await waitForTerminal(photoId, 20_000);
    expect(after?.status).toBe("done");
    expect(after?.folder?.name).toBe("Uncategorized");
    expect(after?.aiConfidence).toBeLessThan(0.6);
    expect(after?.job?.type).toBe("reclassify");
    expect(after?.job?.status).toBe("completed");
  }, 60_000);

  it("flags a byte-identical re-upload as duplicate via the SHA-256 exact pass, with no folder", async () => {
    if (skipWorker()) return;

    const photoId = await uploadBuffer(
      fs.readFileSync(fixture("fixture-food.jpg")),
      "fixture-food-again.jpg",
    );
    const terminal = await waitForTerminal(photoId, 20_000);
    expect(terminal?.status).toBe("duplicate");
    expect(terminal?.dedupMethod).toBe("sha256");
    expect(terminal?.duplicateOfPhotoId).not.toBeNull();
    expect(terminal?.folderId).toBeNull(); // dedup gate short-circuits before folder assignment
    expect(terminal?.aiLabels).toEqual([]); // classifier never ran
    expect(terminal?.aiConfidence).toBeNull();

    // Reclassify is the escape hatch (Open Question 4): clears the verdict
    // and re-resolves to done with a folder.
    const reclassifyRes = await request(app)
      .post(`/api/photos/${photoId}/reclassify`)
      .set("Cookie", sessionCookie);
    expect(reclassifyRes.status).toBe(202);

    const after = await waitForTerminal(photoId, 20_000);
    expect(after?.status).toBe("done");
    expect(after?.folder?.name).toBe("Food");
    expect(after?.duplicateOfPhotoId).toBeNull();
    expect(after?.dedupMethod).toBeNull();
    expect(after?.job?.type).toBe("reclassify");
    expect(after?.job?.status).toBe("completed");
  }, 60_000);

  it("FORCE_FAIL_ fails the pipeline job (3 attempts, error persisted) and reclassify recovers it", async () => {
    if (skipWorker()) return;

    const photoId = await uploadBuffer(
      fs.readFileSync(fixture("fixture-animals.jpg")),
      "FORCE_FAIL_animals.jpg",
    );
    // 3 attempts with exponential backoff (2s base) -> allow generous time.
    const terminal = await waitForTerminal(photoId, 45_000);
    expect(terminal?.status).toBe("failed");
    expect(terminal?.job?.type).toBe("pipeline");
    expect(terminal?.job?.status).toBe("failed");
    expect(terminal?.job?.attempts).toBe(3);
    expect(terminal?.job?.errorMessage).toContain("Forced failure");

    // FORCE_FAIL_ deliberately does NOT fire on reclassify jobs -> recovery.
    const reclassifyRes = await request(app)
      .post(`/api/photos/${photoId}/reclassify`)
      .set("Cookie", sessionCookie);
    expect(reclassifyRes.status).toBe(202);

    const after = await waitForTerminal(photoId, 20_000);
    expect(after?.status).toBe("done");
    expect(after?.folder?.name).toBe("Animals"); // bytes -> ["Dog","Animal"]
    expect(after?.job?.type).toBe("reclassify");
    expect(after?.job?.status).toBe("completed");

    // Bookkeeping isolation (spec §4 re-key): the probe photo's own latest
    // job must be untouched by this photo's reclassify lifecycle.
    const probeStatus = await getStatus(foodPhotoId);
    expect(probeStatus.job?.status).toBe("completed");
  }, 90_000);

  it("returns 409 when reclassify is requested while classification is in progress", async () => {
    if (skipInfra()) return;

    // Deterministic, no timing race: set the state directly.
    await prisma.photo.update({
      where: { id: foodPhotoId },
      data: { aiClassificationStatus: "processing" },
    });
    const res = await request(app)
      .post(`/api/photos/${foodPhotoId}/reclassify`)
      .set("Cookie", sessionCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Classification already in progress");
    await prisma.photo.update({
      where: { id: foodPhotoId },
      data: { aiClassificationStatus: "done" },
    });
  });

  it("multi-category priority: fixture-people lands in People (beats Nature); fixture-nature lands in Nature", async () => {
    if (skipWorker()) return;

    // fixture-people's label set ["Person", "Outdoor"] spans People AND
    // Nature — CATEGORY_PRIORITY must resolve it to People (spec AC).
    const peopleId = await uploadBuffer(
      fs.readFileSync(fixture("fixture-people.jpg")),
      "fixture-people.jpg",
    );
    const natureId = await uploadBuffer(
      fs.readFileSync(fixture("fixture-nature.jpg")),
      "fixture-nature.jpg",
    );

    const peopleTerminal = await waitForTerminal(peopleId, 30_000);
    expect(peopleTerminal?.status).toBe("done");
    expect(peopleTerminal?.aiLabels).toEqual(["Person", "Outdoor"]);
    expect(peopleTerminal?.folder?.name).toBe("People");

    const natureTerminal = await waitForTerminal(natureId, 30_000);
    expect(natureTerminal?.status).toBe("done");
    expect(natureTerminal?.aiLabels).toEqual(["Landscape", "Nature"]);
    expect(natureTerminal?.folder?.name).toBe("Nature");

    naturePhotoId = natureId; // consumed by the parallel-reclassify + exif tests below
  }, 60_000);

  it("creates exactly ONE folder row when two concurrent uploads map to the same brand-new category", async () => {
    if (skipWorker()) return;

    // No earlier test in this file maps anything to Documents, so this is
    // the brand-new-category race the spec's AC describes: two uploads fired
    // near-simultaneously, worker concurrency 2, the @@unique constraint +
    // catch-P2002-and-refetch must yield ONE folder row and zero crashes.
    const secondDocuments = await noiseJpeg(SECOND_DOCUMENTS_SEED);
    expect(crypto.createHash("sha256").update(secondDocuments).digest()[0] % 7).toBe(2);

    const [docsId, secondDocsId] = await Promise.all([
      uploadBuffer(fs.readFileSync(fixture("fixture-documents.jpg")), "fixture-documents.jpg"),
      uploadBuffer(secondDocuments, "second-documents.jpg"),
    ]);

    const docsTerminal = await waitForTerminal(docsId, 30_000);
    const secondDocsTerminal = await waitForTerminal(secondDocsId, 30_000);
    expect(docsTerminal?.status).toBe("done");
    expect(secondDocsTerminal?.status).toBe("done");
    expect(docsTerminal?.folder?.name).toBe("Documents");
    expect(secondDocsTerminal?.folderId).toBe(docsTerminal?.folderId); // one shared row

    const foldersRes = await request(app)
      .get(`/api/collections/${collectionId}/folders`)
      .set("Cookie", sessionCookie);
    const documentsFolders = foldersRes.body.folders.filter(
      (f: { name: string }) => f.name === "Documents",
    );
    expect(documentsFolders).toHaveLength(1); // exactly one row - unique constraint held
    expect(documentsFolders[0].photoCount).toBe(2);
  }, 60_000);

  it("never flags two DIFFERENT flat/solid-color images as duplicates (degenerate pHash guard), but still catches a byte-identical flat re-upload", async () => {
    if (skipWorker()) return;

    // The exact Tester flat-image repro from reports/2026-07-02_0450.md.
    const red = await flatJpeg(220, 30, 30);
    const blue = await flatJpeg(30, 30, 220);
    expect(red.equals(blue)).toBe(false);
    // Both hash to the degenerate all-zeros dHash - without the worker's
    // guard they would pHash-match at distance 0 and false-dedup.
    expect(await computePHash(red)).toBe(DEGENERATE_PHASH);
    expect(await computePHash(blue)).toBe(DEGENERATE_PHASH);

    const redId = await uploadBuffer(red, "flat-red.jpg");
    const redTerminal = await waitForTerminal(redId, 30_000);
    expect(redTerminal?.status).toBe("done");

    const blueId = await uploadBuffer(blue, "flat-blue.jpg");
    const blueTerminal = await waitForTerminal(blueId, 30_000);
    expect(blueTerminal?.status).toBe("done"); // NOT duplicate
    expect(blueTerminal?.duplicateOfPhotoId).toBeNull();

    // Byte-identical flat re-upload DOES dedup - via the SHA-256 exact pass,
    // pointing at the strictly-older original (never at the newer sibling).
    const redAgainId = await uploadBuffer(red, "flat-red-again.jpg");
    const redAgainTerminal = await waitForTerminal(redAgainId, 30_000);
    expect(redAgainTerminal?.status).toBe("duplicate");
    expect(redAgainTerminal?.dedupMethod).toBe("sha256");
    expect(redAgainTerminal?.duplicateOfPhotoId).toBe(redId);
  }, 90_000);

  it("caps parallel reclassify requests at one atomic claim each (no double-enqueue, no photoCount drift)", async () => {
    if (skipWorker()) return;
    expect(naturePhotoId).not.toBeNull();

    const rowsBefore = await prisma.processingJob.count({
      where: { photoId: naturePhotoId!, jobType: "reclassify" },
    });

    // Fire 6 reclassify requests in parallel against a `done` photo. The
    // atomic claim (conditional UPDATE) means each 202 corresponds to
    // exactly one terminal->pending transition and exactly one job row.
    // Deterministic invariants (a later request CAN legitimately win a
    // second claim if the worker fully completed in between, so we assert
    // the correctness property, not a hardcoded count):
    //   1. every response is 202 or 409 - nothing else;
    //   2. at least one claim succeeds;
    //   3. new reclassify job rows === number of 202s (finding #5: job-row
    //      creation is capped at one per claim);
    //   4. the photo settles back to done/Nature with photoCount intact.
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app).post(`/api/photos/${naturePhotoId}/reclassify`).set("Cookie", sessionCookie),
      ),
    );
    const codes = responses.map((r) => r.status);
    for (const code of codes) {
      expect([202, 409]).toContain(code);
    }
    const accepted = codes.filter((c) => c === 202).length;
    expect(accepted).toBeGreaterThanOrEqual(1);

    const rowsAfter = await prisma.processingJob.count({
      where: { photoId: naturePhotoId!, jobType: "reclassify" },
    });
    expect(rowsAfter - rowsBefore).toBe(accepted);

    // Settle: done AND no queued/active job rows left for this photo.
    const deadline = Date.now() + 30_000;
    let settled: StatusBody | null = null;
    while (Date.now() < deadline) {
      const body = await getStatus(naturePhotoId!);
      const unfinished = await prisma.processingJob.count({
        where: { photoId: naturePhotoId!, status: { in: ["queued", "active"] } },
      });
      if (body.status === "done" && unfinished === 0) {
        settled = body;
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    expect(settled).not.toBeNull();
    expect(settled!.folder?.name).toBe("Nature");

    // Reclassifying back into the SAME folder must not change its count -
    // this catches both double-enqueue double-increments and the stale
    // previousFolderId drift (serializable tx fix). Only fixture-nature has
    // landed in Nature at this point in the file.
    const natureFolder = await prisma.folder.findFirst({
      where: { collectionId: collectionId!, name: "Nature" },
    });
    expect(natureFolder?.photoCount).toBe(1);
  }, 60_000);

  it("exposes exif on GET /api/photos/:id - populated for an EXIF-tagged image, all-null for one without", async () => {
    if (skipWorker()) return;
    expect(naturePhotoId).not.toBeNull();

    // Null shape: the seeded-noise fixtures carry no EXIF segment.
    const nullRes = await request(app)
      .get(`/api/photos/${naturePhotoId}`)
      .set("Cookie", sessionCookie);
    expect(nullRes.status).toBe(200);
    expect(nullRes.body.exif).toEqual({
      takenAt: null,
      gpsLat: null,
      gpsLng: null,
      cameraMake: null,
      cameraModel: null,
    });

    // Populated: sharp-written IFD0 Make/Model survives the worker's exifr
    // pass. (Flat gray -> degenerate pHash -> can never near-dup-collide
    // with any other test image; unique bytes -> no sha256 match either.)
    const exifTagged = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .jpeg({ quality: 90 })
      .withExif({ IFD0: { Make: "PhotoSphereTest", Model: "SmokeCam 3000" } })
      .toBuffer();

    const photoId = await uploadBuffer(exifTagged, "exif-tagged.jpg");
    const terminal = await waitForTerminal(photoId, 30_000);
    expect(terminal?.status).toBe("done");

    const res = await request(app).get(`/api/photos/${photoId}`).set("Cookie", sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.exif.cameraMake).toBe("PhotoSphereTest");
    expect(res.body.exif.cameraModel).toBe("SmokeCam 3000");
    expect(res.body.exif.takenAt).toBeNull(); // only Make/Model were written
    expect(res.body.exif.gpsLat).toBeNull();
    expect(res.body.exif.gpsLng).toBeNull();
  }, 60_000);
});

describe("collections/folders/move API", () => {
  it("creates a custom folder (201), rejects duplicates (409) and invalid names (400)", async () => {
    if (skipWorker()) return; // collectionId comes from the probe upload

    const createRes = await request(app)
      .post(`/api/collections/${collectionId}/folders`)
      .set("Cookie", sessionCookie)
      .send({ name: "Vacation 2026" });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe("Vacation 2026");
    expect(createRes.body.categoryType).toBe("custom");
    expect(createRes.body.photoCount).toBe(0);

    const dupRes = await request(app)
      .post(`/api/collections/${collectionId}/folders`)
      .set("Cookie", sessionCookie)
      .send({ name: "Vacation 2026" });
    expect(dupRes.status).toBe(409);

    const emptyRes = await request(app)
      .post(`/api/collections/${collectionId}/folders`)
      .set("Cookie", sessionCookie)
      .send({ name: "   " });
    expect(emptyRes.status).toBe(400);

    const overlongRes = await request(app)
      .post(`/api/collections/${collectionId}/folders`)
      .set("Cookie", sessionCookie)
      .send({ name: "x".repeat(256) });
    expect(overlongRes.status).toBe(400);
  });

  it("moves a photo between folders, reconciling both photoCounts, without touching classification fields", async () => {
    if (skipWorker()) return;

    const target = await prisma.folder.findFirst({
      where: { collectionId: collectionId!, name: "Vacation 2026" },
    });
    expect(target).not.toBeNull();

    const before = await getStatus(foodPhotoId);
    const foodCountBefore = (await prisma.folder.findUnique({ where: { id: foodFolderId! } }))!
      .photoCount;

    const moveRes = await request(app)
      .patch(`/api/photos/${foodPhotoId}`)
      .set("Cookie", sessionCookie)
      .send({ folderId: target!.id });
    expect(moveRes.status).toBe(200);
    expect(moveRes.body.folderId).toBe(target!.id);
    expect(moveRes.body.folderName).toBe("Vacation 2026");

    const after = await getStatus(foodPhotoId);
    expect(after.folderId).toBe(target!.id);
    // A manual move is organizational, not a re-classification.
    expect(after.status).toBe(before.status);
    expect(after.aiLabels).toEqual(before.aiLabels);
    expect(after.aiConfidence).toBe(before.aiConfidence);

    const foodCountAfter = (await prisma.folder.findUnique({ where: { id: foodFolderId! } }))!
      .photoCount;
    const targetCountAfter = (await prisma.folder.findUnique({ where: { id: target!.id } }))!
      .photoCount;
    expect(foodCountAfter).toBe(foodCountBefore - 1);
    expect(targetCountAfter).toBe(1);
  });

  it("rejects a malformed move body (missing/non-uuid folderId) with 400", async () => {
    if (skipInfra()) return;

    const missing = await request(app)
      .patch(`/api/photos/${foodPhotoId}`)
      .set("Cookie", sessionCookie)
      .send({});
    expect(missing.status).toBe(400);

    const nonUuid = await request(app)
      .patch(`/api/photos/${foodPhotoId}`)
      .set("Cookie", sessionCookie)
      .send({ folderId: "not-a-uuid" });
    expect(nonUuid.status).toBe(400);
  });

  it("paginates folder photos with validated limit/offset and pre-signed thumbnail URLs", async () => {
    if (skipWorker()) return;

    const page = await request(app)
      .get(`/api/folders/${foodFolderId}/photos?limit=1&offset=0`)
      .set("Cookie", sessionCookie);
    expect(page.status).toBe(200);
    expect(page.body.photos).toHaveLength(1);
    expect(page.body.total).toBeGreaterThanOrEqual(1);
    expect(page.body.limit).toBe(1);
    expect(page.body.offset).toBe(0);
    // Pre-signed URL, never a raw storage key.
    expect(page.body.photos[0].thumbnailUrl).toContain("X-Amz-Signature");

    const overMax = await request(app)
      .get(`/api/folders/${foodFolderId}/photos?limit=101`)
      .set("Cookie", sessionCookie);
    expect(overMax.status).toBe(400);

    const negative = await request(app)
      .get(`/api/folders/${foodFolderId}/photos?offset=-1`)
      .set("Cookie", sessionCookie);
    expect(negative.status).toBe(400);

    const nonNumeric = await request(app)
      .get(`/api/folders/${foodFolderId}/photos?limit=abc`)
      .set("Cookie", sessionCookie);
    expect(nonNumeric.status).toBe(400);
  });

  it("returns 401 on every new endpoint without a session", async () => {
    const someId = "00000000-0000-0000-0000-000000000000";
    const checks = [
      request(app).get("/api/collections"),
      request(app).get(`/api/collections/${someId}/folders`),
      request(app).post(`/api/collections/${someId}/folders`).send({ name: "X" }),
      request(app).get(`/api/folders/${someId}/photos`),
      request(app).patch(`/api/photos/${someId}`).send({ folderId: someId }),
      request(app).post(`/api/photos/${someId}/reclassify`),
    ];
    for (const check of checks) {
      const res = await check;
      expect(res.status).toBe(401);
    }
  });

  it("returns 404 (never 403) on every id-taking endpoint against another user's resource", async () => {
    if (skipWorker()) return;

    // Give the other user their own collection + folder so we can also test
    // "own photo -> foreign target folder".
    const otherCollection = await prisma.collection.create({
      data: { ownerId: otherUserId, name: "My Photos", isDefault: true },
    });
    const otherFolder = await prisma.folder.create({
      data: { collectionId: otherCollection.id, name: "Theirs", categoryType: "custom" },
    });

    // Other user probing this user's resources:
    const asOther = [
      request(app).get(`/api/collections/${collectionId}/folders`).set("Cookie", otherCookie),
      request(app)
        .post(`/api/collections/${collectionId}/folders`)
        .set("Cookie", otherCookie)
        .send({ name: "Sneaky" }),
      request(app).get(`/api/folders/${foodFolderId}/photos`).set("Cookie", otherCookie),
      request(app)
        .patch(`/api/photos/${foodPhotoId}`)
        .set("Cookie", otherCookie)
        .send({ folderId: otherFolder.id }),
      request(app).post(`/api/photos/${foodPhotoId}/reclassify`).set("Cookie", otherCookie),
    ];
    for (const check of asOther) {
      const res = await check;
      expect(res.status).toBe(404);
    }

    // Own photo, but targeting another user's folder -> 404, never confirm
    // the foreign folder exists.
    const crossTarget = await request(app)
      .patch(`/api/photos/${foodPhotoId}`)
      .set("Cookie", sessionCookie)
      .send({ folderId: otherFolder.id });
    expect(crossTarget.status).toBe(404);
  });
});

describe("reclassify rate-limiter isolation (spec AC: own bucket, never shared)", () => {
  it("is a distinct limiter instance from the upload limiter (structural)", () => {
    // express-rate-limit builds one MemoryStore per rateLimit() call, so
    // distinct middleware instances == distinct buckets. The auth limiters
    // (signupRateLimiter/loginRateLimiter) are module-private in
    // routes/auth.ts, separately-constructed and IP-keyed (vs user-keyed
    // here) - their independence is proven behaviorally below and in the
    // auth-split test, since NODE_ENV=test disarms their limits (1000/15min)
    // and makes bucket exhaustion impractical from this suite.
    expect(reclassifyRateLimiter).not.toBe(uploadRateLimiter);
    expect(typeof reclassifyRateLimiter).toBe("function");
    expect(typeof uploadRateLimiter).toBe("function");
  });

  it("exhausting the reclassify bucket does not throttle uploads or auth calls", async () => {
    if (skipInfra()) return;

    // Fresh user = fresh per-user buckets; nothing here can 429 the main
    // test user's remaining reclassify/upload budget.
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: limiterEmail, password: testPassword, name: "Limiter Probe" });
    expect(signup.status).toBe(201);
    const cookie = signup.headers["set-cookie"][0];

    // The reclassify limiter is deliberately NOT relaxed under NODE_ENV=test
    // (30/15min/user) - burn the whole bucket with cheap 404s (the limiter
    // runs before the handler and counts every response).
    const missingId = "00000000-0000-0000-0000-000000000000";
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post(`/api/photos/${missingId}/reclassify`)
        .set("Cookie", cookie);
      expect(res.status).toBe(404);
    }
    const exhausted = await request(app)
      .post(`/api/photos/${missingId}/reclassify`)
      .set("Cookie", cookie);
    expect(exhausted.status).toBe(429);

    // Upload bucket (same user) is unaffected by the exhausted reclassify bucket.
    const uploadRes = await request(app)
      .post("/api/photos/upload")
      .set("Cookie", cookie)
      .attach("file", fs.readFileSync(fixture("fixture-food.jpg")), {
        filename: "fixture-food.jpg",
        contentType: "image/jpeg",
      });
    expect(uploadRes.status).toBe(202);

    // Auth bucket is unaffected too.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: limiterEmail, password: testPassword });
    expect(login.status).toBe(200);

    // Let the worker finish this user's upload before afterAll cascades the
    // user away (avoids a mid-flight job racing test cleanup).
    if (workerAvailable) {
      await waitForTerminal(uploadRes.body.photoId as string, 30_000, cookie);
    }
  }, 60_000);
});

describe("auth rate-limit split (carry-over a)", () => {
  it("does not 429 repeated logins under NODE_ENV=test (buckets relaxed, suite re-runnable back-to-back)", async () => {
    if (skipInfra()) return;

    // 8 wrong-password logins: under the old shared 5/15min bucket this
    // would 429 partway through; under the split+test-relaxed limiters every
    // attempt must reach the handler (generic 401).
    for (let i = 0; i < 8; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: testEmail, password: "wrong-password-xyz" });
      expect(res.status).toBe(401);
    }
  });
});
