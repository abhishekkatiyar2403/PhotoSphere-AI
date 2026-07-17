import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { getExposedGuestInviteUrl } from "../lib/notifications";

/**
 * Plan enforcement (2026-07-13 backend audit #7) + guest invite email
 * (audit #9). Folders are seeded directly via Prisma rather than through a
 * real upload/classification pipeline — POST /api/guests only checks folder
 * OWNERSHIP, not classification status, so a lightweight "custom" folder is
 * sufficient and keeps this test worker-independent.
 */
const app = createApp();
const stamp = Date.now();
const ownerEmail = `plans-owner-${stamp}@example.com`;
const password = "correct-password-123";

let infraAvailable = true;
let ownerCookie: string;
let ownerId: string;
let collectionId: string;
const folderIds: string[] = [];

function skipInfra(): boolean {
  if (!infraAvailable) {
    console.warn("Skipping: Postgres not reachable. Run `docker compose up -d` first.");
    return true;
  }
  return false;
}

beforeAll(async () => {
  try {
    await prisma.$connect();
  } catch {
    infraAvailable = false;
    return;
  }

  const signupRes = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password, name: "Plans Owner" });
  ownerCookie = signupRes.headers["set-cookie"][0];
  ownerId = signupRes.body.user.id;

  const collection = await prisma.collection.create({
    data: { ownerId, name: `plans-test-${stamp}`, isDefault: true },
  });
  collectionId = collection.id;

  // 5 folders — enough for 4 guests (free-tier limit is 3) plus one spare
  // for the re-invite-after-revoke check.
  for (let i = 0; i < 5; i++) {
    const folder = await prisma.folder.create({
      data: { collectionId, name: `plans-folder-${stamp}-${i}`, categoryType: "custom" },
    });
    folderIds.push(folder.id);
  }
});

afterAll(async () => {
  if (infraAvailable) {
    await prisma.user.deleteMany({ where: { email: ownerEmail } });
    await prisma.$disconnect();
  }
});

describe("free-tier guest limit (backend audit #7)", () => {
  it("allows exactly 3 active guests, rejects the 4th with 402, then allows a new one after revoking one", async () => {
    if (skipInfra()) return;

    const guestEmails = [0, 1, 2].map((i) => `plans-guest-${stamp}-${i}@example.com`);
    const guestIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/api/guests")
        .set("Cookie", ownerCookie)
        .send({ guestEmail: guestEmails[i], folderIds: [folderIds[i]], permissionLevel: "view" });
      expect(res.status).toBe(201);
      guestIds.push(res.body.guestId);
    }

    // 4th guest — over the free-tier limit.
    const fourthRes = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({
        guestEmail: `plans-guest-${stamp}-3@example.com`,
        folderIds: [folderIds[3]],
        permissionLevel: "view",
      });
    expect(fourthRes.status).toBe(402);
    expect(fourthRes.body.error).toMatch(/3 active guests/);

    // Revoke one of the 3 — frees a slot (liveness-based counting, not
    // ever-created counting).
    const revokeRes = await request(app).delete(`/api/guests/${guestIds[0]}`).set("Cookie", ownerCookie);
    expect(revokeRes.status).toBe(200);

    const retryRes = await request(app)
      .post("/api/guests")
      .set("Cookie", ownerCookie)
      .send({
        guestEmail: `plans-guest-${stamp}-4@example.com`,
        folderIds: [folderIds[4]],
        permissionLevel: "view",
      });
    expect(retryRes.status).toBe(201);
  });
});

describe("guest invite email (backend audit #9, revised: explicit Send action)", () => {
  it("does NOT email on creation — the link is generated but nothing is sent until Send is clicked", async () => {
    if (skipInfra()) return;

    const inviteOwnerEmail = `plans-invite-owner-${stamp}@example.com`;
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: inviteOwnerEmail, password, name: "Invite Owner" });
    const inviteOwnerCookie = signupRes.headers["set-cookie"][0];
    const inviteOwnerId = signupRes.body.user.id;

    const collection = await prisma.collection.create({
      data: { ownerId: inviteOwnerId, name: `plans-invite-collection-${stamp}`, isDefault: true },
    });
    const folder = await prisma.folder.create({
      data: { collectionId: collection.id, name: `plans-invite-folder-${stamp}`, categoryType: "custom" },
    });

    const guestEmail = `plans-invite-email-${stamp}@example.com`;
    const createRes = await request(app)
      .post("/api/guests")
      .set("Cookie", inviteOwnerCookie)
      .send({ guestEmail, folderIds: [folder.id], permissionLevel: "view" });
    expect(createRes.status).toBe(201);

    await new Promise((r) => setTimeout(r, 350));
    expect(getExposedGuestInviteUrl(guestEmail)).toBeNull(); // nothing sent yet

    // Clicking "Send" — the frontend passes back the inviteUrl it already
    // has from the create response above (never re-derived server-side).
    const sendRes = await request(app)
      .post(`/api/guests/${createRes.body.guestId}/send-invite`)
      .set("Cookie", inviteOwnerCookie)
      .send({ inviteUrl: createRes.body.inviteUrl });
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.sent).toBe(true);

    await new Promise((r) => setTimeout(r, 350));
    expect(getExposedGuestInviteUrl(guestEmail)).toBe(createRes.body.inviteUrl);

    // Clicking Send again (guest says they didn't get it) — allowed, not
    // single-use.
    const resendRes = await request(app)
      .post(`/api/guests/${createRes.body.guestId}/send-invite`)
      .set("Cookie", inviteOwnerCookie)
      .send({ inviteUrl: createRes.body.inviteUrl });
    expect(resendRes.status).toBe(200);

    await prisma.user.deleteMany({ where: { email: inviteOwnerEmail } });
  });

  it("404s for a guest that isn't yours (never 403 — same anti-enumeration posture as every other guest route)", async () => {
    if (skipInfra()) return;

    const otherOwnerEmail = `plans-other-owner-${stamp}@example.com`;
    const otherSignup = await request(app)
      .post("/api/auth/signup")
      .send({ email: otherOwnerEmail, password, name: "Other Owner" });
    const otherCollection = await prisma.collection.create({
      data: { ownerId: otherSignup.body.user.id, name: `plans-other-collection-${stamp}`, isDefault: true },
    });
    const otherFolder = await prisma.folder.create({
      data: { collectionId: otherCollection.id, name: `plans-other-folder-${stamp}`, categoryType: "custom" },
    });
    const otherGuestRes = await request(app)
      .post("/api/guests")
      .set("Cookie", otherSignup.headers["set-cookie"][0])
      .send({
        guestEmail: `plans-other-guest-${stamp}@example.com`,
        folderIds: [otherFolder.id],
        permissionLevel: "view",
      });

    // ownerCookie (the shared top-level owner) trying to send THIS OTHER
    // owner's guest invite.
    const res = await request(app)
      .post(`/api/guests/${otherGuestRes.body.guestId}/send-invite`)
      .set("Cookie", ownerCookie)
      .send({ inviteUrl: otherGuestRes.body.inviteUrl });
    expect(res.status).toBe(404);

    await prisma.user.deleteMany({ where: { email: otherOwnerEmail } });
  });
});
