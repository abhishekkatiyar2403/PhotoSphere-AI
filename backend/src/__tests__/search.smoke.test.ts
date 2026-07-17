import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";

// Integration tests for specs/folder-mgmt-download-search.md PART P6 (basic
// search — backend). Same skip-not-fake + direct-Prisma-seed convention as
// folder-mgmt.smoke.test.ts (no worker needed — the search surface is a pure
// owner-scoped query, deterministic when photos/folders are seeded directly).
//
// Covers the P6 acceptance criteria: ?q= case-insensitive substring; ?from/?to
// range on createdAt + invalid-date/from>to 400; ?folderId owned/not-owned(404)/
// unfiled; ?category folder-name match + unknown→400; combined AND; limit>100
// and garbage limit/offset → 400; empty query → whole library newest-first (S6);
// 401 no session; and — the core risk — LEAK-PROOF two-owner scoping with
// overlapping filenames (each ?q= returns ONLY their own, both directions).

const app = createApp();

const stamp = Date.now();
const aEmail = `search-a-${stamp}@example.com`;
const bEmail = `search-b-${stamp}@example.com`;
const password = "correct-password-123";

let infraAvailable = true;
let aCookie: string;
let aId: string;
let aCollectionId: string;
let bCookie: string;
let bId: string;
let bCollectionId: string;

function skipInfra(): boolean {
  if (!infraAvailable) {
    console.warn("Skipping: Postgres not reachable. Run `docker compose up -d` first.");
    return true;
  }
  return false;
}

// Seed a folder and return its id.
async function seedFolder(collectionId: string, name: string, categoryType = "custom"): Promise<string> {
  const f = await prisma.folder.create({ data: { collectionId, name, categoryType } });
  return f.id;
}

// Seed a single photo. `createdAt` is settable so the date-range tests are
// deterministic; folderId optional (null = unfiled).
async function seedPhoto(opts: {
  ownerId: string;
  collectionId: string;
  filename: string;
  folderId?: string | null;
  createdAt?: Date;
  status?: string;
}): Promise<string> {
  const p = await prisma.photo.create({
    data: {
      ownerId: opts.ownerId,
      s3Key: `seed/${opts.ownerId}/${crypto.randomUUID()}.jpg`,
      originalFilename: opts.filename,
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      aiClassificationStatus: opts.status ?? "done",
      collectionId: opts.collectionId,
      folderId: opts.folderId ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return p.id;
}

function search(cookie: string, qs: string) {
  return request(app).get(`/api/search${qs}`).set("Cookie", cookie);
}

beforeAll(async () => {
  try {
    await prisma.$connect();
  } catch {
    infraAvailable = false;
    return;
  }

  const aSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: aEmail, password, name: "Owner A" });
  aCookie = aSignup.headers["set-cookie"][0];
  aId = aSignup.body.user.id;

  const bSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: bEmail, password, name: "Owner B" });
  bCookie = bSignup.headers["set-cookie"][0];
  bId = bSignup.body.user.id;

  const ac = await prisma.collection.create({ data: { ownerId: aId, name: "My Photos", isDefault: true } });
  aCollectionId = ac.id;
  const bc = await prisma.collection.create({ data: { ownerId: bId, name: "My Photos", isDefault: true } });
  bCollectionId = bc.id;
}, 30_000);

