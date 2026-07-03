import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { ensureBucketExists } from "../lib/storage";
import { GUEST_SESSION_COOKIE_NAME } from "../lib/guestSession";

// Integration tests for specs/guest-access-otp.md (backend core). Follows the
// skip-not-fake convention of dashboard.smoke.test.ts / classification.smoke:
// DB/MinIO-dependent tests skip with a warning when infra is unreachable;
// worker-dependent assertions (needing a photo to reach a terminal 'done'
// state and land in a real folder) additionally skip when a probe upload
// doesn't reach a terminal state in time. Security-critical acceptance
// criteria are all covered here (OTP cap/expiry/single-use, cross-scope
// leakage, revocation, 404-not-403, guest-session 401s).

const app = createApp();
const FIXTURES_DIR = path.resolve(__dirname, "../../test/fixtures");
const fixture = (name: string) => path.join(FIXTURES_DIR, name);

const stamp = Date.now();
const ownerEmail = `guest-owner-${stamp}@example.com`;
const otherOwnerEmail = `guest-other-owner-${stamp}@example.com`;
const password = "correct-password-123";

let infraAvailable = true;
let workerAvailable = false;
let ownerCookie: string;
let ownerId: string;
let otherCookie: string;

// Folders the owner will end up with (populated after uploads classify).
let sharedFolderId: string; // shared with the guest
let unsharedFolderId: string; // owner owns but does NOT share (control)
let otherOwnerFolderId: string; // a different owner's folder (control)

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

// Upload distinct fixtures until we have at least two DONE photos in distinct
// real folders, returning their folder ids. Distinct fixtures classify into
// distinct categories deterministically (see fixtures README).
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
    .send({ email: ownerEmail, password, name: "Guest Owner" });
  ownerCookie = ownerSignup.headers["set-cookie"][0];
  ownerId = ownerSignup.body.user.id;

  const otherSignup = await request(app)
    .post("/api/auth/signup")
    .send({ email: otherOwnerEmail, password, name: "Other Owner" });
  otherCookie = otherSignup.headers["set-cookie"][0];

  // Probe upload to detect a live worker.
  const probe = await uploadAndClassify(ownerCookie, "fixture-people.jpg", `probe-${stamp}.jpg`);
  workerAvailable = probe != null;
  if (probe) sharedFolderId = probe.folderId;

  if (workerAvailable) {
    // Second distinct folder for the owner (control: owned but NOT shared).
    const second = await uploadAndClassify(ownerCookie, "fixture-food.jpg", `unshared-${stamp}.jpg`);
    if (second && second.folderId !== sharedFolderId) {
      unsharedFolderId = second.folderId;
    } else {
      // Fall back: try another category so we get a distinct folder.
      const third = await uploadAndClassify(ownerCookie, "fixture-vehicles.jpg", `unshared2-${stamp}.jpg`);
      unsharedFolderId = third?.folderId ?? sharedFolderId;
    }

    // A completely different owner's folder (control for cross-owner 404).
    const otherPhoto = await uploadAndClassify(otherCookie, "fixture-nature.jpg", `other-${stamp}.jpg`);
    otherOwnerFolderId = otherPhoto?.folderId ?? "";
  }
}, 90_000);

