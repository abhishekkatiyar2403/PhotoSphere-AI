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

// Runs the full request -> OTP -> approve -> poll flow and returns a live
// guest session cookie + guestId, scoped to `folderIds` at `permissionLevel`.
// Shared by the permission-change and download-many test blocks below so
// they don't each hand-roll the OTP dance.
async function establishGuestSession(
  guestEmail: string,
  folderIds: string[],
  permissionLevel: string,
): Promise<{ guestCookie: string; guestId: string }> {
  const share = await request(app)
    .post("/api/guests")
    .set("Cookie", ownerCookie)
    .send({ guestEmail, folderIds, permissionLevel });
  const rawInvite = share.body.inviteToken as string;
  const guestId = share.body.guestId as string;
  const reqRes = await request(app).post(`/api/invites/${rawInvite}/request`);
  const requestId = reqRes.body.requestId as string;
  const otp = (await request(app).get(`/api/invites/requests/${requestId}/otp`)).body.otp as string;
  await request(app).post(`/api/access-requests/${requestId}/approve`).set("Cookie", ownerCookie).send({ otp });
  const poll = await request(app).get(`/api/invites/requests/${requestId}/status`);
  const guestCookie = (poll.headers["set-cookie"] as unknown as string[]).find((c) =>
    c.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`),
  )!;
  return { guestCookie, guestId };
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

    // Download allowed (permission is download). The URL forces an actual
    // save (Content-Disposition: attachment) rather than opening inline in a
    // browser tab — bug report: "click download... shows the photo in
    // another tab but not download".
    const dl = await request(app)
      .get(`/api/guest/photos/${photoId}/download`)
      .set("Cookie", guestCookie);
    expect(dl.status).toBe(200);
    expect(dl.body.download.url).toContain("X-Amz-");
    expect(decodeURIComponent(dl.body.download.url)).toContain("response-content-disposition=attachment");

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

// ---------------------------------------------------------------------------
// PATCH /api/guests/:id — change an existing guest's permission level
// (bug report: previously the only option once shared was Revoke).
// ---------------------------------------------------------------------------
describe("PATCH /api/guests/:id — change permission level", () => {
  it("upgrades view -> download on the live permission; an ALREADY-LIVE guest session's next download succeeds where it previously 403'd (no re-approval needed)", async () => {
    if (skipWorker()) return;
    const { guestCookie, guestId } = await establishGuestSession(
      `upgrade-${stamp}@example.com`,
      [sharedFolderId],
      "view",
    );

    // Confirm the pre-upgrade baseline: view-only refuses download.
    const photosRes = await request(app)
      .get(`/api/guest/folders/${sharedFolderId}/photos`)
      .set("Cookie", guestCookie);
    const photoId = photosRes.body.photos[0].id as string;
    const before = await request(app).get(`/api/guest/photos/${photoId}/download`).set("Cookie", guestCookie);
    expect(before.status).toBe(403);

    const patch = await request(app)
      .patch(`/api/guests/${guestId}`)
      .set("Cookie", ownerCookie)
      .send({ permissionLevel: "download" });
    expect(patch.status).toBe(200);
    expect(patch.body.permissionLevel).toBe("download");
    expect(patch.body.foldersUpdated).toBeGreaterThanOrEqual(1);

    const perm = await prisma.folderPermission.findFirst({ where: { guestUserId: guestId } });
    expect(perm?.permissionLevel).toBe("download");

    // The SAME already-live session, no re-approval — the change takes
    // effect immediately since permission is checked live on every request.
    const after = await request(app).get(`/api/guest/photos/${photoId}/download`).set("Cookie", guestCookie);
    expect(after.status).toBe(200);
  }, 60_000);

  it("404 when patching another owner's guest, or a nonexistent guest id — no effect", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `patchx-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const guestId = share.body.guestId as string;

    const foreign = await request(app)
      .patch(`/api/guests/${guestId}`)
      .set("Cookie", otherCookie)
      .send({ permissionLevel: "download" });
    expect(foreign.status).toBe(404);
    const perm = await prisma.folderPermission.findFirst({ where: { guestUserId: guestId } });
    expect(perm?.permissionLevel).toBe("view"); // untouched

    const bogus = await request(app)
      .patch(`/api/guests/${crypto.randomUUID()}`)
      .set("Cookie", ownerCookie)
      .send({ permissionLevel: "download" });
    expect(bogus.status).toBe(404);
  }, 45_000);

  it("400 on an invalid permissionLevel; 401 without a session", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `patchbad-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const guestId = share.body.guestId as string;

    const bad = await request(app)
      .patch(`/api/guests/${guestId}`)
      .set("Cookie", ownerCookie)
      .send({ permissionLevel: "nonsense" });
    expect(bad.status).toBe(400);

    const noSession = await request(app).patch(`/api/guests/${guestId}`).send({ permissionLevel: "download" });
    expect(noSession.status).toBe(401);
  }, 45_000);

  it("404 for a guest whose only permission was already revoked", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `patchrevoked-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const guestId = share.body.guestId as string;
    await request(app).delete(`/api/guests/${guestId}`).set("Cookie", ownerCookie);

    const patch = await request(app)
      .patch(`/api/guests/${guestId}`)
      .set("Cookie", ownerCookie)
      .send({ permissionLevel: "download" });
    expect(patch.status).toBe(404);
  }, 45_000);
});

