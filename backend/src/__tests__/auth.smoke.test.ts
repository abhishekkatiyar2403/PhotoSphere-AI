import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";

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

    await request(app)
      .post("/api/auth/signup")
      .send({ email: `${testEmail}-dup`, password: testPassword, name: "Dup" });

    const dupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: `${testEmail}-dup`, password: testPassword, name: "Dup" });

    expect(dupRes.status).toBe(409);

    await prisma.user.deleteMany({ where: { email: `${testEmail}-dup` } });
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
