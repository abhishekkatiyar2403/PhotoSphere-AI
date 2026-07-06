import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";

// Integration tests for specs/folder-mgmt-download-search.md PART P4 (folder
// rename / merge / delete — backend). Follows the skip-not-fake convention of
// guest-access.smoke.test.ts: DB-dependent tests skip with a warning when
// Postgres is unreachable. Unlike the guest/audit smoke tests these DO NOT need
// the worker — folders/photos/permissions are seeded directly via Prisma so the
// P4 correctness surface (counter reconciliation, @@unique collision, the F1
// live-share guard, F2 orphan-to-Unfiled, F4 audit rows) is deterministic.
//
// Covers the P4 acceptance criteria: rename 200 + collision 409 + empty→400 +
// >255→400 + cross-owner 404 + rename-doesn't-touch-counts; merge moves all
// photos + both counts EXACT + A deleted + folder_merged audit + merge-self 400
// + cross-owner 404 + cross-collection 400; F1 merge AND delete of a
// live-shared folder → 409 with NO data moved (then revoke → succeeds); delete
// → photos to Unfiled (folderId null) + photo rows + a folder_deleted audit row.

const app = createApp();

const stamp = Date.now();
const ownerEmail = `folder-owner-${stamp}@example.com`;
const otherEmail = `folder-other-${stamp}@example.com`;
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
    console.warn("Skipping: Postgres not reachable. Run `docker compose up -d` first.");
    return true;
  }
  return false;
}

