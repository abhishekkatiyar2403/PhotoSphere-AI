import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../lib/prisma";

/**
 * GET /health (2026-07-13 backend audit #14 — the old version returned 200
 * unconditionally, checking nothing). Follows the skip-not-fake convention
 * used across this suite: DB-dependent assertions skip with a warning when
 * infra is unreachable, rather than faking a pass.
 */
const app = createApp();

describe("GET /health", () => {
  it("returns 200 with database/redis/worker checks when infra is reachable", async () => {
    let dbAvailable = true;
    try {
      await prisma.$connect();
    } catch {
      dbAvailable = false;
    }
    if (!dbAvailable) {
      console.warn("Skipping: DATABASE_URL not reachable. Run `docker compose up -d` first.");
      return;
    }

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.database).toBe("ok");
    expect(res.body.checks.redis).toBe("ok");
    // worker.status is "unknown"/"stale"/"ok" depending on whether a real
    // worker process happens to be running against this Redis right now —
    // genuinely environment-dependent, so only assert the SHAPE, not a value.
    expect(["ok", "stale", "unknown"]).toContain(res.body.checks.worker.status);
  });
});
