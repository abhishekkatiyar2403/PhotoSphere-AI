import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { runTrashPurgeJob } from "../lib/trashPurgeJob";
import { ensureBucketExists, getPresignedGetUrl, putObject } from "../lib/storage";
import { originalKey } from "../lib/storageKeys";

// Integration tests for specs/trash-system.md — soft delete + 7-day
// retention + auto-purge. Follows the skip-not-fake convention of
// folder-mgmt.smoke.test.ts / folder-zip.smoke.test.ts: DB/MinIO-dependent
// tests skip with a warning when infra is unreachable. Photos/folders are
// seeded directly via Prisma (no worker dependency); a subset write REAL
// MinIO objects (via putObject) to verify the permanent-purge path actually
// removes bytes, not just DB rows.

const app = createApp();

const stamp = Date.now();
const ownerEmail = `trash-owner-${stamp}@example.com`;
const otherEmail = `trash-other-${stamp}@example.com`;
const password = "correct-password-123";

let infraAvailable = true;
let ownerCookie: string;
let ownerId: string;
let otherCookie: string;
let otherId: string;
let collectionId: string;

function skipInfra(): boolean {
  if (!infraAvailable) {
    console.warn("Skipping: Postgres/MinIO not reachable. Run `docker compose up -d` first.");
    return true;
  }
  return false;
}

