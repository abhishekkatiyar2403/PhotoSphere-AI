import rateLimit from "express-rate-limit";

/**
 * POST /api/photos/:id/reclassify gets its own rate-limit bucket — never
 * shared with upload's or auth's, per the established one-bucket-per-
 * endpoint-group lesson (specs/ai-classification.md §7, Open Question 5).
 *
 * Keyed by session user id (not IP) since it only runs after requireAuth.
 * 30 requests / 15 min / user, mirroring the upload limiter's numbers.
 * This endpoint will hit the real Vision API's wallet post-swap, so it is
 * limited from day one.
 */
export const reclassifyRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? "anonymous", // requireAuth runs first; falls back only if misordered
  message: { error: "Too many reclassification requests. Please try again later." },
});