// ---------------------------------------------------------------------------
// POST /api/guest/photos/download-many — multi-select "Download selected"
// (bug report: only single-photo download and, at `download_all` only,
// whole-folder zip existed; no way to download a batch at plain `download`
// level).
// ---------------------------------------------------------------------------
describe("POST /api/guest/photos/download-many", () => {
  it("zips exactly the requested photos this guest has download access to; excludes an unpermitted folder's photo silently", async () => {
    if (skipWorker()) return;
    const { guestCookie } = await establishGuestSession(`dlmany-${stamp}@example.com`, [sharedFolderId], "download");

    const photosRes = await request(app)
      .get(`/api/guest/folders/${sharedFolderId}/photos`)
      .set("Cookie", guestCookie);
    const photoIds = photosRes.body.photos.map((p: { id: string }) => p.id);
    expect(photoIds.length).toBeGreaterThan(0);

    const idsToRequest = [...photoIds];
    if (otherOwnerFolderId) {
      const otherPhotos = await prisma.photo.findMany({ where: { folderId: otherOwnerFolderId }, take: 1 });
      if (otherPhotos[0]) idsToRequest.push(otherPhotos[0].id);
    }

    const res = await request(app)
      .post("/api/guest/photos/download-many")
      .set("Cookie", guestCookie)
      .send({ photoIds: idsToRequest })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect((res.body as Buffer).length).toBeGreaterThan(0);
  }, 60_000);

  it("403-gated single-photo download still applies, but download-many EXCLUDES (not errors on) a view-only folder's photo — 400 if that's the only thing requested", async () => {
    if (skipWorker()) return;
    const { guestCookie } = await establishGuestSession(`dlmanyview-${stamp}@example.com`, [sharedFolderId], "view");
    const photosRes = await request(app)
      .get(`/api/guest/folders/${sharedFolderId}/photos`)
      .set("Cookie", guestCookie);
    const photoId = photosRes.body.photos[0].id as string;

    const res = await request(app)
      .post("/api/guest/photos/download-many")
      .set("Cookie", guestCookie)
      .send({ photoIds: [photoId] });
    expect(res.status).toBe(400);
  }, 60_000);

  it("400 on empty array; 401 without a guest session", async () => {
    const empty = await request(app).post("/api/guest/photos/download-many").send({ photoIds: [] });
    expect([400, 401]).toContain(empty.status);
    const noSession = await request(app)
      .post("/api/guest/photos/download-many")
      .send({ photoIds: [crypto.randomUUID()] });
    expect(noSession.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/guests/:id/folders, DELETE /api/guests/:id/folders/:folderId —
// per-folder access management on an existing guest (bug report: after a
// guest was approved, there was no way to later share MORE folders with
// them, or remove access to just one).
// ---------------------------------------------------------------------------
describe("POST /api/guests/:id/folders — share additional folders", () => {
  it("adds a second folder at the guest's current level; already-shared folder is silently skipped; a LIVE guest session immediately sees the new folder with no re-approval", async () => {
    if (skipWorker()) return;
    if (!unsharedFolderId || unsharedFolderId === sharedFolderId) return; // needs a distinct second folder
    const { guestCookie, guestId } = await establishGuestSession(
      `addfolders-${stamp}@example.com`,
      [sharedFolderId],
      "download",
    );

    // Baseline: the second folder isn't visible yet.
    const before = await request(app).get("/api/guest/folders").set("Cookie", guestCookie);
    expect(before.body.folders.map((f: { id: string }) => f.id)).not.toContain(unsharedFolderId);

    const add = await request(app)
      .post(`/api/guests/${guestId}/folders`)
      .set("Cookie", ownerCookie)
      .send({ folderIds: [sharedFolderId, unsharedFolderId] }); // one dup, one new
    expect(add.status).toBe(200);
    expect(add.body.added).toEqual([unsharedFolderId]); // the already-shared one was skipped
    expect(add.body.permissionLevel).toBe("download");

    const perm = await prisma.folderPermission.findFirst({
      where: { guestUserId: guestId, folderId: unsharedFolderId },
    });
    expect(perm?.permissionLevel).toBe("download");
    expect(perm?.revokedAt).toBeNull();

    // Same already-live session, no re-approval — sees it immediately.
    const after = await request(app).get("/api/guest/folders").set("Cookie", guestCookie);
    expect(after.body.folders.map((f: { id: string }) => f.id)).toContain(unsharedFolderId);
  }, 60_000);

  it("reactivates a previously fully-removed folder (unique guestUserId+folderId row) rather than erroring on a duplicate", async () => {
    if (skipWorker()) return;
    if (!unsharedFolderId || unsharedFolderId === sharedFolderId) return;
    const { guestId } = await establishGuestSession(`reactivate-${stamp}@example.com`, [sharedFolderId], "view");

    // Add, then remove, then add again — the SAME row should be reused (no
    // unique-constraint violation), just un-revoked.
    await request(app).post(`/api/guests/${guestId}/folders`).set("Cookie", ownerCookie).send({ folderIds: [unsharedFolderId] });
    const firstRow = await prisma.folderPermission.findFirst({ where: { guestUserId: guestId, folderId: unsharedFolderId } });
    await request(app).delete(`/api/guests/${guestId}/folders/${unsharedFolderId}`).set("Cookie", ownerCookie);

    const reAdd = await request(app)
      .post(`/api/guests/${guestId}/folders`)
      .set("Cookie", ownerCookie)
      .send({ folderIds: [unsharedFolderId] });
    expect(reAdd.status).toBe(200);
    expect(reAdd.body.added).toEqual([unsharedFolderId]);

    const secondRow = await prisma.folderPermission.findFirst({ where: { guestUserId: guestId, folderId: unsharedFolderId } });
    expect(secondRow?.id).toBe(firstRow?.id); // same row, reactivated — not a new one
    expect(secondRow?.revokedAt).toBeNull();
  }, 60_000);

  it("404, adds NOTHING, when any requested folder isn't owned by the caller", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `addx-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const guestId = share.body.guestId as string;

    const foreignFolders = otherOwnerFolderId
      ? [otherOwnerFolderId]
      : [crypto.randomUUID()];
    const res = await request(app)
      .post(`/api/guests/${guestId}/folders`)
      .set("Cookie", ownerCookie)
      .send({ folderIds: foreignFolders });
    expect(res.status).toBe(404);

    const perms = await prisma.folderPermission.findMany({ where: { guestUserId: guestId } });
    expect(perms.length).toBe(1); // only the original share — nothing added
  }, 45_000);

  it("404 when the guest itself isn't owned by the caller; 400 on empty folderIds; 401 without a session", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `addforeign-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const guestId = share.body.guestId as string;

    const foreign = await request(app)
      .post(`/api/guests/${guestId}/folders`)
      .set("Cookie", otherCookie)
      .send({ folderIds: [sharedFolderId] });
    expect(foreign.status).toBe(404);

    const empty = await request(app)
      .post(`/api/guests/${guestId}/folders`)
      .set("Cookie", ownerCookie)
      .send({ folderIds: [] });
    expect(empty.status).toBe(400);

    const noSession = await request(app).post(`/api/guests/${guestId}/folders`).send({ folderIds: [sharedFolderId] });
    expect(noSession.status).toBe(401);
  }, 45_000);
});

describe("DELETE /api/guests/:id/folders/:folderId — remove access to ONE folder", () => {
  it("revokes only that folder, leaving other shared folders untouched; guest immediately loses access to it on their live session", async () => {
    if (skipWorker()) return;
    if (!unsharedFolderId || unsharedFolderId === sharedFolderId) return;
    const { guestCookie, guestId } = await establishGuestSession(
      `removefolder-${stamp}@example.com`,
      [sharedFolderId, unsharedFolderId],
      "download",
    );

    const before = await request(app).get("/api/guest/folders").set("Cookie", guestCookie);
    expect(before.body.folders.map((f: { id: string }) => f.id).sort()).toEqual(
      [sharedFolderId, unsharedFolderId].sort(),
    );

    const del = await request(app)
      .delete(`/api/guests/${guestId}/folders/${unsharedFolderId}`)
      .set("Cookie", ownerCookie);
    expect(del.status).toBe(200);

    const perm = await prisma.folderPermission.findFirst({
      where: { guestUserId: guestId, folderId: unsharedFolderId },
    });
    expect(perm?.revokedAt).not.toBeNull();
    const otherPerm = await prisma.folderPermission.findFirst({
      where: { guestUserId: guestId, folderId: sharedFolderId },
    });
    expect(otherPerm?.revokedAt).toBeNull(); // untouched

    const after = await request(app).get("/api/guest/folders").set("Cookie", guestCookie);
    const afterIds = after.body.folders.map((f: { id: string }) => f.id);
    expect(afterIds).toContain(sharedFolderId);
    expect(afterIds).not.toContain(unsharedFolderId);
  }, 60_000);

  it("404 for a folder this guest never had, or already had removed; 404 for another owner's guest", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `delfolderx-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const guestId = share.body.guestId as string;

    const neverShared = await request(app)
      .delete(`/api/guests/${guestId}/folders/${crypto.randomUUID()}`)
      .set("Cookie", ownerCookie);
    expect(neverShared.status).toBe(404);

    const alreadyRemoved = await request(app)
      .delete(`/api/guests/${guestId}/folders/${sharedFolderId}`)
      .set("Cookie", ownerCookie);
    expect(alreadyRemoved.status).toBe(200);
    const secondAttempt = await request(app)
      .delete(`/api/guests/${guestId}/folders/${sharedFolderId}`)
      .set("Cookie", ownerCookie);
    expect(secondAttempt.status).toBe(404); // already revoked, not live anymore

    const foreignShare = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `delforeign-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const foreignGuestId = foreignShare.body.guestId as string;
    const foreign = await request(app)
      .delete(`/api/guests/${foreignGuestId}/folders/${sharedFolderId}`)
      .set("Cookie", otherCookie);
    expect(foreign.status).toBe(404);
  }, 45_000);
});

// ---------------------------------------------------------------------------
// Link-forwarding detection — GET /api/access-requests flags a pending
// request that was opened from more than one IP before it was resolved.
// ---------------------------------------------------------------------------
describe("link-forwarding detection (touchCount / distinctDeviceCount)", () => {
  it("a single click reports touchCount 1, distinctDeviceCount 1, multipleDevicesDetected false", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `onetouch-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;
    await request(app).post(`/api/invites/${rawInvite}/request`);

    const list = await request(app).get("/api/access-requests?status=pending").set("Cookie", ownerCookie);
    const item = list.body.requests.find((r: { guest: { email: string } }) => r.guest.email === `onetouch-${stamp}@example.com`);
    expect(item).toBeTruthy();
    expect(item.touchCount).toBe(1);
    expect(item.distinctDeviceCount).toBe(1);
    expect(item.multipleDevicesDetected).toBe(false);
  }, 45_000);

  it("re-clicking the SAME link while pending records another touch and reuses the SAME request (no new OTP) — a distinct-IP re-click flags multipleDevicesDetected", async () => {
    if (skipWorker()) return;
    const share = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({ guestEmail: `forwarded-${stamp}@example.com`, folderIds: [sharedFolderId], permissionLevel: "view" });
    const rawInvite = share.body.inviteToken as string;

    const first = await request(app).post(`/api/invites/${rawInvite}/request`);
    const requestId = first.body.requestId as string;

    // Re-click the same link — reused, not a new request.
    const second = await request(app).post(`/api/invites/${rawInvite}/request`);
    expect(second.status).toBe(200);
    expect(second.body.requestId).toBe(requestId);

    const touchesAfterSameIp = await prisma.accessRequestTouch.findMany({ where: { accessRequestId: requestId } });
    expect(touchesAfterSameIp.length).toBe(2); // both clicks recorded...

    // In this test environment every request shares one loopback IP (no
    // reverse-proxy header trust configured), so two clicks from the actual
    // test client still count as ONE device — this directly exercises that
    // the aggregation is IP-based, not just a raw click counter.
    const sameIpList = await request(app).get("/api/access-requests?status=pending").set("Cookie", ownerCookie);
    const sameIpItem = sameIpList.body.requests.find((r: { id: string }) => r.id === requestId);
    expect(sameIpItem.touchCount).toBe(2);
    expect(sameIpItem.distinctDeviceCount).toBe(1);
    expect(sameIpItem.multipleDevicesDetected).toBe(false);

    // Simulate what an ACTUAL forwarded-link click looks like: a touch from
    // a genuinely different IP. (Exercising GET /api/access-requests's real
    // aggregation logic against real rows — the click itself, from a
    // different network, is exactly what lib/notifications' deviceInfo
    // capture already records correctly in production; only the "different
    // IP" part needs simulating here since the test client is one machine.)
    await prisma.accessRequestTouch.create({
      data: { accessRequestId: requestId, ipAddress: "203.0.113.9", deviceInfo: { userAgent: "curl/8.0" } },
    });

    const list = await request(app).get("/api/access-requests?status=pending").set("Cookie", ownerCookie);
    const item = list.body.requests.find((r: { id: string }) => r.id === requestId);
    expect(item.touchCount).toBe(3);
    expect(item.distinctDeviceCount).toBe(2);
    expect(item.multipleDevicesDetected).toBe(true);

    // Still only ONE otp/email was ever generated — re-clicking never spams
    // a fresh code (unchanged G10 behavior).
    const arRow = await prisma.accessRequest.findUnique({ where: { id: requestId } });
    expect(arRow?.otpHash).toBeTruthy();
  }, 45_000);
});

if (!fs.existsSync(fixture("fixture-people.jpg"))) {
  throw new Error(`Missing test fixture: ${fixture("fixture-people.jpg")}`);
}
