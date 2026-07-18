import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

// The production-only CSRF/Origin guard (app.ts) must validate the request
// Origin by EXACT origin membership, never a prefix test — a prefix match
// would accept an attacker-registered `https://app.example.com.evil.com`
// against an allowed `https://app.example.com`.
//
// Offline: the guard short-circuits BEFORE any route/DB access, so every
// assertion here is a middleware decision only (no Postgres needed). The
// allowed-origin cases target POST /api/auth/logout, which returns 200 with
// no session cookie (revokeSession(undefined) is a no-op) and no DB round-trip.

const ALLOWED_ORIGIN = "https://app.example.com";
const PROD = "production";

let app: Express;
let savedNodeEnv: string | undefined;
let savedFrontendOrigin: string | undefined;

beforeAll(async () => {
  savedNodeEnv = process.env.NODE_ENV;
  savedFrontendOrigin = process.env.FRONTEND_ORIGIN;
  process.env.NODE_ENV = PROD;
  process.env.FRONTEND_ORIGIN = ALLOWED_ORIGIN;

  // Import AFTER the env is set so createApp() registers the prod-only guard.
  const { createApp } = await import("../app");
  app = createApp();
});

afterAll(() => {
  process.env.NODE_ENV = savedNodeEnv;
  if (savedFrontendOrigin === undefined) delete process.env.FRONTEND_ORIGIN;
  else process.env.FRONTEND_ORIGIN = savedFrontendOrigin;
});

describe("CSRF Origin guard (production, exact-match)", () => {
  it("rejects a prefix-matched attacker origin with 403", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Origin", `${ALLOWED_ORIGIN}.evil.com`);
    expect(res.status).toBe(403);
  });

  it("rejects a request with no Origin/Referer with 403", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(403);
  });

  it("rejects a malformed Origin header with 403", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Origin", "not a url");
    expect(res.status).toBe(403);
  });

  it("allows the exact configured origin (not 403)", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Origin", ALLOWED_ORIGIN);
    expect(res.status).not.toBe(403);
  });

  it("allows a Referer whose origin matches the allow-list (not 403)", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Referer", `${ALLOWED_ORIGIN}/photos/123`);
    expect(res.status).not.toBe(403);
  });
});
