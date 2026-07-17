import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { ensureBucketExists } from "../lib/storage";
import { GUEST_SESSION_COOKIE_NAME } from "../lib/guestSession";
import { __setAuditInsertForTest, logAudit } from "../lib/audit";

// Integration tests for specs/audit-and-polish.md Part A (audit log). Follows
// the skip-not-fake convention of guest-access.smoke.test.ts: DB/MinIO tests
// skip with a warning when infra is unreachable; worker-dependent assertions
// (needing a photo to reach 'done' in a real folder) additionally skip when a
// probe upload never reaches a terminal state. Covers the spec's acceptance
// criteria: each of the 7 actions writes exactly one correct row; a view-only
// /download 403 and any 404 write NO row; owner-scoping is leak-proof (two
// owners, zero cross-owner rows either direction); filters; 401; and a forced
// audit-write failure does NOT break the primary action.

const app = createApp();
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures");
const fixture = (name: string) => path.join(FIXTURES_DIR, name);

const stamp = Date.now();
const ownerAEmail = `audit-owner-a-${stamp}@example.com`;
const ownerBEmail = `audit-owner-b-${stamp}@example.com`;
const password = "correct-password-123";

let infraAvailable = true;
let workerAvailable = false;
let ownerACookie: string;
let ownerAId: string;
let ownerBCookie: string;
let ownerBId: string;
let sharedFolderId: string; // owner A's folder, shared to guests
let ownerBFolderId: string; // owner B's folder, shared to owner B's guests

const POLL_INTERVAL_MS = 400;

async function waitForTerminal(photoId: string, timeoutMs: number, cookie: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/photos/${photoId}/status`).set("Cookie", cookie);
    if (["done", "failed", "duplicate"].includes(res.body.status)) return res.body;
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

async function uploadAndClassify(cookie: string, fixtureName: string, filename: string) {
  const buffer = fs.readFileSync(fixture(fixtureName));
  const res = await request(app)
    .post("/api/photos/upload")
    .set("Cookie", cookie)
    .attach("file", buffer, { filename, contentType: "image/jpeg" });
  if (res.status !== 202) return null;
  const terminal = await waitForTerminal(res.body.photoId, 20_000, cookie);
  if (terminal?.status !== "done") return null;
  return { photoId: res.body.photoId as string, folderId: terminal.folderId as string };
}

// Give the fire-and-forget audit insert a beat to land before asserting.
async function settle(ms = 350) {
  await new Promise((r) => setTimeout(r, ms));
}

// Count/fetch this owner's audit rows for a specific resource + action.
async function auditRows(ownerId: string, action: string, resourceId?: string) {
  return prisma.auditLog.findMany({
    where: { ownerId, action, ...(resourceId ? { resourceId } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

// Run the full share -> request -> approve -> view -> download flow and return
// the ids involved, so assertions can check the exact audit rows written.
async function runFullFlow(opts: { level: "view" | "download"; guestEmailTag: string }) {
  const share = await request(app)
    .post("/api/guests")
    .set("Cookie", ownerACookie)
    .send({
      guestEmail: `${opts.guestEmailTag}-${stamp}@example.com`,
      folderIds: [sharedFolderId],
      permissionLevel: opts.level,
    });
  const rawInvite = share.body.inviteToken as string;
  const guestId = share.body.guestId as string;

  const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
  const requestId = reqRes.body.requestId as string;
  const otp = (await request(app).get(`/api/invites/requests/${requestId}/otp`)).body.otp as string;

  const approve = await request(app)
    .post(`/api/access-requests/${requestId}/approve`)
    .set("Cookie", ownerACookie)
    .send({ otp });
  expect(approve.status).toBe(200);

  const poll = await request(app).get(`/api/invites/requests/${requestId}/status`);
  const guestCookie = (poll.headers["set-cookie"] as unknown as string[]).find((c) =>
    c.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`),
  )!;

  const photosRes = await request(app)
    .get(`/api/guest/folders/${sharedFolderId}/photos`)
    .set("Cookie", guestCookie);
  const photoId = photosRes.body.photos[0].id as string;

  return { guestId, requestId, guestCookie, photoId, share, approve };
}

beforeAll(async () => {
  try {
    await prisma.$connect();
    await ensureBucketExists();
  } catch {
    infraAvailable = false;
    return;
  }

  const a = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerAEmail, password, name: "Audit Owner A" });
  ownerACookie = a.headers["set-cookie"][0];
  ownerAId = a.body.user.id;

  const b = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerBEmail, password, name: "Audit Owner B" });
  ownerBCookie = b.headers["set-cookie"][0];
  ownerBId = b.body.user.id;

  const probe = await uploadAndClassify(ownerACookie, "fixture-people.jpg", `audit-probe-${stamp}.jpg`);
  workerAvailable = probe != null;
  if (probe) sharedFolderId = probe.folderId;

  if (workerAvailable) {
    const bPhoto = await uploadAndClassify(ownerBCookie, "fixture-nature.jpg", `audit-b-${stamp}.jpg`);
    ownerBFolderId = bPhoto?.folderId ?? "";
  }
}, 90_000);

