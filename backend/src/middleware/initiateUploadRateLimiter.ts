import rateLimit from "express-rate-limit";

/**
 * specs/production-upload-batch.md — one shared bucket across
 * initiate/complete/abort (spec: "all three are session-lifecycle calls on
 * the same resource, not independent surfaces to throttle separately").
 * Deliberately a much lower ceiling than uploadRateLimiter's 30/15min — one
 * call here can represent an entire 1000-file batch, not one file. 10 gives
 * headroom for retries/multiple albums without inviting abuse.
 *
 * Keyed by session user id (not IP), same rationale as uploadRateLimiter:
 * this only ever runs after requireAuth, so a shared office/household IP
 * shouldn't throttle unrelated users.
 *
 * Relaxed (effectively disarmed, limit 100000) under NODE_ENV=test, same
 * convention as inviteRateLimiter/guestRateLimiter — a multi-scenario smoke
 * suite legitimately calls initiate/complete/abort many more than 10 times
 * across its own test cases; live dev/prod keep the tight production number.
 */
const isTestEnv = process.env.NODE_ENV === "test";

export const initiateUploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 100000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "anonymous",
  message: { error: "Too many batch upload requests. Please try again later." },
});
