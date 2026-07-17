import rateLimit from "express-rate-limit";

/**
 * Rate limiter for the scoped guest portal (routes/guest.ts) — 2026-07-13
 * backend audit #13: every other endpoint group (auth/upload/reclassify/
 * invite) already has its own bucket, but the guest portal had none at all,
 * despite being the endpoint group that mints pre-signed S3/MinIO URLs (a
 * real cost/abuse surface if hammered). Keyed by the guest SESSION id (set by
 * requireGuest, which always runs first) rather than IP — a guest sharing an
 * office/household network with other guests of the SAME owner shouldn't
 * throttle each other, same reasoning as uploadRateLimiter's per-user keying.
 * Falls back to IP only if somehow invoked before requireGuest (misordering
 * guard, matches the existing uploadRateLimiter pattern).
 *
 * Disarmed under NODE_ENV=test, same convention as every other limiter here.
 */
const isTestEnv = process.env.NODE_ENV === "test";

export const guestRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 100000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.guest?.sessionId ?? req.ip ?? "anonymous",
  message: { error: "Too many requests. Please try again later." },
});