afterAll(async () => {
  if (infraAvailable) {
    await prisma.user.deleteMany({ where: { email: { in: [aEmail, bEmail] } } });
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
describe("GET /api/search — auth", () => {
  it("401 without a session", async () => {
    const res = await request(app).get("/api/search");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// q — filename substring, case-insensitive (ILIKE)
// ---------------------------------------------------------------------------
describe("GET /api/search?q= — filename substring (case-insensitive)", () => {
  it("returns only the owner's matching photos, each with a pre-signed thumb URL, never a raw key", async () => {
    if (skipInfra()) return;
    const unique = `qsub${stamp}`;
    // Two matches (different case), one non-match — all owned by A.
    const m1 = await seedPhoto({ ownerId: aId, collectionId: aCollectionId, filename: `sunset-${unique}.jpg` });
    const m2 = await seedPhoto({ ownerId: aId, collectionId: aCollectionId, filename: `SUNSET-${unique}-2.jpg` });
    const nonMatch = await seedPhoto({ ownerId: aId, collectionId: aCollectionId, filename: `mountain-${stamp}.jpg` });

    // Match on the uppercase-in-DB name using a lowercase query → ILIKE.
    const res = await search(aCookie, `?q=sunset-${unique}`);
    expect(res.status).toBe(200);
    const ids = res.body.photos.map((p: { id: string }) => p.id);
    expect(ids).toContain(m1);
    expect(ids).toContain(m2);
    expect(ids).not.toContain(nonMatch);

    // Response shape + no raw key leak.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("s3Key");
    for (const card of res.body.photos) {
      // thumbnailUrl is null (no thumbnail seeded) OR a pre-signed URL — never
      // a bare storage key. Seeded photos have no s3ThumbnailKey → null.
      expect(card).toHaveProperty("thumbnailUrl");
      expect(card).not.toHaveProperty("s3Key");
      expect(card).not.toHaveProperty("s3ThumbnailKey");
    }
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("offset");
  });

  it("an empty/whitespace q is treated as absent (does not filter to nothing)", async () => {
    if (skipInfra()) return;
    await seedPhoto({ ownerId: aId, collectionId: aCollectionId, filename: `blankq-${stamp}.jpg` });
    const res = await search(aCookie, "?q=%20%20"); // "  "
    expect(res.status).toBe(200);
    // Whole-library browse (S6) — at least the photos we've seeded for A.
    expect(res.body.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Date range on createdAt (S2)
// ---------------------------------------------------------------------------
describe("GET /api/search — date range (createdAt, S2)", () => {
  const dEmail = `search-date-${stamp}@example.com`;
  let dCookie: string;
  let dId: string;
  let dCollectionId: string;

  beforeAll(async () => {
    if (!infraAvailable) return;
    const s = await request(app).post("/api/auth/signup").send({ email: dEmail, password, name: "Date Owner" });
    dCookie = s.headers["set-cookie"][0];
    dId = s.body.user.id;
    const c = await prisma.collection.create({ data: { ownerId: dId, name: "My Photos", isDefault: true } });
    dCollectionId = c.id;
    // Three photos at distinct upload dates.
    await seedPhoto({ ownerId: dId, collectionId: dCollectionId, filename: "old.jpg", createdAt: new Date("2024-01-01T00:00:00Z") });
    await seedPhoto({ ownerId: dId, collectionId: dCollectionId, filename: "mid.jpg", createdAt: new Date("2024-06-15T00:00:00Z") });
    await seedPhoto({ ownerId: dId, collectionId: dCollectionId, filename: "new.jpg", createdAt: new Date("2024-12-31T00:00:00Z") });
  }, 30_000);

  afterAll(async () => {
    if (infraAvailable) await prisma.user.deleteMany({ where: { email: dEmail } });
  });

  it("?from/?to bound results to the range (inclusive)", async () => {
    if (skipInfra()) return;
    const res = await search(dCookie, "?from=2024-05-01&to=2024-07-01");
    expect(res.status).toBe(200);
    const names = res.body.photos.map((p: { originalFilename: string }) => p.originalFilename);
    expect(names).toContain("mid.jpg");
    expect(names).not.toContain("old.jpg");
    expect(names).not.toContain("new.jpg");
    expect(res.body.total).toBe(1);
  });

  it("?from only bounds the lower edge", async () => {
    if (skipInfra()) return;
    const res = await search(dCookie, "?from=2024-06-01");
    expect(res.status).toBe(200);
    const names = res.body.photos.map((p: { originalFilename: string }) => p.originalFilename);
    expect(names).toContain("mid.jpg");
    expect(names).toContain("new.jpg");
    expect(names).not.toContain("old.jpg");
  });

  it("400 on an invalid date", async () => {
    if (skipInfra()) return;
    const res = await search(dCookie, "?from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("400 when from > to", async () => {
    if (skipInfra()) return;
    const res = await search(dCookie, "?from=2024-12-01&to=2024-01-01");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// folderId (S3): owned / not-owned(404) / unfiled
// ---------------------------------------------------------------------------
describe("GET /api/search?folderId= (S3)", () => {
  it("restricts to an owned folder", async () => {
    if (skipInfra()) return;
    const folderId = await seedFolder(aCollectionId, `fld-${stamp}`);
    const inFolder = await seedPhoto({ ownerId: aId, collectionId: aCollectionId, filename: `inf-${stamp}.jpg`, folderId });
    const outFolder = await seedPhoto({ ownerId: aId, collectionId: aCollectionId, filename: `outf-${stamp}.jpg`, folderId: null });

    const res = await search(aCookie, `?folderId=${folderId}`);
    expect(res.status).toBe(200);
    const ids = res.body.photos.map((p: { id: string }) => p.id);
    expect(ids).toContain(inFolder);
    expect(ids).not.toContain(outFolder);
  });

  it("404 for a folder owned by a different owner", async () => {
    if (skipInfra()) return;
    const bFolder = await seedFolder(bCollectionId, `bfld-${stamp}`);
    const res = await search(aCookie, `?folderId=${bFolder}`);
    expect(res.status).toBe(404);
  });

  it("404 for a non-existent folder", async () => {
    if (skipInfra()) return;
    const res = await search(aCookie, `?folderId=${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("folderId=unfiled returns folderId-null photos only", async () => {
    if (skipInfra()) return;
    const uEmail = `search-unfiled-${stamp}@example.com`;
    const s = await request(app).post("/api/auth/signup").send({ email: uEmail, password, name: "Unfiled" });
    const uCookie = s.headers["set-cookie"][0];
    const uId = s.body.user.id;
    const uc = await prisma.collection.create({ data: { ownerId: uId, name: "My Photos", isDefault: true } });
    const uFolder = await seedFolder(uc.id, `u-fld-${stamp}`);
    const unfiled = await seedPhoto({ ownerId: uId, collectionId: uc.id, filename: "u-unfiled.jpg", folderId: null });
    const filed = await seedPhoto({ ownerId: uId, collectionId: uc.id, filename: "u-filed.jpg", folderId: uFolder });

    const res = await search(uCookie, "?folderId=unfiled");
    expect(res.status).toBe(200);
    const ids = res.body.photos.map((p: { id: string }) => p.id);
    expect(ids).toContain(unfiled);
    expect(ids).not.toContain(filed);

    await prisma.user.deleteMany({ where: { email: uEmail } });
  });
});

// ---------------------------------------------------------------------------
// category (S1) = folder-name match, owner-scoped
// ---------------------------------------------------------------------------
describe("GET /api/search?category= (S1, folder-name match)", () => {
  const cEmail = `search-cat-${stamp}@example.com`;
  let cCookie: string;
  let cId: string;
  let cCollectionId: string;
  let natureId: string;
  let foodId: string;

  beforeAll(async () => {
    if (!infraAvailable) return;
    const s = await request(app).post("/api/auth/signup").send({ email: cEmail, password, name: "Cat Owner" });
    cCookie = s.headers["set-cookie"][0];
    cId = s.body.user.id;
    const c = await prisma.collection.create({ data: { ownerId: cId, name: "My Photos", isDefault: true } });
    cCollectionId = c.id;
    natureId = await seedFolder(cCollectionId, "Nature", "ai_generated");
    foodId = await seedFolder(cCollectionId, "Food", "ai_generated");
    await seedPhoto({ ownerId: cId, collectionId: cCollectionId, filename: "leaf.jpg", folderId: natureId });
    await seedPhoto({ ownerId: cId, collectionId: cCollectionId, filename: "tree.jpg", folderId: natureId });
    await seedPhoto({ ownerId: cId, collectionId: cCollectionId, filename: "pizza.jpg", folderId: foodId });
  }, 30_000);

  afterAll(async () => {
    if (infraAvailable) await prisma.user.deleteMany({ where: { email: cEmail } });
  });

  it("returns only photos in that category's folder", async () => {
    if (skipInfra()) return;
    const res = await search(cCookie, "?category=Nature");
    expect(res.status).toBe(200);
    const names = res.body.photos.map((p: { originalFilename: string }) => p.originalFilename).sort();
    expect(names).toEqual(["leaf.jpg", "tree.jpg"]);
    expect(res.body.total).toBe(2);
  });

  it("400 on an unknown category (Zod enum)", async () => {
    if (skipInfra()) return;
    const res = await search(cCookie, "?category=Bogus");
    expect(res.status).toBe(400);
  });

  it("a category with no matching folder for this owner → empty (not a leak)", async () => {
    if (skipInfra()) return;
    // Owner c has no "People" folder → empty.
    const res = await search(cCookie, "?category=People");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.photos).toHaveLength(0);
  });

  it("category match is owner-scoped: does NOT match another owner's identically-named folder", async () => {
    if (skipInfra()) return;
    // Owner A also has a "Nature" folder with a photo; searching c's library by
    // category=Nature must not surface A's photo.
    const aNature = await seedFolder(aCollectionId, "Nature", "ai_generated");
    const aNaturePhoto = await seedPhoto({ ownerId: aId, collectionId: aCollectionId, filename: "a-nature.jpg", folderId: aNature });
    const res = await search(cCookie, "?category=Nature");
    expect(res.status).toBe(200);
    const ids = res.body.photos.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(aNaturePhoto);
  });
});

// ---------------------------------------------------------------------------
// Combined filters AND
// ---------------------------------------------------------------------------
describe("GET /api/search — combined filters AND", () => {
  it("q + folder ANDs (both must hold)", async () => {
    if (skipInfra()) return;
    const gEmail = `search-and-${stamp}@example.com`;
    const s = await request(app).post("/api/auth/signup").send({ email: gEmail, password, name: "And Owner" });
    const gCookie = s.headers["set-cookie"][0];
    const gId = s.body.user.id;
    const gc = await prisma.collection.create({ data: { ownerId: gId, name: "My Photos", isDefault: true } });
    const folderId = await seedFolder(gc.id, `and-fld-${stamp}`);
    // In-folder AND name-matches → the only hit.
    const hit = await seedPhoto({ ownerId: gId, collectionId: gc.id, filename: "vacation-beach.jpg", folderId });
    // In-folder but name doesn't match.
    const inFolderNoName = await seedPhoto({ ownerId: gId, collectionId: gc.id, filename: "random.jpg", folderId });
    // Name matches but not in folder.
    const nameNoFolder = await seedPhoto({ ownerId: gId, collectionId: gc.id, filename: "vacation-home.jpg", folderId: null });

    const res = await search(gCookie, `?q=vacation&folderId=${folderId}`);
    expect(res.status).toBe(200);
    const ids = res.body.photos.map((p: { id: string }) => p.id);
    expect(ids).toEqual([hit]);
    expect(ids).not.toContain(inFolderNoName);
    expect(ids).not.toContain(nameNoFolder);

    await prisma.user.deleteMany({ where: { email: gEmail } });
  });
});

// ---------------------------------------------------------------------------
// Pagination validation (house rule — 400, not clamp)
// ---------------------------------------------------------------------------
describe("GET /api/search — pagination validation", () => {
  it("400 when limit > 100", async () => {
    if (skipInfra()) return;
    const res = await search(aCookie, "?limit=101");
    expect(res.status).toBe(400);
  });

  it("400 on a garbage limit and on a negative offset", async () => {
    if (skipInfra()) return;
    expect((await search(aCookie, "?limit=abc")).status).toBe(400);
    expect((await search(aCookie, "?offset=-1")).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// S6 — empty query → whole library newest-first
// ---------------------------------------------------------------------------
describe("GET /api/search — empty query (S6, browse-all newest-first)", () => {
  it("returns the owner's whole library newest-first, paginated", async () => {
    if (skipInfra()) return;
    const eEmail = `search-empty-${stamp}@example.com`;
    const s = await request(app).post("/api/auth/signup").send({ email: eEmail, password, name: "Empty Owner" });
    const eCookie = s.headers["set-cookie"][0];
    const eId = s.body.user.id;
    const ec = await prisma.collection.create({ data: { ownerId: eId, name: "My Photos", isDefault: true } });
    const oldest = await seedPhoto({ ownerId: eId, collectionId: ec.id, filename: "e-oldest.jpg", createdAt: new Date("2024-01-01T00:00:00Z") });
    const newest = await seedPhoto({ ownerId: eId, collectionId: ec.id, filename: "e-newest.jpg", createdAt: new Date("2024-12-01T00:00:00Z") });

    const res = await search(eCookie, "");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    // Newest first.
    expect(res.body.photos[0].id).toBe(newest);
    expect(res.body.photos[1].id).toBe(oldest);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);

    await prisma.user.deleteMany({ where: { email: eEmail } });
  });
});

// ---------------------------------------------------------------------------
// LEAK-PROOF two-owner scoping (the core risk) — overlapping filenames
// ---------------------------------------------------------------------------
describe("GET /api/search — LEAK-PROOF owner scoping (two owners, overlapping filenames)", () => {
  it("each owner's ?q= returns ONLY their own photos (both directions)", async () => {
    if (skipInfra()) return;
    const shared = `leaktest${stamp}`;
    // Same filename base under BOTH owners.
    const aPhoto = await seedPhoto({ ownerId: aId, collectionId: aCollectionId, filename: `${shared}-photo.jpg` });
    const bPhoto = await seedPhoto({ ownerId: bId, collectionId: bCollectionId, filename: `${shared}-photo.jpg` });

    // A searches → only A's.
    const aRes = await search(aCookie, `?q=${shared}`);
    expect(aRes.status).toBe(200);
    const aIds = aRes.body.photos.map((p: { id: string }) => p.id);
    expect(aIds).toContain(aPhoto);
    expect(aIds).not.toContain(bPhoto);

    // B searches → only B's.
    const bRes = await search(bCookie, `?q=${shared}`);
    expect(bRes.status).toBe(200);
    const bIds = bRes.body.photos.map((p: { id: string }) => p.id);
    expect(bIds).toContain(bPhoto);
    expect(bIds).not.toContain(aPhoto);
  });
});
