import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";
import { getExposedPasswordResetUrl } from "../lib/notifications";

// Smoke test covering the spec's success signal end-to-end:
// signup -> cookie set -> protected route succeeds -> logout ->
// same cookie now fails with 401 -> login again -> succeeds again.
//
// Requires a running Postgres reachable via DATABASE_URL (docker compose up).
// Skips gracefully if the DB isn't reachable so `npm test` doesn't hard-fail
// in environments without Docker running, but the Tester Agent should run
// this against a live `docker compose up -d` stack.

const app = createApp();
const testEmail = `smoke-${Date.now()}@example.com`;
const testPassword = "correct-password-123";

let dbAvailable = true;

beforeAll(async () => {
  try {
    await prisma.$connect();
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (dbAvailable) {
    await prisma.user.deleteMany({ where: { email: testEmail } });
    await prisma.$disconnect();
  }
});

describe("auth flow (smoke)", () => {
  it("signup -> access protected route -> logout -> denied -> login -> access again", async () => {
    if (!dbAvailable) {
      console.warn("Skipping: DATABASE_URL not reachable. Run `docker compose up -d` first.");
      return;
    }

    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: testEmail, password: testPassword, name: "Smoke Test" });

    expect(signupRes.status).toBe(201);
    const cookies = signupRes.headers["set-cookie"];
    expect(cookies).toBeDefined();
    const sessionCookie = Array.isArray(cookies) ? cookies[0] : cookies;

    // Cookie value should not look like a JWT (no two dots separating
    // header.payload.signature) - opaque token, not JWT.
    const cookieValue = sessionCookie.split(";")[0].split("=")[1];
    expect(cookieValue.split(".").length).not.toBe(3);

    const meRes1 = await request(app).get("/api/auth/me").set("Cookie", sessionCookie);
    expect(meRes1.status).toBe(200);
    expect(meRes1.body.user.email).toBe(testEmail);

    const logoutRes = await request(app).post("/api/auth/logout").set("Cookie", sessionCookie);
    expect(logoutRes.status).toBe(200);

    const meRes2 = await request(app).get("/api/auth/me").set("Cookie", sessionCookie);
    expect(meRes2.status).toBe(401);

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: testEmail, password: testPassword });
    expect(loginRes.status).toBe(200);
    const loginCookie = loginRes.headers["set-cookie"][0];

    const meRes3 = await request(app).get("/api/auth/me").set("Cookie", loginCookie);
    expect(meRes3.status).toBe(200);
  });

  it("rejects duplicate signup with 409", async () => {
    if (!dbAvailable) return;

    // NOTE: this used to construct `${testEmail}-dup`, i.e.
    // "smoke-<ts>@example.com-dup" - an INVALID email under zod's email
    // regex (TLD must be letters-only), so both signups 400'd at validation
    // and never reached the duplicate check. The suffix belongs in the
    // local part.
    const dupEmail = `dup-${testEmail}`;

    const firstRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: dupEmail, password: testPassword, name: "Dup" });
    expect(firstRes.status).toBe(201);

    const dupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: dupEmail, password: testPassword, name: "Dup" });

    expect(dupRes.status).toBe(409);

    await prisma.user.deleteMany({ where: { email: dupEmail } });
  });

  it("rejects invalid signup payload with 400 before touching the DB", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "not-an-email", password: "short", name: "X" });

    expect(res.status).toBe(400);
  });

  it("returns generic 401 for wrong password without leaking user existence", async () => {
    if (!dbAvailable) return;

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "whatever123" });

    expect(res.status).toBe(401);
    expect(res.body.error).not.toMatch(/no such user|not found/i);
  });
});