afterAll(async () => {
  if (infraAvailable) {
    await prisma.auditLog.deleteMany({ where: { ownerId: { in: [ownerAId, ownerBId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [ownerAEmail, ownerBEmail] } } });
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// A2/A3 — each of the 7 actions writes exactly one correct row
// ---------------------------------------------------------------------------
describe("audit hooks — the 7 access-surface actions", () => {
  it("share_created / access_requested / access_approved / photo_viewed / photo_downloaded / guest_revoked each write exactly one correct row", async () => {
    if (skipWorker()) return;

    const flow = await runFullFlow({ level: "download", guestEmailTag: "flow" });
    await settle();

    // share_created (owner actor)
    const created = await auditRows(ownerAId, "share_created", flow.guestId);
    expect(created.length).toBe(1);
    expect(created[0].actorType).toBe("owner");
    expect(created[0].actorId).toBe(ownerAId);
    expect(created[0].resourceType).toBe("guest");
    const cmeta = created[0].metadata as Record<string, unknown>;
    expect(cmeta.permissionLevel).toBe("download");
    expect(Array.isArray(cmeta.folderNames)).toBe(true);
    expect((cmeta.folderNames as string[]).length).toBeGreaterThan(0);

    // access_requested (guest actor, with captured IP)
    const requested = await auditRows(ownerAId, "access_requested", flow.requestId);
    expect(requested.length).toBe(1);
    expect(requested[0].actorType).toBe("guest");
    expect(requested[0].actorId).toBe(flow.guestId);
    // IP is captured (supertest sends from a loopback addr).
    expect(requested[0].ipAddress).toBeTruthy();

    // access_approved (owner actor)
    const approved = await auditRows(ownerAId, "access_approved", flow.requestId);
    expect(approved.length).toBe(1);
    expect(approved[0].actorType).toBe("owner");

    // Guest views a photo -> exactly one photo_viewed row.
    const view = await request(app).get(`/api/guest/photos/${flow.photoId}`).set("Cookie", flow.guestCookie);
    expect(view.status).toBe(200);
    await settle();
    const viewed = await auditRows(ownerAId, "photo_viewed", flow.photoId);
    expect(viewed.length).toBe(1);
    expect(viewed[0].actorType).toBe("guest");
    expect(viewed[0].actorId).toBe(flow.guestId);
    expect((viewed[0].metadata as Record<string, unknown>).folderId).toBe(sharedFolderId);

    // Guest downloads -> exactly one photo_downloaded row.
    const dl = await request(app)
      .get(`/api/guest/photos/${flow.photoId}/download`)
      .set("Cookie", flow.guestCookie);
    expect(dl.status).toBe(200);
    await settle();
    const downloaded = await auditRows(ownerAId, "photo_downloaded", flow.photoId);
    expect(downloaded.length).toBe(1);
    expect(downloaded[0].actorType).toBe("guest");

    // Owner revokes -> exactly one guest_revoked row.
    const del = await request(app).delete(`/api/guests/${flow.guestId}`).set("Cookie", ownerACookie);
    expect(del.status).toBe(200);
    await settle();
    const revoked = await auditRows(ownerAId, "guest_revoked", flow.guestId);
    expect(revoked.length).toBe(1);
    expect(revoked[0].actorType).toBe("owner");
  }, 90_000);

  it("explicit deny writes access_denied reason=owner_denied", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerACookie)
      .send({ guestEmail: `deny-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = reqRes.body.requestId as string;

    const deny = await request(app)
      .post(`/api/access-requests/${requestId}/deny`)
      .set("Cookie", ownerACookie);
    expect(deny.status).toBe(200);
    await settle();

    const denied = await auditRows(ownerAId, "access_denied", requestId);
    expect(denied.length).toBe(1);
    expect((denied[0].metadata as Record<string, unknown>).reason).toBe("owner_denied");
  }, 45_000);

  it("3 wrong OTPs writes access_denied reason=otp_attempts_exceeded (auto-deny)", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerACookie)
      .send({ guestEmail: `cap-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = reqRes.body.requestId as string;

    for (let i = 1; i <= 3; i++) {
      await request(app)
        .post(`/api/access-requests/${requestId}/approve`)
        .set("Cookie", ownerACookie)
        .send({ otp: "000000" });
    }
    await settle();

    const denied = await auditRows(ownerAId, "access_denied", requestId);
    expect(denied.length).toBe(1); // exactly one (only the 3rd wrong auto-deny logs)
    expect((denied[0].metadata as Record<string, unknown>).reason).toBe("otp_attempts_exceeded");
  }, 45_000);
});

// ---------------------------------------------------------------------------
// A2/A3 — a view-only /download 403 and any 404 write NO row
// ---------------------------------------------------------------------------
describe("audit hooks — refused/missing accesses write NO row", () => {
  it("a view-only /download 403 writes NO photo_downloaded row", async () => {
    if (skipWorker()) return;
    const flow = await runFullFlow({ level: "view", guestEmailTag: "viewonly" });

    const before = await auditRows(ownerAId, "photo_downloaded", flow.photoId);
    const dl = await request(app)
      .get(`/api/guest/photos/${flow.photoId}/download`)
      .set("Cookie", flow.guestCookie);
    expect(dl.status).toBe(403);
    await settle();
    const after = await auditRows(ownerAId, "photo_downloaded", flow.photoId);
    expect(after.length).toBe(before.length); // no new download row
  }, 90_000);

  it("a 404 (photo not permitted) writes NO photo_viewed / photo_downloaded row", async () => {
    if (skipWorker()) return;
    const flow = await runFullFlow({ level: "download", guestEmailTag: "notfound" });
    const bogusPhotoId = crypto.randomUUID();

    const viewedBefore = (await auditRows(ownerAId, "photo_viewed", bogusPhotoId)).length;
    const dlBefore = (await auditRows(ownerAId, "photo_downloaded", bogusPhotoId)).length;

    const view404 = await request(app).get(`/api/guest/photos/${bogusPhotoId}`).set("Cookie", flow.guestCookie);
    expect(view404.status).toBe(404);
    const dl404 = await request(app)
      .get(`/api/guest/photos/${bogusPhotoId}/download`)
      .set("Cookie", flow.guestCookie);
    expect(dl404.status).toBe(404);
    await settle();

    expect((await auditRows(ownerAId, "photo_viewed", bogusPhotoId)).length).toBe(viewedBefore);
    expect((await auditRows(ownerAId, "photo_downloaded", bogusPhotoId)).length).toBe(dlBefore);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// A4 — GET /api/audit: owner-scoped, leak-proof, paginated, filtered, 401
// ---------------------------------------------------------------------------
describe("GET /api/audit", () => {
  it("401 without a session", async () => {
    const res = await request(app).get("/api/audit");
    expect(res.status).toBe(401);
  });

  it("400 on an invalid action / date filter (Zod)", async () => {
    if (skipInfra()) return;
    const badAction = await request(app).get("/api/audit?action=not_a_real_action").set("Cookie", ownerACookie);
    expect(badAction.status).toBe(400);
    const badDate = await request(app).get("/api/audit?from=not-a-date").set("Cookie", ownerACookie);
    expect(badDate.status).toBe(400);
  });

  it("returns this owner's trail newest-first with entries/total/limit/offset", async () => {
    if (skipWorker()) return;
    const res = await request(app).get("/api/audit?limit=100").set("Cookie", ownerACookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(typeof res.body.total).toBe("number");
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    // newest-first
    const times = res.body.entries.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    // Contains BOTH owner-actor (share_created) and guest-actor (photo_viewed) rows.
    const actions = new Set(res.body.entries.map((e: { action: string }) => e.action));
    expect(actions.has("share_created")).toBe(true);
    expect(actions.has("photo_viewed")).toBe(true);
  }, 90_000);

  it("owner-scoping is LEAK-PROOF — B never sees A's rows, and vice versa", async () => {
    if (skipWorker()) return;
    // Seed a share under owner B so B has its own trail.
    if (ownerBFolderId) {
      await request(app)
        .post("/api/guests")
        .set("Cookie", ownerBCookie)
        .send({ guestEmail: `bguest-${stamp}@example.com`, folderIds: [ownerBFolderId], permissionLevel: "view" });
      await settle();
    }

    const aTrail = await request(app).get("/api/audit?limit=100").set("Cookie", ownerACookie);
    const bTrail = await request(app).get("/api/audit?limit=100").set("Cookie", ownerBCookie);
    expect(aTrail.status).toBe(200);
    expect(bTrail.status).toBe(200);

    // Every row A sees is owned by A; none by B.
    for (const e of aTrail.body.entries) {
      const row = await prisma.auditLog.findUnique({ where: { id: e.id } });
      expect(row?.ownerId).toBe(ownerAId);
    }
    // Every row B sees is owned by B; none by A. (Zero cross-owner either way.)
    for (const e of bTrail.body.entries) {
      const row = await prisma.auditLog.findUnique({ where: { id: e.id } });
      expect(row?.ownerId).toBe(ownerBId);
    }
    // Cross-check via ids: no id appears in both trails.
    const aIds = new Set(aTrail.body.entries.map((e: { id: string }) => e.id));
    for (const e of bTrail.body.entries) expect(aIds.has(e.id)).toBe(false);
  }, 90_000);

  it("?action=photo_downloaded returns only downloads; ?actorType=guest only guest rows", async () => {
    if (skipWorker()) return;
    const dls = await request(app).get("/api/audit?action=photo_downloaded&limit=100").set("Cookie", ownerACookie);
    expect(dls.status).toBe(200);
    expect(dls.body.entries.length).toBeGreaterThan(0);
    expect(dls.body.entries.every((e: { action: string }) => e.action === "photo_downloaded")).toBe(true);

    const guestRows = await request(app).get("/api/audit?actorType=guest&limit=100").set("Cookie", ownerACookie);
    expect(guestRows.status).toBe(200);
    expect(guestRows.body.entries.every((e: { actorType: string }) => e.actorType === "guest")).toBe(true);
  }, 90_000);

  it("?from/?to bound the date range", async () => {
    if (skipWorker()) return;
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fromFuture = await request(app).get(`/api/audit?from=${future}&limit=100`).set("Cookie", ownerACookie);
    expect(fromFuture.status).toBe(200);
    expect(fromFuture.body.entries.length).toBe(0); // nothing after "now + 1h"

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fromPast = await request(app).get(`/api/audit?from=${past}&limit=100`).set("Cookie", ownerACookie);
    expect(fromPast.status).toBe(200);
    expect(fromPast.body.entries.length).toBeGreaterThan(0);
  }, 90_000);

  it("has NO PATCH/DELETE and NO GET /api/audit/:id (append-only, list-only)", async () => {
    if (skipInfra()) return;
    const someId = crypto.randomUUID();
    const patch = await request(app).patch(`/api/audit/${someId}`).set("Cookie", ownerACookie);
    const del = await request(app).delete(`/api/audit/${someId}`).set("Cookie", ownerACookie);
    const getOne = await request(app).get(`/api/audit/${someId}`).set("Cookie", ownerACookie);
    // No such routes are mounted -> 404 (Express default), never 200.
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
    expect(getOne.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// A3 — a forced audit-write failure does NOT break the primary action
// ---------------------------------------------------------------------------
describe("audit is fire-and-forget — a failed write never breaks the primary action", () => {
  it("logAudit swallows an insert error and does not throw", async () => {
    const restore = __setAuditInsertForTest(async () => {
      throw new Error("simulated audit insert failure");
    });
    try {
      // Must not throw synchronously; returns void.
      expect(() => logAudit({ actorType: "owner", actorId: "x", ownerId: "y", action: "share_created" })).not.toThrow();
      // Let the rejected background insert settle (it is caught-and-swallowed).
      await settle(100);
    } finally {
      restore();
    }
  });

  it("an approval STILL succeeds even when the audit insert is forced to fail", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerACookie)
      .send({ guestEmail: `failaudit-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "download" });
    const rawInvite = share.body.inviteToken as string;
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = reqRes.body.requestId as string;
    const otp = (await request(app).get(`/api/invites/requests/${requestId}/otp`)).body.otp as string;

    // Force every audit insert to fail for the duration of the approval.
    const restore = __setAuditInsertForTest(async () => {
      throw new Error("simulated audit insert failure");
    });
    let approve;
    try {
      approve = await request(app)
        .post(`/api/access-requests/${requestId}/approve`)
        .set("Cookie", ownerACookie)
        .send({ otp });
    } finally {
      restore();
    }
    // Primary action succeeded despite the failing audit write.
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("approved");
    // The request really flipped to approved in the DB (not rolled back).
    const row = await prisma.accessRequest.findUnique({ where: { id: requestId } });
    expect(row?.status).toBe("approved");

    // And a guest download STILL returns its pre-signed URL under a forced audit failure.
    const poll = await request(app).get(`/api/invites/requests/${requestId}/status`);
    const guestCookie = (poll.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`),
    )!;
    const photosRes = await request(app)
      .get(`/api/guest/folders/${sharedFolderId}/photos`)
      .set("Cookie", guestCookie);
    const photoId = photosRes.body.photos[0].id as string;

    const restore2 = __setAuditInsertForTest(async () => {
      throw new Error("simulated audit insert failure");
    });
    let dl;
    try {
      dl = await request(app).get(`/api/guest/photos/${photoId}/download`).set("Cookie", guestCookie);
    } finally {
      restore2();
    }
    expect(dl.status).toBe(200);
    expect(dl.body.download.url).toContain("X-Amz-");
  }, 90_000);
});

if (!fs.existsSync(fixture("fixture-people.jpg"))) {
  throw new Error(`Missing test fixture: ${fixture("fixture-people.jpg")}`);
}
