import rateLimit from "express-rate-limit";

/**
 * Upload endpoint gets its own rate limiter, deliberately NOT sharing
 * authRateLimiter's bucket (spec decision, responding directly to Tester's
 * flag after the auth run that a shared IP-keyed bucket causes
 * cross-contamination between unrelated endpoint groups).
 *
 * Keyed by session user id (not IP) since this middleware only ever runs
 * after requireAuth - authenticated uploads should be limited per-account,
 * not per-network (a shared office/household IP shouldn't throttle
 * unrelated users). 30 requests / 15 min / user per spec Open Question 5.
 */
export const uploadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "anonymous", // requireAuth runs first; falls back only if misordered
  message: { error: "Too many uploads. Please try again later." },
});