// 2026-07-13 backend audit #4: account deletion. Covers the whole
// contract — auth required, password confirmation required and checked,
// then a real cascade (photo/folder/collection all gone), the session
// itself is dead afterward, and the audit row survives despite having no FK
// to the now-deleted user.
describe("DELETE /api/auth/me — account deletion (audit #4)", () => {
  it("requires an active session", async () => {
    const res = await request(app).delete("/api/auth/me").send({ password: "whatever" });
    expect(res.status).toBe(401);
  });

  it("requires a password in the body before touching anything", async () => {
    if (!dbAvailable) return;
    const email = `delete-noPassword-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: testPassword, name: "Delete Me" });
    const cookie = signupRes.headers["set-cookie"][0];

    const res = await request(app).delete("/api/auth/me").set("Cookie", cookie).send({});
    expect(res.status).toBe(400);

    // Account must still exist — clean up directly.
    await prisma.user.deleteMany({ where: { email } });
  });

  it("rejects the wrong password with 401 and does not delete anything", async () => {
    if (!dbAvailable) return;
    const email = `delete-wrongPassword-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: testPassword, name: "Delete Me" });
    const cookie = signupRes.headers["set-cookie"][0];

    const res = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .send({ password: "definitely-wrong" });
    expect(res.status).toBe(401);

    // Still logged in — the session was never touched.
    const meRes = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meRes.status).toBe(200);

    await prisma.user.deleteMany({ where: { email } });
  });

  it("with the correct password: deletes the user, cascades photos/folders/collections, kills the session, and leaves a surviving audit row", async () => {
    if (!dbAvailable) return;
    const email = `delete-full-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: testPassword, name: "Delete Me Fully" });
    expect(signupRes.status).toBe(201);
    const cookie = signupRes.headers["set-cookie"][0];
    const userId = signupRes.body.user.id;

    // Seed a real collection -> folder -> photo under this user, so the
    // cascade is actually exercised, not just an empty-account happy path.
    const collection = await prisma.collection.create({
      data: { ownerId: userId, name: "Delete-me collection", isDefault: true },
    });
    const folder = await prisma.folder.create({
      data: { collectionId: collection.id, name: "Delete-me folder", categoryType: "custom" },
    });
    const photo = await prisma.photo.create({
      data: {
        ownerId: userId,
        collectionId: collection.id,
        folderId: folder.id,
        s3Key: `test/account-deletion/${Math.random().toString(36).slice(2)}`,
        originalFilename: "delete-me.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
      },
    });

    const res = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .send({ password: testPassword });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // The session is dead — same cookie now 401s.
    const meRes = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meRes.status).toBe(401);

    // Every DB row cascaded away.
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.photo.findUnique({ where: { id: photo.id } })).toBeNull();
    expect(await prisma.folder.findUnique({ where: { id: folder.id } })).toBeNull();
    expect(await prisma.collection.findUnique({ where: { id: collection.id } })).toBeNull();

    // logAudit is fire-and-forget (never awaited by callers, project-wide
    // convention) — give it a beat to land before asserting, same pattern
    // as audit.smoke.test.ts's own settle() helper.
    await new Promise((r) => setTimeout(r, 350));

    // The audit row survives — no FK to the now-gone user row.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "account_deleted", ownerId: userId },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.actorId).toBe(userId);
  });
});

// 2026-07-13 backend audit #8: profile update + password change while
// logged in.
describe("PATCH /api/auth/me and POST /api/auth/change-password (audit #8)", () => {
  it("updates the display name", async () => {
    if (!dbAvailable) return;
    const email = `profile-name-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: testPassword, name: "Old Name" });
    const cookie = signupRes.headers["set-cookie"][0];

    const res = await request(app).patch("/api/auth/me").set("Cookie", cookie).send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("New Name");

    const meRes = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meRes.body.user.name).toBe("New Name");

    await prisma.user.deleteMany({ where: { email } });
  });

  it("rejects the wrong current password with 401 and changes nothing", async () => {
    if (!dbAvailable) return;
    const email = `change-pw-wrong-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: testPassword, name: "X" });
    const cookie = signupRes.headers["set-cookie"][0];

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie)
      .send({ currentPassword: "wrong-password", newPassword: "new-password-123" });
    expect(res.status).toBe(401);

    // Original password still works.
    const loginRes = await request(app).post("/api/auth/login").send({ email, password: testPassword });
    expect(loginRes.status).toBe(200);

    await prisma.user.deleteMany({ where: { email } });
  });

  it("changes the password, keeps the CURRENT session alive, but revokes every OTHER session", async () => {
    if (!dbAvailable) return;
    const email = `change-pw-ok-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: testPassword, name: "X" });
    const sessionACookie = signupRes.headers["set-cookie"][0];

    // A second, independent session (e.g. logged in on another device).
    const loginRes = await request(app).post("/api/auth/login").send({ email, password: testPassword });
    const sessionBCookie = loginRes.headers["set-cookie"][0];

    const changeRes = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", sessionACookie)
      .send({ currentPassword: testPassword, newPassword: "brand-new-password-456" });
    expect(changeRes.status).toBe(200);

    // Session A (the one that made the change) is still alive.
    const meA = await request(app).get("/api/auth/me").set("Cookie", sessionACookie);
    expect(meA.status).toBe(200);

    // Session B is dead.
    const meB = await request(app).get("/api/auth/me").set("Cookie", sessionBCookie);
    expect(meB.status).toBe(401);

    // New password works; old one doesn't.
    const oldLoginRes = await request(app).post("/api/auth/login").send({ email, password: testPassword });
    expect(oldLoginRes.status).toBe(401);
    const newLoginRes = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "brand-new-password-456" });
    expect(newLoginRes.status).toBe(200);

    await prisma.user.deleteMany({ where: { email } });
  });
});

// 2026-07-13 backend audit #8: forgot-password / reset-password (for a user
// who CAN'T log in — distinct from change-password above).
describe("POST /api/auth/forgot-password and /reset-password (audit #8)", () => {
  it("always returns 200 whether or not the email exists (anti-enumeration)", async () => {
    if (!dbAvailable) return;
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "definitely-nobody-here@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects an invalid/unknown reset token with 400", async () => {
    if (!dbAvailable) return;
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "not-a-real-token", newPassword: "new-password-123" });
    expect(res.status).toBe(400);
  });

  it("full flow: request reset -> redeem token -> new password works, old doesn't, EVERY session revoked, and the token can't be reused", async () => {
    if (!dbAvailable) return;
    const email = `forgot-pw-${Date.now()}@example.com`;
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: testPassword, name: "Forgot Me" });
    const originalCookie = signupRes.headers["set-cookie"][0];

    const forgotRes = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(forgotRes.status).toBe(200);

    // logAudit-style fire-and-forget email send — give it a beat to land.
    await new Promise((r) => setTimeout(r, 350));
    const resetUrl = getExposedPasswordResetUrl(email);
    expect(resetUrl).not.toBeNull();
    const token = new URL(resetUrl!).searchParams.get("token");
    expect(token).toBeTruthy();

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "reset-new-password-789" });
    expect(resetRes.status).toBe(200);

    // The session that requested the reset is ALSO revoked (unlike
    // change-password, there's no "current session" to preserve here).
    const meRes = await request(app).get("/api/auth/me").set("Cookie", originalCookie);
    expect(meRes.status).toBe(401);

    const oldLoginRes = await request(app).post("/api/auth/login").send({ email, password: testPassword });
    expect(oldLoginRes.status).toBe(401);
    const newLoginRes = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "reset-new-password-789" });
    expect(newLoginRes.status).toBe(200);

    // Replaying the same token a second time fails — single-use.
    const replayRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "yet-another-password" });
    expect(replayRes.status).toBe(400);

    await prisma.user.deleteMany({ where: { email } });
  });
});
