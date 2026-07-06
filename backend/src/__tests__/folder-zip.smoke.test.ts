import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { ensureBucketExists, putObject } from "../lib/storage";
import { originalKey } from "../lib/storageKeys";

// Integration tests for specs/folder-mgmt-download-search.md PART P5 (bulk
// "download all" / folder zip — backend). Follows the skip-not-fake convention
// of folder-mgmt.smoke.test.ts: DB/MinIO-dependent tests skip with a warning
// when infra is unreachable. Photos are seeded directly via Prisma AND their
// originals written into MinIO via putObject so the zip is assembled from REAL
// authorized reads — no worker needed.
//
// The response is fetched as a raw binary buffer (.buffer(true)) and validated
// at the ZIP-format level WITHOUT a third-party unzip dep: a valid zip starts
// with the local-file-header magic (PK\x03\x04), ends with the end-of-central-
// directory magic (PK\x05\x06), and carries one central-directory file header
// (PK\x01\x02) per entry, each followed by the entry's UTF-8 filename bytes.
// This proves (a) it's a real zip, (b) it has exactly the expected entry count,
// (c) entry names are the photos' ORIGINAL FILENAMES — never s3Keys — and
// (d) no raw s3Key / pre-signed URL appears anywhere in the bytes.
//
// Covers the P5 acceptance criteria: owner zip 200 application/zip + attachment
// Content-Disposition + valid zip of exactly the downloadable photos; NO raw
// key/URL in the body; cross-owner 404; empty/no-downloadable 400; skip
// failed/duplicate/pending (Z4); same-filename de-dup → two distinct entries;
// >500 cap → 409 (Z3); guest download_all → 200, download-only → 403, view-only
// → 403, unpermitted → 404, no session → 401; guest success writes ONE
// folder_downloaded audit row, a 403/404 writes NONE (Z7).

const app = createApp();
const CDIR_MAGIC = Buffer.from([0x50, 0x4b, 0x01, 0x02]); // PK\x01\x02 per entry
const LOCAL_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04 zip start
const EOCD_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // PK\x05\x06 zip end

const stamp = Date.now();
const ownerEmail = `zip-owner-${stamp}@example.com`;
const otherEmail = `zip-other-${stamp}@example.com`;
const password = "correct-password-123";

let infraAvailable = true;
let ownerCookie: string;
let ownerId: string;
let otherCookie: string;
let otherId: string;
let collectionId: string;
let otherCollectionId: string;

function skipInfra(): boolean {
  if (!infraAvailable) {
    console.warn("Skipping: Postgres/MinIO not reachable. Run `docker compose up -d` first.");
    return true;
  }
  return false;
}

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

// Seed a photo row AND write a real original object into MinIO so the zip
// assembly reads genuine bytes. `store: false` skips the MinIO write (for
// pending/failed rows whose originals never landed) so a real read failure is
// never triggered for included photos.
async function seedPhoto(opts: {
  ownerId: string;
  collectionId: string;
  folderId: string;
  originalFilename: string;
  status?: string;
  store?: boolean;
  bytes?: Buffer;
}): Promise<string> {
  const id = crypto.randomUUID();
  const key = originalKey(opts.ownerId, id, "jpg");
  const store = opts.store ?? true;
  if (store) {
    await putObject(key, opts.bytes ?? Buffer.from(`img-${id}`), "image/jpeg");
  }
  await prisma.photo.create({
    data: {
      id,
      ownerId: opts.ownerId,
      s3Key: store ? key : "",
      originalFilename: opts.originalFilename,
      mimeType: "image/jpeg",
      sizeBytes: 100,
      aiClassificationStatus: opts.status ?? "done",
      collectionId: opts.collectionId,
      folderId: opts.folderId,
    },
  });
  return id;
}

async function seedFolder(opts: {
  collectionId: string;
  name: string;
}): Promise<string> {
  const f = await prisma.folder.create({
    data: { collectionId: opts.collectionId, name: opts.name, categoryType: "custom", photoCount: 0 },
  });
  return f.id;
}