// Seed a folder directly in the owner's collection with `photoCount` set to the
// number of stored photos created for it.
async function seedFolder(opts: {
  collectionId: string;
  ownerId: string;
  name: string;
  categoryType?: string;
  photos?: number;
}): Promise<{ id: string; photoIds: string[] }> {
  const folder = await prisma.folder.create({
    data: {
      collectionId: opts.collectionId,
      name: opts.name,
      categoryType: opts.categoryType ?? "custom",
      photoCount: opts.photos ?? 0,
    },
  });
  const photoIds: string[] = [];
  for (let i = 0; i < (opts.photos ?? 0); i++) {
    const p = await prisma.photo.create({
      data: {
        ownerId: opts.ownerId,
        s3Key: `seed/${opts.ownerId}/${folder.id}/${i}.jpg`,
        originalFilename: `seed-${folder.id}-${i}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 1234,
        aiClassificationStatus: "done",
        collectionId: opts.collectionId,
        folderId: folder.id,
      },
    });
    photoIds.push(p.id);
  }
  return { id: folder.id, photoIds };
}

// Seed a live folder_permission (a guest share) on a folder.
async function seedLiveShare(folderId: string, grantedBy: string): Promise<string> {
  const guest = await prisma.guestUser.create({
    data: { email: `share-${crypto.randomUUID()}@example.com`, createdBy: grantedBy },
  });
  await prisma.folderPermission.create({
    data: {
      guestUserId: guest.id,
      folderId,
      permissionLevel: "view",
      grantedBy,
      // revokedAt null + expiresAt null = live
    },
  });
  return guest.id;
}

async function liveCount(folderId: string): Promise<number> {
  return prisma.photo.count({ where: { folderId } });
}

beforeAll(async () => {
  try {
    await prisma.$connect();
  } catch {
    infraAvailable = false;
    return;
  }

  const ownerSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "Folder Owner" });
  ownerCookie = ownerSignup.headers["set-cookie"][0];
  ownerId = ownerSignup.body.user.id;

  const otherSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherEmail, password, name: "Other Owner" });
  otherCookie = otherSignup.headers["set-cookie"][0];
  otherId = otherSignup.body.user.id;

  // A default collection per owner (the worker lazily makes these in prod; we
  // create them directly since these tests don't run the worker).
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
// Rename — PATCH /api/folders/:id
// ---------------------------------------------------------------------------
describe("PATCH /api/folders/:id — rename", () => {
  it("401 without a session", async () => {
    const res = await request(app).patch(`/api/folders/${crypto.randomUUID()}`).send({ name: "X" });
    expect(res.status).toBe(401);
  });

  it("200 renames an owned folder, DB reflects the new name, counts untouched", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `rename-src-${stamp}`, photos: 3 });

    const res = await request(app)
      .patch(`/api/folders/${f.id}`)
      .set("Cookie", ownerCookie)
      .send({ name: `renamed-${stamp}` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`renamed-${stamp}`);

    const row = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(row?.name).toBe(`renamed-${stamp}`);
    // photoCount / categoryType untouched; no photo's folderId changed.
    expect(row?.photoCount).toBe(3);
    expect(row?.categoryType).toBe("custom");
    expect(await liveCount(f.id)).toBe(3);
  });

  it("409 on a name collision (caught @@unique, not a pre-check)", async () => {
    if (skipInfra()) return;
    const a = await seedFolder({ collectionId, ownerId, name: `collide-a-${stamp}` });
    const b = await seedFolder({ collectionId, ownerId, name: `collide-b-${stamp}` });
    const res = await request(app)
      .patch(`/api/folders/${b.id}`)
      .set("Cookie", ownerCookie)
      .send({ name: `collide-a-${stamp}` });
    expect(res.status).toBe(409);
    // B unchanged.
    const row = await prisma.folder.findUnique({ where: { id: b.id } });
    expect(row?.name).toBe(`collide-b-${stamp}`);
    expect(a.id).toBeTruthy();
  });

  it("400 on empty/whitespace name and on name > 255 chars", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `rename-bad-${stamp}` });
    const empty = await request(app)
      .patch(`/api/folders/${f.id}`)
      .set("Cookie", ownerCookie)
      .send({ name: "   " });
    expect(empty.status).toBe(400);
    const tooLong = await request(app)
      .patch(`/api/folders/${f.id}`)
      .set("Cookie", ownerCookie)
      .send({ name: "x".repeat(256) });
    expect(tooLong.status).toBe(400);
    // Untouched.
    const row = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(row?.name).toBe(`rename-bad-${stamp}`);
  });

  it("404 renaming a folder owned by a different owner, no change", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `rename-xowner-${stamp}` });
    const res = await request(app)
      .patch(`/api/folders/${f.id}`)
      .set("Cookie", otherCookie)
      .send({ name: "hacked" });
    expect(res.status).toBe(404);
    const row = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(row?.name).toBe(`rename-xowner-${stamp}`);
  });

  it("allows rename on an ai_generated folder (F5)", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({
      collectionId,
      ownerId,
      name: `ai-rename-${stamp}`,
      categoryType: "ai_generated",
    });
    const res = await request(app)
      .patch(`/api/folders/${f.id}`)
      .set("Cookie", ownerCookie)
      .send({ name: `ai-renamed-${stamp}` });
    expect(res.status).toBe(200);
    const row = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(row?.name).toBe(`ai-renamed-${stamp}`);
    expect(row?.categoryType).toBe("ai_generated");
  });
});

// ---------------------------------------------------------------------------
// Merge — POST /api/folders/:id/merge
// ---------------------------------------------------------------------------
describe("POST /api/folders/:id/merge", () => {
  it("moves all photos A→B, both counts EXACT, A deleted, folder_merged audited", async () => {
    if (skipInfra()) return;
    const a = await seedFolder({ collectionId, ownerId, name: `merge-a-${stamp}`, photos: 3 });
    const b = await seedFolder({ collectionId, ownerId, name: `merge-b-${stamp}`, photos: 2 });

    const res = await request(app)
      .post(`/api/folders/${a.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: b.id });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(res.body.photosMoved).toBe(3);
    expect(res.body.targetPhotoCount).toBe(5);

    // A gone; no photo still points at A.
    expect(await prisma.folder.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await liveCount(a.id)).toBe(0);

    // B's counter is EXACT vs the live COUNT (no drift).
    const bRow = await prisma.folder.findUnique({ where: { id: b.id } });
    expect(bRow?.photoCount).toBe(5);
    expect(await liveCount(b.id)).toBe(5);

    // All of A's photos now point at B.
    for (const pid of a.photoIds) {
      const p = await prisma.photo.findUnique({ where: { id: pid } });
      expect(p?.folderId).toBe(b.id);
    }

    // Exactly one folder_merged audit row with the right shape.
    const rows = await prisma.auditLog.findMany({
      where: { ownerId, action: "folder_merged", resourceId: b.id },
      orderBy: { createdAt: "desc" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(rows[0].actorType).toBe("owner");
    expect(meta.sourceFolderName).toBe(`merge-a-${stamp}`);
    expect(meta.targetFolderName).toBe(`merge-b-${stamp}`);
    expect(meta.photosMoved).toBe(3);
  });

  it("400 merging a folder into itself", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `merge-self-${stamp}` });
    const res = await request(app)
      .post(`/api/folders/${f.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: f.id });
    expect(res.status).toBe(400);
    // Still exists.
    expect(await prisma.folder.findUnique({ where: { id: f.id } })).not.toBeNull();
  });

  it("404 when the source is not owned; 404 when the target is not owned", async () => {
    if (skipInfra()) return;
    const mine = await seedFolder({ collectionId, ownerId, name: `merge-mine-${stamp}`, photos: 1 });
    const theirs = await seedFolder({
      collectionId: otherCollectionId,
      ownerId: otherId,
      name: `merge-theirs-${stamp}`,
      photos: 1,
    });

    // Source foreign → 404.
    const srcForeign = await request(app)
      .post(`/api/folders/${theirs.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: mine.id });
    expect(srcForeign.status).toBe(404);

    // Target foreign → 404 (and nothing moved from mine).
    const tgtForeign = await request(app)
      .post(`/api/folders/${mine.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: theirs.id });
    expect(tgtForeign.status).toBe(404);
    expect(await liveCount(mine.id)).toBe(1);
    expect(await prisma.folder.findUnique({ where: { id: mine.id } })).not.toBeNull();
  });

  it("400 merging across collections (F3)", async () => {
    if (skipInfra()) return;
    // A second collection for the SAME owner so both are owned but differ.
    const c2 = await prisma.collection.create({
      data: { ownerId, name: `Second-${stamp}`, isDefault: false },
    });
    const a = await seedFolder({ collectionId, ownerId, name: `xcoll-a-${stamp}`, photos: 2 });
    const b = await seedFolder({ collectionId: c2.id, ownerId, name: `xcoll-b-${stamp}` });
    const res = await request(app)
      .post(`/api/folders/${a.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: b.id });
    expect(res.status).toBe(400);
    // Nothing moved.
    expect(await liveCount(a.id)).toBe(2);
    expect(await prisma.folder.findUnique({ where: { id: a.id } })).not.toBeNull();
  });

  it("F1: 409 merging a source with a LIVE guest share, and NO photos move", async () => {
    if (skipInfra()) return;
    const a = await seedFolder({ collectionId, ownerId, name: `merge-shared-a-${stamp}`, photos: 3 });
    const b = await seedFolder({ collectionId, ownerId, name: `merge-shared-b-${stamp}`, photos: 1 });
    await seedLiveShare(a.id, ownerId);

    const blocked = await request(app)
      .post(`/api/folders/${a.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: b.id });
    expect(blocked.status).toBe(409);
    // A still has its photos; B unchanged; A still exists.
    expect(await liveCount(a.id)).toBe(3);
    expect(await liveCount(b.id)).toBe(1);
    expect(await prisma.folder.findUnique({ where: { id: a.id } })).not.toBeNull();

    // Revoke the share → merge now succeeds.
    await prisma.folderPermission.updateMany({
      where: { folderId: a.id },
      data: { revokedAt: new Date() },
    });
    const ok = await request(app)
      .post(`/api/folders/${a.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: b.id });
    expect(ok.status).toBe(200);
    expect(ok.body.photosMoved).toBe(3);
    expect(await prisma.folder.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await liveCount(b.id)).toBe(4);
    const bRow = await prisma.folder.findUnique({ where: { id: b.id } });
    expect(bRow?.photoCount).toBe(4);
  });

  it("an EXPIRED permission does not block the merge (only live shares do)", async () => {
    if (skipInfra()) return;
    const a = await seedFolder({ collectionId, ownerId, name: `merge-expired-a-${stamp}`, photos: 2 });
    const b = await seedFolder({ collectionId, ownerId, name: `merge-expired-b-${stamp}`, photos: 0 });
    const guest = await prisma.guestUser.create({
      data: { email: `exp-${crypto.randomUUID()}@example.com`, createdBy: ownerId },
    });
    await prisma.folderPermission.create({
      data: {
        guestUserId: guest.id,
        folderId: a.id,
        permissionLevel: "view",
        grantedBy: ownerId,
        expiresAt: new Date(Date.now() - 1000), // already expired = not live
      },
    });
    const res = await request(app)
      .post(`/api/folders/${a.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: b.id });
    expect(res.status).toBe(200);
    expect(res.body.photosMoved).toBe(2);
  });

  it("400 on a non-uuid targetFolderId", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `merge-baduuid-${stamp}` });
    const res = await request(app)
      .post(`/api/folders/${f.id}/merge`)
      .set("Cookie", ownerCookie)
      .send({ targetFolderId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Delete — DELETE /api/folders/:id
// ---------------------------------------------------------------------------
describe("DELETE /api/folders/:id", () => {
  it("moves photos to Unfiled (folderId null), keeps photo rows, deletes folder, audits", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `del-src-${stamp}`, photos: 4 });

    const res = await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.photosOrphaned).toBe(4);

    // Folder row gone.
    expect(await prisma.folder.findUnique({ where: { id: f.id } })).toBeNull();

    // Photo rows SURVIVE (not cascade-deleted) and now have folderId = null.
    for (const pid of f.photoIds) {
      const p = await prisma.photo.findUnique({ where: { id: pid } });
      expect(p).not.toBeNull();
      expect(p?.folderId).toBeNull();
      // The original MinIO key is untouched (row still points at it).
      expect(p?.s3Key).toBeTruthy();
      // A GET /api/photos/:id still resolves the (surviving) row.
      const detail = await request(app).get(`/api/photos/${pid}`).set("Cookie", ownerCookie);
      expect(detail.status).toBe(200);
    }

    // folder_deleted audit row with the right shape.
    const rows = await prisma.auditLog.findMany({
      where: { ownerId, action: "folder_deleted", resourceId: f.id },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(rows[0].actorType).toBe("owner");
    expect(meta.folderName).toBe(`del-src-${stamp}`);
    expect(meta.photosOrphaned).toBe(4);
  });

  it("404 deleting a folder owned by a different owner, no effect", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `del-xowner-${stamp}`, photos: 2 });
    const res = await request(app).delete(`/api/folders/${f.id}`).set("Cookie", otherCookie);
    expect(res.status).toBe(404);
    // Untouched.
    expect(await prisma.folder.findUnique({ where: { id: f.id } })).not.toBeNull();
    expect(await liveCount(f.id)).toBe(2);
  });

  it("F1: 409 deleting a folder with a LIVE guest share; folder + photos untouched; revoke → succeeds", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `del-shared-${stamp}`, photos: 3 });
    await seedLiveShare(f.id, ownerId);

    const blocked = await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);
    expect(blocked.status).toBe(409);
    // Nothing touched.
    expect(await prisma.folder.findUnique({ where: { id: f.id } })).not.toBeNull();
    expect(await liveCount(f.id)).toBe(3);

    // Revoke → delete now succeeds and photos orphan to Unfiled.
    await prisma.folderPermission.updateMany({
      where: { folderId: f.id },
      data: { revokedAt: new Date() },
    });
    const ok = await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);
    expect(ok.status).toBe(200);
    expect(ok.body.photosOrphaned).toBe(3);
    expect(await prisma.folder.findUnique({ where: { id: f.id } })).toBeNull();
    expect(await prisma.photo.count({ where: { ownerId, folderId: null, id: { in: f.photoIds } } })).toBe(3);
  });

  it("401 without a session", async () => {
    const res = await request(app).delete(`/api/folders/${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
  });
});
