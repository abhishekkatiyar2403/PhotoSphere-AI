import rateLimit from "express-rate-limit";

/**
 * Public, unauthenticated invite endpoints get their OWN IP-keyed buckets
 * (specs/guest-access-otp.md §6, decision G11) — separate from the
 * auth/upload/reclassify buckets, per the established one-bucket-per-
 * endpoint-group rule. These are the highest-abuse surface here: no session
 * gate, so they could be hammered to spam owners with OTP requests or to
 * enumerate tokens.
 *
 * Keyed by IP (not user id) since there is no session yet. Both are relaxed
 * (effectively disarmed, limit 100000) under NODE_ENV=test so the smoke suite
 * — and the ~3s status polling in the success-signal flow — never trips a 429;
 * live dev/prod keep the tight production numbers.
 *
 * The OTP *wrong-attempt* cap (3 -> auto-deny) is enforced separately in the
 * approve handler on the access_request row itself, independent of these IP
 * limiters.
 */
const isTestEnv = process.env.NODE_ENV === "test";

// POST /api/invites/:token/request — 10 / 15 min / IP (G11).
export const inviteRequestRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 100000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many access requests. Please try again later." },
});

// GET /api/invites/requests/:requestId/status — 120 / 15 min / IP (G11),
// accommodates ~3s polling for ~6 min on the guest's waiting page.
export const inviteStatusRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 100000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many status checks. Please try again later." },
});