async function seedFolder(opts: {
  collectionId: string;
  ownerId: string;
  name: string;
  photos?: number;
  deletedAt?: Date | null;
}): Promise<{ id: string; photoIds: string[] }> {
  const folder = await prisma.folder.create({
    data: {
      collectionId: opts.collectionId,
      name: opts.name,
      categoryType: "custom",
      photoCount: opts.photos ?? 0,
      deletedAt: opts.deletedAt ?? null,
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

async function seedLiveShare(folderId: string, grantedBy: string): Promise<string> {
  const guest = await prisma.guestUser.create({
    data: { email: `share-${crypto.randomUUID()}@example.com`, createdBy: grantedBy },
  });
  await prisma.folderPermission.create({
    data: { guestUserId: guest.id, folderId, permissionLevel: "view", grantedBy },
  });
  return guest.id;
}

async function seedRealPhoto(opts: {
  ownerId: string;
  collectionId?: string | null;
  folderId?: string | null;
  status?: string;
}): Promise<{ id: string; s3Key: string }> {
  const id = crypto.randomUUID();
  const s3Key = originalKey(opts.ownerId, id, "jpg");
  await putObject(s3Key, Buffer.from(`real-bytes-${id}`), "image/jpeg");
  const photo = await prisma.photo.create({
    data: {
      id,
      ownerId: opts.ownerId,
      s3Key,
      originalFilename: `real-${id}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      aiClassificationStatus: opts.status ?? "done",
      collectionId: opts.collectionId ?? null,
      folderId: opts.folderId ?? null,
    },
  });
  return { id: photo.id, s3Key };
}

async function minioObjectExists(key: string): Promise<boolean> {
  try {
    await getPresignedGetUrl(key, 5);
    // getPresignedGetUrl doesn't itself verify existence (it just signs a
    // URL) — actually fetch it to confirm the object is really there/gone.
    const url = await getPresignedGetUrl(key, 5);
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
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
    .send({ email: ownerEmail, password, name: "Trash Owner" });
  ownerCookie = ownerSignup.headers["set-cookie"][0];
  ownerId = ownerSignup.body.user.id;

  const otherSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherEmail, password, name: "Other Owner" });
  otherCookie = otherSignup.headers["set-cookie"][0];
  otherId = otherSignup.body.user.id;

  const c = await prisma.collection.create({
    data: { ownerId, name: "My Photos", isDefault: true },
  });
  collectionId = c.id;
}, 30_000);

afterAll(async () => {
  if (infraAvailable) {
    await prisma.user.deleteMany({ where: { email: { in: [ownerEmail, otherEmail] } } });
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/photos/:id — soft delete
// ---------------------------------------------------------------------------
describe("DELETE /api/photos/:id (soft delete)", () => {
  it("sets deletedAt, does NOT remove the row or MinIO object, decrements photoCount, audits", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `soft-del-${stamp}`, photos: 2 });
    const [target, other] = f.photoIds;

    const res = await request(app).delete(`/api/photos/${target}`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.photoId).toBe(target);
    expect(res.body.folderId).toBe(f.id);
    expect(res.body.deletedAt).toBeTruthy();
    expect(res.body.purgeAt).toBeTruthy();

    const row = await prisma.photo.findUnique({ where: { id: target } });
    expect(row).not.toBeNull(); // row survives
    expect(row?.deletedAt).not.toBeNull();

    const folderRow = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(folderRow?.photoCount).toBe(1); // decremented by exactly 1

    // Other photo in the same folder untouched.
    const otherRow = await prisma.photo.findUnique({ where: { id: other } });
    expect(otherRow?.deletedAt).toBeNull();

    const rows = await prisma.auditLog.findMany({ where: { ownerId, action: "photo_deleted", resourceId: target } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("deleting an Unfiled photo (folderId null) succeeds and touches no folder", async () => {
    if (skipInfra()) return;
    const p = await prisma.photo.create({
      data: {
        ownerId,
        s3Key: `seed/${ownerId}/unfiled-del.jpg`,
        originalFilename: "unfiled-del.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
        aiClassificationStatus: "done",
      },
    });
    const res = await request(app).delete(`/api/photos/${p.id}`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.folderId).toBeNull();
  });

  it("404 on a non-owned or nonexistent photo, and on an already-trashed photo", async () => {
    if (skipInfra()) return;
    const notOwned = await request(app)
      .post("/api/auth/signup")
      .send({ email: `trash-victim-${stamp}@example.com`, password, name: "Victim" });
    const victimCookie = notOwned.headers["set-cookie"][0];
    const victimId = notOwned.body.user.id;
    const vc = await prisma.collection.create({ data: { ownerId: victimId, name: "My Photos", isDefault: true } });
    const f = await seedFolder({ collectionId: vc.id, ownerId: victimId, name: `victim-${stamp}`, photos: 1 });

    const cross = await request(app).delete(`/api/photos/${f.photoIds[0]}`).set("Cookie", ownerCookie);
    expect(cross.status).toBe(404);

    const nonexistent = await request(app)
      .delete(`/api/photos/${crypto.randomUUID()}`)
      .set("Cookie", victimCookie);
    expect(nonexistent.status).toBe(404);

    const first = await request(app).delete(`/api/photos/${f.photoIds[0]}`).set("Cookie", victimCookie);
    expect(first.status).toBe(200);
    const again = await request(app).delete(`/api/photos/${f.photoIds[0]}`).set("Cookie", victimCookie);
    expect(again.status).toBe(404);
  });

  it("PD3a: deleting original A cascade-nulls duplicate B's duplicateOfPhotoId; B survives untouched otherwise", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `dup-chain-${stamp}`, photos: 1 });
    const originalId = f.photoIds[0];
    const dup = await prisma.photo.create({
      data: {
        ownerId,
        s3Key: `seed/${ownerId}/dup.jpg`,
        originalFilename: "dup.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
        aiClassificationStatus: "duplicate",
        duplicateOfPhotoId: originalId,
        dedupMethod: "sha256",
      },
    });

    const res = await request(app).delete(`/api/photos/${originalId}`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);

    const dupRow = await prisma.photo.findUnique({ where: { id: dup.id } });
    expect(dupRow?.duplicateOfPhotoId).toBeNull();
    expect(dupRow?.aiClassificationStatus).toBe("duplicate");
    expect(dupRow?.deletedAt).toBeNull();
  });

  it("T2 (FINAL, REVERSED): 409 deleting a single photo whose folder is LIVE-shared; nothing changed; revoke → succeeds", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `t2-shared-${stamp}`, photos: 1 });
    await seedLiveShare(f.id, ownerId);

    const blocked = await request(app).delete(`/api/photos/${f.photoIds[0]}`).set("Cookie", ownerCookie);
    expect(blocked.status).toBe(409);
    const row = await prisma.photo.findUnique({ where: { id: f.photoIds[0] } });
    expect(row?.deletedAt).toBeNull();

    await prisma.folderPermission.updateMany({ where: { folderId: f.id }, data: { revokedAt: new Date() } });
    const ok = await request(app).delete(`/api/photos/${f.photoIds[0]}`).set("Cookie", ownerCookie);
    expect(ok.status).toBe(200);
  });

  it("401 without a session", async () => {
    const res = await request(app).delete(`/api/photos/${crypto.randomUUID()}`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/photos/bulk-delete
// ---------------------------------------------------------------------------
describe("POST /api/photos/bulk-delete", () => {
  it("partial success: valid ids deleted, bogus id reported not_found; batches photoCount decrements across two folders", async () => {
    if (skipInfra()) return;
    const fa = await seedFolder({ collectionId, ownerId, name: `bulk-a-${stamp}`, photos: 2 });
    const fb = await seedFolder({ collectionId, ownerId, name: `bulk-b-${stamp}`, photos: 1 });
    const bogus = crypto.randomUUID();

    const res = await request(app)
      .post("/api/photos/bulk-delete")
      .set("Cookie", ownerCookie)
      .send({ photoIds: [fa.photoIds[0], fb.photoIds[0], bogus] });
    expect(res.status).toBe(200);
    expect(res.body.deleted.sort()).toEqual([fa.photoIds[0], fb.photoIds[0]].sort());
    expect(res.body.failed).toEqual([{ id: bogus, reason: "not_found" }]);

    const faRow = await prisma.folder.findUnique({ where: { id: fa.id } });
    const fbRow = await prisma.folder.findUnique({ where: { id: fb.id } });
    expect(faRow?.photoCount).toBe(1);
    expect(fbRow?.photoCount).toBe(0);
  });

  it("T2 applies per-item in bulk: a live-shared photo's id is reported not_found, others still delete", async () => {
    if (skipInfra()) return;
    const shared = await seedFolder({ collectionId, ownerId, name: `bulk-shared-${stamp}`, photos: 1 });
    await seedLiveShare(shared.id, ownerId);
    const plain = await seedFolder({ collectionId, ownerId, name: `bulk-plain-${stamp}`, photos: 1 });

    const res = await request(app)
      .post("/api/photos/bulk-delete")
      .set("Cookie", ownerCookie)
      .send({ photoIds: [shared.photoIds[0], plain.photoIds[0]] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([plain.photoIds[0]]);
    expect(res.body.failed).toEqual([{ id: shared.photoIds[0], reason: "not_found" }]);
    const sharedRow = await prisma.photo.findUnique({ where: { id: shared.photoIds[0] } });
    expect(sharedRow?.deletedAt).toBeNull();
  });

  it("400 on empty array and on >100 ids", async () => {
    if (skipInfra()) return;
    const empty = await request(app).post("/api/photos/bulk-delete").set("Cookie", ownerCookie).send({ photoIds: [] });
    expect(empty.status).toBe(400);
    const tooMany = await request(app)
      .post("/api/photos/bulk-delete")
      .set("Cookie", ownerCookie)
      .send({ photoIds: Array.from({ length: 101 }, () => crypto.randomUUID()) });
    expect(tooMany.status).toBe(400);
  });

  it("401 without a session", async () => {
    const res = await request(app).post("/api/photos/bulk-delete").send({ photoIds: [crypto.randomUUID()] });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/folders/:id — soft delete (F1 unchanged, T-folder-photos)
// ---------------------------------------------------------------------------
describe("DELETE /api/folders/:id (soft delete, F1 unchanged)", () => {
  it("F1 still blocks with 409 while live-shared — re-verified after the F2 rewrite", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `f1-still-${stamp}`, photos: 1 });
    await seedLiveShare(f.id, ownerId);
    const res = await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);
    expect(res.status).toBe(409);
  });

  it("photos disappear from every listing but survive with their own deletedAt untouched, transitively hidden", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `transitive-${stamp}`, photos: 2 });
    const del = await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);
    expect(del.status).toBe(200);

    // Folder gone from the folder tree.
    const tree = await request(app).get(`/api/collections/${collectionId}/folders`).set("Cookie", ownerCookie);
    expect(tree.body.folders.map((x: { id: string }) => x.id)).not.toContain(f.id);

    // Its photos: 404 on GET /:id and GET /:id/status; absent from search.
    for (const pid of f.photoIds) {
      const detail = await request(app).get(`/api/photos/${pid}`).set("Cookie", ownerCookie);
      expect(detail.status).toBe(404);
      const status = await request(app).get(`/api/photos/${pid}/status`).set("Cookie", ownerCookie);
      expect(status.status).toBe(404);
      const p = await prisma.photo.findUnique({ where: { id: pid } });
      expect(p?.deletedAt).toBeNull(); // never individually marked
    }

    const search = await request(app).get("/api/search").set("Cookie", ownerCookie).query({ q: "seed" });
    const ids = search.body.photos.map((x: { id: string }) => x.id);
    for (const pid of f.photoIds) expect(ids).not.toContain(pid);
  });
});

// ---------------------------------------------------------------------------
// GET /api/trash
// ---------------------------------------------------------------------------
describe("GET /api/trash", () => {
  it("returns the owner's trashed photos AND folders with correct purgeAt/daysRemaining, leak-proof across owners", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `trashlist-${stamp}`, photos: 1 });
    await request(app).delete(`/api/photos/${f.photoIds[0]}`).set("Cookie", ownerCookie);
    const f2 = await seedFolder({ collectionId, ownerId, name: `trashlist-folder-${stamp}`, photos: 1 });
    await request(app).delete(`/api/folders/${f2.id}`).set("Cookie", ownerCookie);

    const res = await request(app).get("/api/trash").set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    const photoIds = res.body.photos.map((p: { id: string }) => p.id);
    expect(photoIds).toContain(f.photoIds[0]);
    const folderIds = res.body.folders.map((x: { id: string }) => x.id);
    expect(folderIds).toContain(f2.id);
    const photoEntry = res.body.photos.find((p: { id: string }) => p.id === f.photoIds[0]);
    expect(photoEntry.daysRemaining).toBeLessThanOrEqual(7);
    expect(photoEntry.daysRemaining).toBeGreaterThan(0);

    const otherView = await request(app).get("/api/trash").set("Cookie", otherCookie);
    expect(otherView.body.photos.map((p: { id: string }) => p.id)).not.toContain(f.photoIds[0]);
    expect(otherView.body.folders.map((x: { id: string }) => x.id)).not.toContain(f2.id);
  });

  it("401 without a session; 400 on limit>100", async () => {
    const noSession = await request(app).get("/api/trash");
    expect(noSession.status).toBe(401);
    if (skipInfra()) return;
    const bad = await request(app).get("/api/trash").set("Cookie", ownerCookie).query({ limit: 101 });
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------
describe("POST /api/photos/:id/restore", () => {
  it("clears deletedAt, re-increments photoCount, reappears in listings; 404 if not trashed/not owned", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `restore-photo-${stamp}`, photos: 1 });
    await request(app).delete(`/api/photos/${f.photoIds[0]}`).set("Cookie", ownerCookie);

    const notYet = await request(app).post(`/api/photos/${f.photoIds[0]}/restore`).set("Cookie", otherCookie);
    expect(notYet.status).toBe(404);

    const res = await request(app).post(`/api/photos/${f.photoIds[0]}/restore`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(true);

    const row = await prisma.photo.findUnique({ where: { id: f.photoIds[0] } });
    expect(row?.deletedAt).toBeNull();
    const folderRow = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(folderRow?.photoCount).toBe(1);

    const detail = await request(app).get(`/api/photos/${f.photoIds[0]}`).set("Cookie", ownerCookie);
    expect(detail.status).toBe(200);

    const again = await request(app).post(`/api/photos/${f.photoIds[0]}/restore`).set("Cookie", ownerCookie);
    expect(again.status).toBe(404); // not trashed anymore
  });

  it("auto-cascades restoring the photo's ALSO-trashed folder first (clean case, no collision)", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `cascade-clean-${stamp}`, photos: 1 });
    const photoId = f.photoIds[0];
    // Trash the photo, THEN trash the folder (photo keeps its own deletedAt).
    await request(app).delete(`/api/photos/${photoId}`).set("Cookie", ownerCookie);
    await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);

    const res = await request(app).post(`/api/photos/${photoId}/restore`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);

    const folderRow = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(folderRow?.deletedAt).toBeNull(); // folder auto-restored too
    const photoRow = await prisma.photo.findUnique({ where: { id: photoId } });
    expect(photoRow?.deletedAt).toBeNull();
  });

  it("returns the SAME 409 conflict shape as folder-restore when the auto-cascade hits a collision, and does NOT restore the photo", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `cascade-conflict-${stamp}`, photos: 1 });
    const photoId = f.photoIds[0];
    await request(app).delete(`/api/photos/${photoId}`).set("Cookie", ownerCookie);
    await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);
    // A NEW live folder with the SAME name (only possible thanks to T7's
    // partial unique index — a trashed folder no longer occupies the slot).
    const conflictFolder = await prisma.folder.create({
      data: { collectionId, name: `cascade-conflict-${stamp}`, categoryType: "custom" },
    });

    const res = await request(app).post(`/api/photos/${photoId}/restore`).set("Cookie", ownerCookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
    expect(res.body.conflictingFolderId).toBe(conflictFolder.id);
    expect(res.body.conflictingFolderName).toBe(`cascade-conflict-${stamp}`);

    // Neither the folder nor the photo was restored.
    const folderRow = await prisma.folder.findUnique({ where: { id: f.id } });
    expect(folderRow?.deletedAt).not.toBeNull();
    const photoRow = await prisma.photo.findUnique({ where: { id: photoId } });
    expect(photoRow?.deletedAt).not.toBeNull();
  });
});

describe("POST /api/folders/:id/restore", () => {
  it("plain restore clears deletedAt; all its (never-individually-touched) photos reappear at once", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `restore-folder-${stamp}`, photos: 2 });
    await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);

    const res = await request(app).post(`/api/folders/${f.id}/restore`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(true);

    for (const pid of f.photoIds) {
      const detail = await request(app).get(`/api/photos/${pid}`).set("Cookie", ownerCookie);
      expect(detail.status).toBe(200);
    }
  });

  it("404 if not owned or not trashed", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `restore-live-${stamp}`, photos: 0 });
    const notTrashed = await request(app).post(`/api/folders/${f.id}/restore`).set("Cookie", ownerCookie);
    expect(notTrashed.status).toBe(404);
    const notOwned = await request(app).post(`/api/folders/${f.id}/restore`).set("Cookie", otherCookie);
    expect(notOwned.status).toBe(404);
  });

  it("T7 + FINAL DECISION 4: a name collision with no onConflict → 409; onConflict=merge folds photos + reconciles counts + hard-deletes the restored row", async () => {
    if (skipInfra()) return;
    const trashed = await seedFolder({ collectionId, ownerId, name: `merge-restore-${stamp}`, photos: 2 });
    await request(app).delete(`/api/folders/${trashed.id}`).set("Cookie", ownerCookie);
    const live = await seedFolder({ collectionId, ownerId, name: `merge-restore-${stamp}`, photos: 1 });

    const conflict = await request(app).post(`/api/folders/${trashed.id}/restore`).set("Cookie", ownerCookie);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("conflict");
    expect(conflict.body.conflictingFolderId).toBe(live.id);

    const merged = await request(app)
      .post(`/api/folders/${trashed.id}/restore`)
      .set("Cookie", ownerCookie)
      .send({ onConflict: "merge" });
    expect(merged.status).toBe(200);
    expect(merged.body.merged).toBe(true);
    expect(merged.body.targetFolderId).toBe(live.id);
    expect(merged.body.photosMoved).toBe(2);
    expect(merged.body.targetPhotoCount).toBe(3);

    expect(await prisma.folder.findUnique({ where: { id: trashed.id } })).toBeNull(); // hard-deleted, no leftover trashed copy
    const liveRow = await prisma.folder.findUnique({ where: { id: live.id } });
    expect(liveRow?.photoCount).toBe(3);
  });

  it("onConflict=rename restores under a new name in one transaction; a second collision on newName → 409 again", async () => {
    if (skipInfra()) return;
    const trashed = await seedFolder({ collectionId, ownerId, name: `rename-restore-${stamp}`, photos: 1 });
    await request(app).delete(`/api/folders/${trashed.id}`).set("Cookie", ownerCookie);
    const liveA = await seedFolder({ collectionId, ownerId, name: `rename-restore-${stamp}`, photos: 0 });
    const liveB = await seedFolder({ collectionId, ownerId, name: `rename-restore-taken-${stamp}`, photos: 0 });

    // Renaming to something that ALSO collides → 409 again, no restore.
    const collideAgain = await request(app)
      .post(`/api/folders/${trashed.id}/restore`)
      .set("Cookie", ownerCookie)
      .send({ onConflict: "rename", newName: `rename-restore-taken-${stamp}` });
    expect(collideAgain.status).toBe(409);
    expect(collideAgain.body.conflictingFolderId).toBe(liveB.id);
    const stillTrashed = await prisma.folder.findUnique({ where: { id: trashed.id } });
    expect(stillTrashed?.deletedAt).not.toBeNull();

    const ok = await request(app)
      .post(`/api/folders/${trashed.id}/restore`)
      .set("Cookie", ownerCookie)
      .send({ onConflict: "rename", newName: `rename-restore-final-${stamp}` });
    expect(ok.status).toBe(200);
    expect(ok.body.restored).toBe(true);
    expect(ok.body.name).toBe(`rename-restore-final-${stamp}`);
    const row = await prisma.folder.findUnique({ where: { id: trashed.id } });
    expect(row?.deletedAt).toBeNull();
    expect(row?.name).toBe(`rename-restore-final-${stamp}`);
    expect(liveA.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Permanent delete — DELETE /api/trash/:type/:id and DELETE /api/trash
// ---------------------------------------------------------------------------
describe("DELETE /api/trash/:type/:id (permanent, single item)", () => {
  it("permanently purges a trashed photo NOW — row + MinIO gone; 404 on a live (not-trashed) photo", async () => {
    if (skipInfra()) return;
    const real = await seedRealPhoto({ ownerId, collectionId });
    expect(await minioObjectExists(real.s3Key)).toBe(true);

    const notTrashedYet = await request(app).delete(`/api/trash/photo/${real.id}`).set("Cookie", ownerCookie);
    expect(notTrashedYet.status).toBe(404);

    await request(app).delete(`/api/photos/${real.id}`).set("Cookie", ownerCookie);

    const res = await request(app).delete(`/api/trash/photo/${real.id}`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(await prisma.photo.findUnique({ where: { id: real.id } })).toBeNull();
    expect(await minioObjectExists(real.s3Key)).toBe(false);

    const rows = await prisma.auditLog.findMany({
      where: { ownerId, action: "photo_permanently_deleted", resourceId: real.id },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect((rows[0].metadata as Record<string, unknown>).trigger).toBe("manual");
  });

  it("permanently purges a trashed folder NOW, cascading to hard-delete ALL its photos (T5)", async () => {
    if (skipInfra()) return;
    const folder = await prisma.folder.create({
      data: { collectionId, name: `purge-cascade-${stamp}`, categoryType: "custom", photoCount: 1 },
    });
    const p1 = await seedRealPhoto({ ownerId, collectionId, folderId: folder.id }); // never individually soft-deleted
    const p2 = await seedRealPhoto({ ownerId, collectionId, folderId: folder.id });
    await request(app).delete(`/api/folders/${folder.id}`).set("Cookie", ownerCookie);

    const res = await request(app).delete(`/api/trash/folder/${folder.id}`).set("Cookie", ownerCookie);
    expect(res.status).toBe(200);

    expect(await prisma.folder.findUnique({ where: { id: folder.id } })).toBeNull();
    expect(await prisma.photo.findUnique({ where: { id: p1.id } })).toBeNull();
    expect(await prisma.photo.findUnique({ where: { id: p2.id } })).toBeNull();
    expect(await minioObjectExists(p1.s3Key)).toBe(false);
    expect(await minioObjectExists(p2.s3Key)).toBe(false);
  });

  it("400 on an unknown :type", async () => {
    if (skipInfra()) return;
    const res = await request(app).delete(`/api/trash/nonsense/${crypto.randomUUID()}`).set("Cookie", ownerCookie);
    expect(res.status).toBe(400);
  });

  it("404 (not leaked) on another owner's trashed item", async () => {
    if (skipInfra()) return;
    const real = await seedRealPhoto({ ownerId, collectionId });
    await request(app).delete(`/api/photos/${real.id}`).set("Cookie", ownerCookie);
    const res = await request(app).delete(`/api/trash/photo/${real.id}`).set("Cookie", otherCookie);
    expect(res.status).toBe(404);
    expect(await prisma.photo.findUnique({ where: { id: real.id } })).not.toBeNull();
  });
});

describe("DELETE /api/trash (empty trash)", () => {
  it("purges everything in the owner's trash and NOTHING in another owner's trash", async () => {
    if (skipInfra()) return;
    const standalone = await seedRealPhoto({ ownerId, collectionId });
    await request(app).delete(`/api/photos/${standalone.id}`).set("Cookie", ownerCookie);
    const folder = await prisma.folder.create({
      data: { collectionId, name: `empty-trash-cascade-${stamp}`, categoryType: "custom", photoCount: 1 },
    });
    const inFolder = await seedRealPhoto({ ownerId, collectionId, folderId: folder.id });
    await request(app).delete(`/api/folders/${folder.id}`).set("Cookie", ownerCookie);

    // Another owner's trash — must survive untouched.
    const otherCollection = await prisma.collection.create({
      data: { ownerId: otherId, name: "Other Coll", isDefault: false },
    });
    const otherReal = await seedRealPhoto({ ownerId: otherId, collectionId: otherCollection.id });
    await request(app).delete(`/api/photos/${otherReal.id}`).set("Cookie", otherCookie);

    const res = await request(app).delete("/api/trash").set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.emptied).toBe(true);
    expect(res.body.photosDeleted).toBeGreaterThanOrEqual(1);
    expect(res.body.foldersDeleted).toBeGreaterThanOrEqual(1);

    expect(await prisma.photo.findUnique({ where: { id: standalone.id } })).toBeNull();
    expect(await prisma.photo.findUnique({ where: { id: inFolder.id } })).toBeNull();
    expect(await prisma.folder.findUnique({ where: { id: folder.id } })).toBeNull();

    // Other owner's trashed photo survives.
    expect(await prisma.photo.findUnique({ where: { id: otherReal.id } })).not.toBeNull();

    const rows = await prisma.auditLog.findMany({ where: { ownerId, action: "trash_emptied" } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("401 without a session", async () => {
    const res = await request(app).delete("/api/trash");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The auto-purge job (idempotency, age gating, folder-cascade, photoCount discipline)
// ---------------------------------------------------------------------------
describe("runTrashPurgeJob — the daily auto-purge job", () => {
  it("purges an 8-day-old trashed photo, leaves a 6-day-old one alone, runs twice with no error/double-effect", async () => {
    if (skipInfra()) return;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

    const old = await seedRealPhoto({ ownerId, collectionId });
    await prisma.photo.update({ where: { id: old.id }, data: { deletedAt: eightDaysAgo } });
    const young = await seedRealPhoto({ ownerId, collectionId });
    await prisma.photo.update({ where: { id: young.id }, data: { deletedAt: sixDaysAgo } });

    const result1 = await runTrashPurgeJob();
    expect(result1.photosPurged).toBeGreaterThanOrEqual(1);

    expect(await prisma.photo.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await minioObjectExists(old.s3Key)).toBe(false);
    const youngRow = await prisma.photo.findUnique({ where: { id: young.id } });
    expect(youngRow).not.toBeNull();
    expect(youngRow?.deletedAt).not.toBeNull();

    // Run again — idempotent, no error, no double-effect (old is already
    // gone; a second pass is a pure no-op for it).
    await expect(runTrashPurgeJob()).resolves.not.toThrow();
    expect(await prisma.photo.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it("purges an 8-day-old trashed FOLDER, cascading to hard-delete its photos too (T5), never touching photoCount", async () => {
    if (skipInfra()) return;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const folder = await prisma.folder.create({
      data: {
        collectionId,
        name: `job-cascade-${stamp}`,
        categoryType: "custom",
        photoCount: 2,
        deletedAt: eightDaysAgo,
      },
    });
    const p1 = await seedRealPhoto({ ownerId, collectionId, folderId: folder.id });
    const p2 = await seedRealPhoto({ ownerId, collectionId, folderId: folder.id });

    await runTrashPurgeJob();

    expect(await prisma.folder.findUnique({ where: { id: folder.id } })).toBeNull();
    expect(await prisma.photo.findUnique({ where: { id: p1.id } })).toBeNull();
    expect(await prisma.photo.findUnique({ where: { id: p2.id } })).toBeNull();
    expect(await minioObjectExists(p1.s3Key)).toBe(false);
    expect(await minioObjectExists(p2.s3Key)).toBe(false);

    // Idempotent re-run.
    await expect(runTrashPurgeJob()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// #20 leak: GET /api/folders/:id/download-all must exclude a soft-deleted
// photo even though its aiClassificationStatus is still 'done'.
// ---------------------------------------------------------------------------
describe("#20 leak fix — GET /api/folders/:id/download-all excludes trashed photos", () => {
  it("a soft-deleted photo in an otherwise-live folder is NOT in the zip", async () => {
    if (skipInfra()) return;
    const folder = await prisma.folder.create({
      data: { collectionId, name: `zip-leak-${stamp}`, categoryType: "custom", photoCount: 2 },
    });
    const keep = await seedRealPhoto({ ownerId, collectionId, folderId: folder.id });
    const trashed = await seedRealPhoto({ ownerId, collectionId, folderId: folder.id });
    await request(app).delete(`/api/photos/${trashed.id}`).set("Cookie", ownerCookie);

    const res = await request(app)
      .get(`/api/folders/${folder.id}/download-all`)
      .set("Cookie", ownerCookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    // Leak check: the trashed photo's filename must not appear as a zip entry.
    expect(body.includes(Buffer.from(trashed.id))).toBe(false);
    expect(body.length).toBeGreaterThan(0);
    expect(keep.id).toBeTruthy();
  });

  it("a fully trashed folder 404s on download-all (not a leaky empty/400)", async () => {
    if (skipInfra()) return;
    const folder = await prisma.folder.create({
      data: { collectionId, name: `zip-leak-folder-${stamp}`, categoryType: "custom", photoCount: 1 },
    });
    await seedRealPhoto({ ownerId, collectionId, folderId: folder.id });
    await request(app).delete(`/api/folders/${folder.id}`).set("Cookie", ownerCookie);

    const res = await request(app).get(`/api/folders/${folder.id}/download-all`).set("Cookie", ownerCookie);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// A sample of the 21-path listing-query audit — beyond what's exercised above.
// ---------------------------------------------------------------------------
describe("Listing-query audit — additional sample coverage", () => {
  it("GET /api/photos/unfiled excludes a trashed unfiled photo (#1)", async () => {
    if (skipInfra()) return;
    const p = await prisma.photo.create({
      data: {
        ownerId,
        s3Key: `seed/${ownerId}/unfiled-trashed.jpg`,
        originalFilename: "unfiled-trashed.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
        aiClassificationStatus: "done",
      },
    });
    await request(app).delete(`/api/photos/${p.id}`).set("Cookie", ownerCookie);
    const res = await request(app).get("/api/photos/unfiled").set("Cookie", ownerCookie);
    expect(res.body.photos.map((x: { id: string }) => x.id)).not.toContain(p.id);
  });

  it("GET /api/search excludes a trashed photo and a trashed folder's photos (#14)", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `search-audit-${stamp}`, photos: 1 });
    const search1 = await request(app)
      .get("/api/search")
      .set("Cookie", ownerCookie)
      .query({ folderId: f.id });
    expect(search1.body.photos.map((x: { id: string }) => x.id)).toContain(f.photoIds[0]);

    await request(app).delete(`/api/folders/${f.id}`).set("Cookie", ownerCookie);
    const search2 = await request(app).get("/api/search").set("Cookie", ownerCookie).query({ folderId: f.id });
    expect(search2.status).toBe(404); // trashed folder → 404, matches #4/#7's pattern
  });

  it("GET /api/guest/folders excludes a trashed folder even with a live, never-revoked permission (#15)", async () => {
    if (skipInfra()) return;
    const f = await seedFolder({ collectionId, ownerId, name: `guest-audit-${stamp}`, photos: 1 });
    const guestId = await seedLiveShare(f.id, ownerId);
    // Mint a guest session directly (bypassing the OTP flow) for a scoped read check.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await prisma.guestSession.create({
      data: { guestUserId: guestId, tokenHash, expiresAt: new Date(Date.now() + 60_000) },
    });

    const before = await request(app).get("/api/guest/folders").set("Cookie", `photosphere_guest_session=${rawToken}`);
    expect(before.body.folders.map((x: { id: string }) => x.id)).toContain(f.id);

    // F1 blocks a normal DELETE while the share is live (by design, unchanged
    // — this exact scenario cannot happen via the API in practice). Seed the
    // trashed state directly to exercise the #15 guest-view exclusion itself,
    // simulating "the owner's F1 guard was bypassable in some other way, or
    // the permission just wasn't revoked" — the guest-view guarantee must
    // hold regardless of HOW the folder ended up trashed.
    await prisma.folder.update({ where: { id: f.id }, data: { deletedAt: new Date() } });

    const after = await request(app).get("/api/guest/folders").set("Cookie", `photosphere_guest_session=${rawToken}`);
    expect(after.body.folders.map((x: { id: string }) => x.id)).not.toContain(f.id);
  });

  it("GET /api/dashboard excludes trashed photos/folders from totals (#21)", async () => {
    if (skipInfra()) return;
    const before = await request(app).get("/api/dashboard").set("Cookie", ownerCookie);
    const beforeCount = before.body.totals.photoCount;

    const f = await seedFolder({ collectionId, ownerId, name: `dash-audit-${stamp}`, photos: 1 });
    const afterCreate = await request(app).get("/api/dashboard").set("Cookie", ownerCookie);
    expect(afterCreate.body.totals.photoCount).toBe(beforeCount + 1);

    await request(app).delete(`/api/photos/${f.photoIds[0]}`).set("Cookie", ownerCookie);
    const afterDelete = await request(app).get("/api/dashboard").set("Cookie", ownerCookie);
    expect(afterDelete.body.totals.photoCount).toBe(beforeCount);
  });
});