async function seedGuestWithPermission(
  folderId: string,
  grantedBy: string,
  level: string,
): Promise<{ guestId: string; cookie: string }> {
  const guest = await prisma.guestUser.create({
    data: { email: `zipguest-${crypto.randomUUID()}@example.com`, createdBy: grantedBy },
  });
  await prisma.folderPermission.create({
    data: { guestUserId: guest.id, folderId, permissionLevel: level, grantedBy },
  });
  // Mint a guest session directly (opaque token) — same shape requireGuest reads.
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  await prisma.guestSession.create({
    data: {
      guestUserId: guest.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { guestId: guest.id, cookie: `photosphere_guest_session=${rawToken}` };
}

beforeAll(async () => {
  try {
    await prisma.$connect();
    await ensureBucketExists();
  } catch {
    infraAvailable = false;
    return;
  }

  const ownerSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "Zip Owner" });
  ownerCookie = ownerSignup.headers["set-cookie"][0];
  ownerId = ownerSignup.body.user.id;

  const otherSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherEmail, password, name: "Zip Other" });
  otherCookie = otherSignup.headers["set-cookie"][0];
  otherId = otherSignup.body.user.id;

  const c = await prisma.collection.create({
    data: { ownerId, name: "My Photos", isDefault: true },
  });
  collectionId = c.id;
  const oc = await prisma.collection.create({
    data: { ownerId: otherId, name: "My Photos", isDefault: true },
  });
  otherCollectionId = oc.id;
}, 30_000);