afterAll(async () => {
  if (infraAvailable) {
    await prisma.user.deleteMany({ where: { email: { in: [ownerEmail, otherOwnerEmail] } } });
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// Share creation (owner)
// ---------------------------------------------------------------------------
describe("POST /api/guests — share creation", () => {
  it("401 without a session", async () => {
    const res = await request(app)
      .post("/api/guests")
      .send({ guestEmail: "g@example.com", folderIds: ["x"], permissionLevel: "view" });
    expect(res.status).toBe(401);
  });

  it("400 on invalid body (empty folderIds / bad level / bad email)", async () => {
    if (skipInfra()) return;
    const bad1 = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: "g@example.com", folderIds: [], permissionLevel: "view" });
    expect(bad1.status).toBe(400);

    const bad2 = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: "g@example.com", folderIds: [crypto.randomUUID()], permissionLevel: "owner" });
    expect(bad2.status).toBe(400);

    const bad3 = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: "not-an-email", folderIds: [crypto.randomUUID()], permissionLevel: "view" });
    expect(bad3.status).toBe(400);
  });

  it("404 and creates NOTHING when a folderId isn't owned by the caller", async () => {
    if (skipWorker()) return;
    const guestsBefore = await prisma.guestUser.count({ where: { createdBy: ownerId } });
    const res = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({
        guestEmail: `noleak-${stamp}@example.com`,
        folderIds: [sharedFolderId, otherOwnerFolderId], // one is a foreign folder
        permissionLevel: "view",
      });
    expect(res.status).toBe(404);
    const guestsAfter = await prisma.guestUser.count({ where: { createdBy: ownerId } });
    expect(guestsAfter).toBe(guestsBefore); // no partial guest created
    // And no stray permission on the foreign folder.
    const leaked = await prisma.folderPermission.count({ where: { folderId: otherOwnerFolderId } });
    expect(leaked).toBe(0);
  });

  it("201 with a raw invite token; stores only the SHA-256 hash; one permission per folder", async () => {
    if (skipWorker()) return;
    const res = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({
        guestEmail: `ok-${stamp}@example.com`,
        guestName: "Client A",
        folderIds: [sharedFolderId],
        permissionLevel: "download",
        expiresInDays: 7,
      });
    expect(res.status).toBe(201);
    expect(typeof res.body.inviteToken).toBe("string");
    expect(res.body.inviteToken.length).toBe(64); // 32 bytes hex
    expect(res.body.inviteUrl).toContain(res.body.inviteToken);

    const guest = await prisma.guestUser.findUnique({ where: { id: res.body.guestId } });
    expect(guest?.createdBy).toBe(ownerId);

    // Raw token NEVER persisted — only its hash.
    const rows = await prisma.inviteToken.findMany({ where: { guestUserId: res.body.guestId } });
    expect(rows.length).toBe(1);
    expect(rows[0].tokenHash).not.toBe(res.body.inviteToken);
    expect(rows[0].tokenHash.length).toBe(64); // sha256 hex
    expect(rows[0].maxUses).toBe(1); // decision G6

    const perms = await prisma.folderPermission.findMany({ where: { guestUserId: res.body.guestId } });
    expect(perms.length).toBe(1);
    expect(perms[0].folderId).toBe(sharedFolderId);
    expect(perms[0].permissionLevel).toBe("download");
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow: request -> OTP -> approve -> scoped portal -> revoke
// ---------------------------------------------------------------------------
describe("full guest flow (request, OTP, approve, scope, revoke)", () => {
  it("runs the whole success-signal flow end-to-end", async () => {
    if (skipWorker()) return;

    // Owner shares the shared folder (download) but NOT the unshared control.
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({
        guestEmail: `flow-${stamp}@example.com`,
        folderIds: [sharedFolderId],
        permissionLevel: "download",
        expiresInDays: 7,
      });
    expect(share.status).toBe(201);
    const rawInvite = share.body.inviteToken as string;
    const guestId = share.body.guestId as string;

    // Guest requests access — no OTP in the response body.
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.status).toBe("pending");
    expect(reqRes.body.requestId).toBeTruthy();
    expect(JSON.stringify(reqRes.body)).not.toMatch(/\botp\b/i);
    const requestId = reqRes.body.requestId as string;

    // The pending access_request exists, captured IP + UA, otp is HASHED.
    const arRow = await prisma.accessRequest.findUnique({ where: { id: requestId } });
    expect(arRow?.status).toBe("pending");
    expect(arRow?.otpHash?.length).toBe(64);
    expect(arRow?.otpExpiresAt).toBeTruthy();

    // Tester-visibility surface exposes the plaintext OTP (test flag only).
    const otpRes = await request(app).get(`/api/invites/requests/${requestId}/otp`);
    expect(otpRes.status).toBe(200);
    const otp = otpRes.body.otp as string;
    expect(otp).toMatch(/^\d{6}$/);
    // The stored hash is the SHA-256 of that exact plaintext.
    const expectedHash = crypto.createHash("sha256").update(otp).digest("hex");
    expect(arRow?.otpHash).toBe(expectedHash);

    // Owner approves with the correct OTP.
    const approve = await request(app)
      .post(`/api/access-requests/${requestId}/approve`)
      .set("Cookie", ownerCookie)
      .send({ otp });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("approved");
    // Raw guest token is NOT handed to the owner (G7).
    expect(JSON.stringify(approve.body)).not.toMatch(/[a-f0-9]{64}/);

    // OTP is single-use — a replay of the same code now fails.
    const replay = await request(app)
      .post(`/api/access-requests/${requestId}/approve`)
      .set("Cookie", ownerCookie)
      .send({ otp });
    expect([401, 409]).toContain(replay.status);

    // Guest polls status -> approved, and the guest cookie is set on THIS response (G7).
    const poll = await request(app).get(`/api/invites/requests/${requestId}/status`);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe("approved");
    const setCookie = poll.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const guestCookie = (setCookie as unknown as string[]).find((c) =>
      c.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`),
    )!;
    expect(guestCookie).toBeTruthy();
    // The raw guest token in the cookie is NOT a JWT (no dots-delimited segments).
    const cookieVal = guestCookie.split(";")[0].split("=")[1];
    expect(cookieVal.split(".").length).toBe(1);

    // Guest session persisted as a HASH only.
    const sess = await prisma.guestSession.findMany({ where: { guestUserId: guestId } });
    expect(sess.length).toBe(1);
    expect(sess[0].tokenHash).not.toBe(cookieVal);

    // Guest lists ONLY the shared folder — the unshared control is absent.
    const foldersRes = await request(app).get("/api/guest/folders").set("Cookie", guestCookie);
    expect(foldersRes.status).toBe(200);
    const ids = foldersRes.body.folders.map((f: { id: string }) => f.id);
    expect(ids).toContain(sharedFolderId);
    if (unsharedFolderId && unsharedFolderId !== sharedFolderId) {
      expect(ids).not.toContain(unsharedFolderId);
    }

    // Photos in the shared folder come back as 60s pre-signed URLs, never raw keys.
    const photosRes = await request(app)
      .get(`/api/guest/folders/${sharedFolderId}/photos`)
      .set("Cookie", guestCookie);
    expect(photosRes.status).toBe(200);
    expect(photosRes.body.photos.length).toBeGreaterThan(0);
    const card = photosRes.body.photos[0];
    if (card.thumbnailUrl) {
      expect(card.thumbnailUrl).toMatch(/^https?:\/\//);
      expect(card.thumbnailUrl).toContain("X-Amz-"); // signed URL query params
    }

    // Photo detail: 60s pre-signed original + thumbnails.
    const photoId = card.id as string;
    const detail = await request(app).get(`/api/guest/photos/${photoId}`).set("Cookie", guestCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.original.url).toMatch(/^https?:\/\//);
    expect(detail.body.original.url).toContain("X-Amz-");
    expect(detail.body.original.expiresInSeconds).toBe(60);

    // Download allowed (permission is download).
    const dl = await request(app)
      .get(`/api/guest/photos/${photoId}/download`)
      .set("Cookie", guestCookie);
    expect(dl.status).toBe(200);
    expect(dl.body.download.url).toContain("X-Amz-");

    // Cross-scope leakage: a folder the owner owns but did NOT share -> 404.
    if (unsharedFolderId && unsharedFolderId !== sharedFolderId) {
      const denied = await request(app)
        .get(`/api/guest/folders/${unsharedFolderId}/photos`)
        .set("Cookie", guestCookie);
      expect(denied.status).toBe(404);
    }

    // A completely different owner's photo -> 404.
    if (otherOwnerFolderId) {
      const otherPhotos = await prisma.photo.findMany({
        where: { folderId: otherOwnerFolderId },
        take: 1,
      });
      if (otherPhotos[0]) {
        const foreign = await request(app)
          .get(`/api/guest/photos/${otherPhotos[0].id}`)
          .set("Cookie", guestCookie);
        expect(foreign.status).toBe(404);
      }
    }

    // Owner revokes -> guest's very next request is 401.
    const del = await request(app).delete(`/api/guests/${guestId}`).set("Cookie", ownerCookie);
    expect(del.status).toBe(200);

    const afterRevoke = await request(app).get("/api/guest/folders").set("Cookie", guestCookie);
    expect(afterRevoke.status).toBe(401);

    // Permissions revoked, invite deactivated, sessions revoked.
    const permsAfter = await prisma.folderPermission.findMany({ where: { guestUserId: guestId } });
    expect(permsAfter.every((p) => p.revokedAt != null)).toBe(true);
    const inviteAfter = await prisma.inviteToken.findFirst({ where: { guestUserId: guestId } });
    expect(inviteAfter?.isActive).toBe(false);
    const sessAfter = await prisma.guestSession.findMany({ where: { guestUserId: guestId } });
    expect(sessAfter.every((s) => s.revokedAt != null)).toBe(true);

    // A fresh invite-request with the same (now-deactivated) token -> 404.
    const reRequest = await request(app).post(`/api/invites/${rawInvite}/request`);
    expect(reRequest.status).toBe(404);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// OTP security: wrong-attempt cap, expiry
// ---------------------------------------------------------------------------
describe("OTP security gate", () => {
  it("3 wrong attempts auto-denies the request", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `cap-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = reqRes.body.requestId as string;

    for (let i = 1; i <= 2; i++) {
      const wrong = await request(app)
        .post(`/api/access-requests/${requestId}/approve`)
        .set("Cookie", ownerCookie)
        .send({ otp: "000000" });
      expect(wrong.status).toBe(401);
      const row = await prisma.accessRequest.findUnique({ where: { id: requestId } });
      expect(row?.otpAttempts).toBe(i);
      expect(row?.status).toBe("pending");
    }

    // 3rd wrong -> auto-deny (403), status denied, otpHash cleared.
    const third = await request(app)
      .post(`/api/access-requests/${requestId}/approve`)
      .set("Cookie", ownerCookie)
      .send({ otp: "000000" });
    expect(third.status).toBe(403);
    const denied = await prisma.accessRequest.findUnique({ where: { id: requestId } });
    expect(denied?.status).toBe("denied");
    expect(denied?.otpHash).toBeNull();

    // Even the correct code now fails (auto-denied).
    const otpRes = await request(app).get(`/api/invites/requests/${requestId}/otp`);
    // OTP no longer exposed post-deny is acceptable; if still present, approve must 403.
    if (otpRes.status === 200) {
      const after = await request(app)
        .post(`/api/access-requests/${requestId}/approve`)
        .set("Cookie", ownerCookie)
        .send({ otp: otpRes.body.otp });
      expect(after.status).toBe(403);
    }
  }, 45_000);

  it("an OTP submitted after 5 minutes is rejected as expired", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `exp-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = reqRes.body.requestId as string;
    const otpRes = await request(app).get(`/api/invites/requests/${requestId}/otp`);
    const otp = otpRes.body.otp as string;

    // Force expiry by rewinding otpExpiresAt into the past.
    await prisma.accessRequest.update({
      where: { id: requestId },
      data: { otpExpiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post(`/api/access-requests/${requestId}/approve`)
      .set("Cookie", ownerCookie)
      .send({ otp });
    expect(res.status).toBe(403);
    const row = await prisma.accessRequest.findUnique({ where: { id: requestId } });
    expect(row?.status).toBe("expired");
  }, 45_000);
});

// ---------------------------------------------------------------------------
// Cross-owner authorization + guest 401s + deny
// ---------------------------------------------------------------------------
describe("authorization boundaries", () => {
  it("an owner cannot approve/deny another owner's guest's request -> 404", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `xowner-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = reqRes.body.requestId as string;

    // The OTHER owner tries to approve/deny it -> 404 (not 403).
    const approve = await request(app)
      .post(`/api/access-requests/${requestId}/approve`)
      .set("Cookie", otherCookie)
      .send({ otp: "123456" });
    expect(approve.status).toBe(404);
    const deny = await request(app)
      .post(`/api/access-requests/${requestId}/deny`)
      .set("Cookie", otherCookie);
    expect(deny.status).toBe(404);

    // The request is untouched (still pending).
    const row = await prisma.accessRequest.findUnique({ where: { id: requestId } });
    expect(row?.status).toBe("pending");
  }, 45_000);

  it("deny sets denied; approve after deny is rejected", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `deny-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = reqRes.body.requestId as string;
    const otp = (await request(app).get(`/api/invites/requests/${requestId}/otp`)).body.otp as string;

    const deny = await request(app)
      .post(`/api/access-requests/${requestId}/deny`)
      .set("Cookie", ownerCookie);
    expect(deny.status).toBe(200);
    expect(deny.body.status).toBe("denied");

    const approve = await request(app)
      .post(`/api/access-requests/${requestId}/approve`)
      .set("Cookie", ownerCookie)
      .send({ otp });
    expect(approve.status).toBe(403);
  }, 45_000);

  it("DELETE /api/guests/:id for another owner's guest -> 404, no effect", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `delx-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const guestId = share.body.guestId as string;

    const del = await request(app).delete(`/api/guests/${guestId}`).set("Cookie", otherCookie);
    expect(del.status).toBe(404);
    // Untouched: permissions still live.
    const perms = await prisma.folderPermission.findMany({ where: { guestUserId: guestId } });
    expect(perms.every((p) => p.revokedAt == null)).toBe(true);
  }, 45_000);

  it("all /api/guest/* endpoints 401 with no/invalid guest session", async () => {
    const noCookie = await request(app).get("/api/guest/folders");
    expect(noCookie.status).toBe(401);
    const bad = await request(app)
      .get("/api/guest/folders")
      .set("Cookie", `${GUEST_SESSION_COOKIE_NAME}=deadbeef`);
    expect(bad.status).toBe(401);
    const badPhoto = await request(app)
      .get(`/api/guest/photos/${crypto.randomUUID()}`)
      .set("Cookie", `${GUEST_SESSION_COOKIE_NAME}=deadbeef`);
    expect(badPhoto.status).toBe(401);
  });

  it("view-only permission refuses download with 403 (decision G5)", async () => {
    if (skipWorker()) return;
    // Share view-only, run the flow to a live guest session.
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `view-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;
    const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = reqRes.body.requestId as string;
    const otp = (await request(app).get(`/api/invites/requests/${requestId}/otp`)).body.otp as string;
    await request(app)
      .post(`/api/access-requests/${requestId}/approve`)
      .set("Cookie", ownerCookie)
      .send({ otp });
    const poll = await request(app).get(`/api/invites/requests/${requestId}/status`);
    const guestCookie = (poll.headers["set-cookie"] as unknown as string[]).find((c) =>
      c.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`),
    )!;

    const photosRes = await request(app)
      .get(`/api/guest/folders/${sharedFolderId}/photos`)
      .set("Cookie", guestCookie);
    const photoId = photosRes.body.photos[0].id as string;

    // View allowed...
    const view = await request(app).get(`/api/guest/photos/${photoId}`).set("Cookie", guestCookie);
    expect(view.status).toBe(200);
    // ...but download refused with 403 (existence legitimately known).
    const dl = await request(app)
      .get(`/api/guest/photos/${photoId}/download`)
      .set("Cookie", guestCookie);
    expect(dl.status).toBe(403);
  }, 60_000);
});

if (!fs.existsSync(fixture("fixture-people.jpg"))) {
  throw new Error(`Missing test fixture: ${fixture("fixture-people.jpg")}`);
}