afterAll(async () => {
  if (infraAvailable) {
    await prisma.user.deleteMany({ where: { email: { in: [ownerEmail, otherEmail] } } });
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// Owner — GET /api/folders/:id/download-all
// ---------------------------------------------------------------------------
describe("GET /api/folders/:id/download-all — owner", () => {
  it("401 without a session", async () => {
    const res = await request(app).get(`/api/folders/${crypto.randomUUID()}/download-all`);
    expect(res.status).toBe(401);
  });

  it("200 application/zip attachment; valid zip of exactly the downloadable photos; NO raw key/URL", async () => {
    if (skipInfra()) return;
    const folderId = await seedFolder({ collectionId, name: `zip-ok-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "beach.jpg" });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "sunset.jpg" });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "hiking.jpg" });

    const res = await request(app)
      .get(`/api/folders/${folderId}/download-all`)
      .set("Cookie", ownerCookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(`zip-ok-${stamp}.zip`);

    const body = res.body as Buffer;
    // Valid zip envelope.
    expect(body.subarray(0, 4).equals(LOCAL_MAGIC)).toBe(true);
    expect(countOccurrences(body, EOCD_MAGIC)).toBeGreaterThanOrEqual(1);
    // Exactly three central-directory entries (one per downloadable photo).
    expect(countOccurrences(body, CDIR_MAGIC)).toBe(3);
    // Entry names are the ORIGINAL FILENAMES, present as plain bytes.
    const text = body.toString("latin1");
    expect(text).toContain("beach.jpg");
    expect(text).toContain("sunset.jpg");
    expect(text).toContain("hiking.jpg");
    // NO raw s3Key (owner/photoId/original.jpg) and NO pre-signed URL leak.
    expect(text).not.toContain(`${ownerId}/`);
    expect(text).not.toContain("original.jpg");
    expect(text).not.toContain("X-Amz-Signature");
    expect(text).not.toContain("http://");
  });

  it("Z4: skips failed / duplicate / pending / processing; only `done` stored originals are zipped", async () => {
    if (skipInfra()) return;
    const folderId = await seedFolder({ collectionId, name: `zip-z4-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "keep.jpg", status: "done" });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "dup.jpg", status: "duplicate" });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "fail.jpg", status: "failed", store: false });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "pend.jpg", status: "pending", store: false });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "proc.jpg", status: "processing", store: false });

    const res = await request(app)
      .get(`/api/folders/${folderId}/download-all`)
      .set("Cookie", ownerCookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(countOccurrences(body, CDIR_MAGIC)).toBe(1);
    const text = body.toString("latin1");
    expect(text).toContain("keep.jpg");
    expect(text).not.toContain("dup.jpg");
    expect(text).not.toContain("fail.jpg");
    expect(text).not.toContain("pend.jpg");
    expect(text).not.toContain("proc.jpg");
  });

  it("two photos with the same original filename → two distinct de-duped entries", async () => {
    if (skipInfra()) return;
    const folderId = await seedFolder({ collectionId, name: `zip-dedup-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "IMG_0001.jpg" });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "IMG_0001.jpg" });

    const res = await request(app)
      .get(`/api/folders/${folderId}/download-all`)
      .set("Cookie", ownerCookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    // Two distinct entries — the archive is valid (not one clobbered entry).
    expect(countOccurrences(body, CDIR_MAGIC)).toBe(2);
    const text = body.toString("latin1");
    expect(text).toContain("IMG_0001.jpg");
    expect(text).toContain("IMG_0001 (2).jpg");
  });

  it("400 on an empty / no-downloadable folder (Z6), before streaming", async () => {
    if (skipInfra()) return;
    const folderId = await seedFolder({ collectionId, name: `zip-empty-${stamp}` });
    // Only a failed photo (no downloadable original).
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "x.jpg", status: "failed", store: false });

    const res = await request(app)
      .get(`/api/folders/${folderId}/download-all`)
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("404 on a folder owned by a different owner", async () => {
    if (skipInfra()) return;
    const folderId = await seedFolder({ collectionId, name: `zip-xowner-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "secret.jpg" });
    const res = await request(app)
      .get(`/api/folders/${folderId}/download-all`)
      .set("Cookie", otherCookie);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Z3 — the >500 cap (unit-testable via the shared pre-flight, no 501 uploads)
// ---------------------------------------------------------------------------
describe("Z3 cap — >500 downloadable photos → 409", () => {
  it("preflightFolderDownload returns 409 over the cap and ok under it", async () => {
    // Pure logic against the shared helper's cap constant — no streaming, no
    // 501 real uploads. We seed lightweight `done` rows with a stored key set
    // to a sentinel (never read — pre-flight only counts).
    if (skipInfra()) return;
    const { DOWNLOAD_ALL_MAX_PHOTOS, preflightFolderDownload } = await import("../lib/folderDownload");
    const folderId = await seedFolder({ collectionId, name: `zip-cap-${stamp}` });

    // Seed cap+1 rows in bulk (createMany) with non-empty keys; they're only
    // COUNTED by the pre-flight, never read, so no MinIO objects needed.
    const rows = Array.from({ length: DOWNLOAD_ALL_MAX_PHOTOS + 1 }, () => ({
      id: crypto.randomUUID(),
      ownerId,
      s3Key: `cap/${crypto.randomUUID()}.jpg`,
      originalFilename: "cap.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1,
      aiClassificationStatus: "done",
      collectionId,
      folderId,
    }));
    await prisma.photo.createMany({ data: rows });

    const over = await preflightFolderDownload(folderId);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(409);

    // The HTTP endpoint returns 409 too (pre-flight rejects before streaming).
    const res = await request(app)
      .get(`/api/folders/${folderId}/download-all`)
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(409);

    // Delete exactly one row → count == cap (500), which is NOT over → ok
    // (the cap is `> MAX`, so exactly MAX passes). Proves the boundary + that
    // the count is what gates.
    await prisma.photo.deleteMany({ where: { id: rows[0].id } });
    const atCap = await preflightFolderDownload(folderId);
    expect(atCap.ok).toBe(true); // now DOWNLOAD_ALL_MAX_PHOTOS rows — at the cap, allowed
  });
});

// ---------------------------------------------------------------------------
// Guest — GET /api/guest/folders/:id/download-all
// ---------------------------------------------------------------------------
describe("GET /api/guest/folders/:id/download-all — guest (Z1 + Z7)", () => {
  it("401 with no guest session", async () => {
    const res = await request(app).get(`/api/guest/folders/${crypto.randomUUID()}/download-all`);
    expect(res.status).toBe(401);
  });

  it("404 for a folder not in the guest's permitted set (no row written)", async () => {
    if (skipInfra()) return;
    // A guest permitted on a DIFFERENT folder tries an unpermitted one.
    const permitted = await seedFolder({ collectionId, name: `zip-g-perm-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId: permitted, originalFilename: "ok.jpg" });
    const { cookie, guestId } = await seedGuestWithPermission(permitted, ownerId, "download_all");

    const unpermitted = await seedFolder({ collectionId, name: `zip-g-unperm-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId: unpermitted, originalFilename: "secret.jpg" });

    const res = await request(app)
      .get(`/api/guest/folders/${unpermitted}/download-all`)
      .set("Cookie", cookie);
    expect(res.status).toBe(404);
    const rows = await prisma.auditLog.count({
      where: { actorId: guestId, action: "folder_downloaded" },
    });
    expect(rows).toBe(0);
  });

  it("403 for a `download`-only guest and a `view`-only guest (no row written)", async () => {
    if (skipInfra()) return;
    const folderDl = await seedFolder({ collectionId, name: `zip-g-dlonly-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId: folderDl, originalFilename: "a.jpg" });
    const dl = await seedGuestWithPermission(folderDl, ownerId, "download");

    const resDl = await request(app)
      .get(`/api/guest/folders/${folderDl}/download-all`)
      .set("Cookie", dl.cookie);
    expect(resDl.status).toBe(403);

    const folderView = await seedFolder({ collectionId, name: `zip-g-viewonly-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId: folderView, originalFilename: "b.jpg" });
    const view = await seedGuestWithPermission(folderView, ownerId, "view");

    const resView = await request(app)
      .get(`/api/guest/folders/${folderView}/download-all`)
      .set("Cookie", view.cookie);
    expect(resView.status).toBe(403);

    // Neither refusal wrote a folder_downloaded row.
    const rows = await prisma.auditLog.count({
      where: { actorId: { in: [dl.guestId, view.guestId] }, action: "folder_downloaded" },
    });
    expect(rows).toBe(0);
  });

  it("200 zip for a `download_all` guest AND exactly ONE folder_downloaded audit row", async () => {
    if (skipInfra()) return;
    const folderId = await seedFolder({ collectionId, name: `zip-g-ok-${stamp}` });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "shared1.jpg" });
    await seedPhoto({ ownerId, collectionId, folderId, originalFilename: "shared2.jpg" });
    const { cookie, guestId } = await seedGuestWithPermission(folderId, ownerId, "download_all");

    const res = await request(app)
      .get(`/api/guest/folders/${folderId}/download-all`)
      .set("Cookie", cookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    const body = res.body as Buffer;
    expect(countOccurrences(body, CDIR_MAGIC)).toBe(2);
    const text = body.toString("latin1");
    expect(text).toContain("shared1.jpg");
    expect(text).toContain("shared2.jpg");
    expect(text).not.toContain(`${ownerId}/`);

    // Z7: exactly ONE folder_downloaded row, owner = folder's owner, actor guest.
    // Poll briefly since logAudit is fire-and-forget (post-response insert).
    let rows: Awaited<ReturnType<typeof prisma.auditLog.findMany>> = [];
    for (let i = 0; i < 20; i++) {
      rows = await prisma.auditLog.findMany({
        where: { actorId: guestId, action: "folder_downloaded", resourceId: folderId },
      });
      if (rows.length >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows.length).toBe(1);
    expect(rows[0].actorType).toBe("guest");
    expect(rows[0].ownerId).toBe(ownerId);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(meta.folderId).toBe(folderId);
    expect(meta.folderName).toBe(`zip-g-ok-${stamp}`);
    expect(meta.photoCount).toBe(2);
  });
});
