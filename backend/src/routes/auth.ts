import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/prisma";
import { createSession, hashToken, revokeSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "../lib/session";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  updatePlanSchema,
  updateProfileSchema,
} from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";
import { purgeAllStorageForOwner } from "../lib/purge";
import { deleteFaceCollection } from "../lib/classification/faces";
import { logAudit } from "../lib/audit";
import { sendPasswordResetEmail } from "../lib/notifications";
import { logger } from "../lib/logger";
import { getStorageLimitBytes } from "../lib/plans";

const router = Router();

const BCRYPT_COST_FACTOR = 12; // per roadmap §12
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Brute-force protection on the two auth endpoints (roadmap §12 Layer 7).
// Split into independent per-endpoint buckets per specs/ai-classification.md
// §8 (carry-over a) - the previous shared signup+login bucket caused
// cross-endpoint 429 friction in two consecutive Tester runs. Both buckets
// are effectively disarmed (limit 1000) under NODE_ENV=test so the smoke
// suite can run back-to-back without 429 flakes; live dev/prod keep the
// tight production numbers.
const isTestEnv = process.env.NODE_ENV === "test";

const signupRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

// Login legitimately gets retried more than signup; 10/15min is still tight
// enough for brute-force protection per roadmap §12 Layer 7.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

router.post("/signup", signupRateLimiter, asyncHandler(async (req, res) => {
  let input;
  try {
    input = signupSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.flatten() });
    }
    throw err;
  }

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST_FACTOR);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name,
    },
  });

  const { rawToken, expiresAt } = await createSession(user.id);
  res.cookie(SESSION_COOKIE_NAME, rawToken, sessionCookieOptions());

  return res.status(201).json({
    user: { id: user.id, email: user.email, name: user.name },
    expiresAt,
  });
}));

router.post("/login", loginRateLimiter, asyncHandler(async (req, res) => {
  let input;
  try {
    input = loginSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.flatten() });
    }
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Generic "invalid credentials" for both unknown email and wrong password
  // to avoid a user-enumeration leak (acceptance criteria).
  const genericError = () => res.status(401).json({ error: "Invalid email or password" });

  if (!user) {
    return genericError();
  }

  const passwordMatches = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordMatches) {
    return genericError();
  }

  const { rawToken, expiresAt } = await createSession(user.id);
  res.cookie(SESSION_COOKIE_NAME, rawToken, sessionCookieOptions());

  return res.status(200).json({
    user: { id: user.id, email: user.email, name: user.name },
    expiresAt,
  });
}));

router.post("/logout", asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
  await revokeSession(rawToken);
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  return res.status(200).json({ ok: true });
}));

// Minimal protected route used both by the /dashboard page and by the
// Tester Agent to prove revocation is enforced server-side.
//
// specs/plan-tiered-upload.md: also returns `plan` (so the /settings
// switcher can show the currently-selected tier on page load) — req.user's
// own shape from requireAuth is deliberately left UNCHANGED (widening it
// touches every route that reads req.user and isn't needed here), so this
// does its own small extra lookup, same pattern routes/dashboard.ts and
// routes/upload.ts already use whenever a route needs more than the
// session gives it.
router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const dbUser = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { plan: true } });
  return res.status(200).json({ user: { ...req.user, plan: dbUser?.plan ?? "free" } });
}));

// 2026-07-13 backend audit #8: profile update. Cosmetic-only (name), no
// audit row (matches the existing "cosmetic, high-frequency" exclusion
// pattern already used elsewhere, e.g. folder rename).
router.patch("/me", requireAuth, asyncHandler(async (req, res) => {
  let input;
  try {
    input = updateProfileSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.flatten() });
    }
    throw err;
  }

  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { name: input.name },
  });

  return res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
}));

/**
 * specs/plan-tiered-upload.md — a no-billing, testing-only plan switcher.
 * Lets the authenticated caller set their OWN plan to free/pro/studio, no
 * payment step, no admin scope (matches every other self-service account
 * endpoint in this file — same requireAuth posture as PATCH /me above).
 *
 * PTU6 (recommended, unchallenged): no extra rate limiter beyond whatever
 * default/global limiter already applies — this isn't a secret-guessing
 * surface like /change-password or /login.
 *
 * Storage-limit decision (Architecture notes): sync-at-switch. Writes
 * `storageLimitBytes` to match the new plan's tier in the SAME update as
 * `plan` itself — every existing quota-check call site continues to trust
 * the stored column, unchanged.
 *
 * PTU3 (RESOLVED, Abhishek 2026-07-13): downgrading while over the new
 * (lower) limit is allowed, not blocked — the existing 413 quota check on
 * the next upload attempt handles it naturally, no guard needed here.
 *
 * PTU5 (recommended, unchallenged): audited as `plan_changed` (fromPlan/
 * toPlan metadata), consistent with the existing pattern of auditing
 * account-affecting changes.
 */
router.patch("/plan", requireAuth, asyncHandler(async (req, res) => {
  let input;
  try {
    input = updatePlanSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.flatten() });
    }
    throw err;
  }

  const existing = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { plan: true } });
  if (!existing) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const fromPlan = existing.plan;

  const newLimit = getStorageLimitBytes(input.plan);
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { plan: input.plan, storageLimitBytes: newLimit },
  });

  logAudit({
    actorType: "owner",
    actorId: user.id,
    ownerId: user.id,
    action: "plan_changed",
    resourceType: "user",
    resourceId: user.id,
    metadata: { fromPlan, toPlan: input.plan },
  });

  return res.status(200).json({
    user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
    storage: { limitBytes: user.storageLimitBytes.toString(), usedBytes: user.storageUsedBytes.toString() },
  });
}));

// Same brute-force posture as loginRateLimiter — this endpoint also takes a
// password guess (currentPassword).
const changePasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

/**
 * Change password while already logged in (2026-07-13 backend audit #8) —
 * distinct from the forgot/reset flow below, which is for a user who CAN'T
 * log in. Requires the current password (re-auth for a sensitive action,
 * same posture as account deletion). Revokes every OTHER session for this
 * user (a real-world "someone else has my password" response — if that's
 * true, this change immediately kicks them out everywhere else), but
 * deliberately keeps THIS session alive so the user isn't logged out by
 * changing their own password.
 */
router.post("/change-password", requireAuth, changePasswordRateLimiter, asyncHandler(async (req, res) => {
  let input;
  try {
    input = changePasswordSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.flatten() });
    }
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const passwordMatches = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Incorrect current password" });
  }

  const newPasswordHash = await bcrypt.hash(input.newPassword, BCRYPT_COST_FACTOR);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newPasswordHash } });

  const currentTokenHash = hashToken(req.cookies?.[SESSION_COOKIE_NAME]);
  await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null, tokenHash: { not: currentTokenHash } },
    data: { revokedAt: new Date() },
  });

  return res.status(200).json({ ok: true });
}));

// Same IP-keyed brute-force posture as signup/login — this is a public,
// unauthenticated endpoint (the whole point is the user can't log in).
const forgotPasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

/**
 * Request a password reset email (2026-07-13 backend audit #8). ALWAYS
 * returns 200 regardless of whether the email exists — never confirm/deny
 * account existence (same anti-enumeration posture as login's generic
 * "Invalid email or password"). If the account exists, a single-use,
 * 1-hour token is minted (opaque, SHA-256 hash in the DB — same pattern as
 * every other token surface in this app) and emailed via the existing
 * swappable notification provider.
 */
router.post("/forgot-password", forgotPasswordRateLimiter, asyncHandler(async (req, res) => {
  let input;
  try {
    input = forgotPasswordSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.flatten() });
    }
    throw err;
  }

  const found = await prisma.user.findUnique({ where: { email: input.email } });

  if (found) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await prisma.passwordResetToken.create({
      data: { userId: found.id, tokenHash, expiresAt },
    });

    const resetUrl = `${FRONTEND_ORIGIN}/reset-password?token=${rawToken}`;
    sendPasswordResetEmail({ toEmail: found.email, resetUrl }).catch((err) => {
      logger.error({ err, userId: found.id }, "failed to send password reset email");
    });
  }

  // Identical response whether or not the account exists.
  return res.status(200).json({ ok: true });
}));

/**
 * Redeem a password-reset token (2026-07-13 backend audit #8). Single-use —
 * `usedAt` is set the moment it's redeemed, so a replayed/reused link 404s
 * exactly like an unknown one (never distinguishable, same anti-enumeration
 * posture as every other token surface). Revokes EVERY session for the
 * user, including the one that requested the reset (unlike change-password
 * above) — the whole scenario here is "I couldn't log in," so there's no
 * "current session" to preserve, and if the account was actually
 * compromised, a full logout-everywhere is the correct response.
 */
router.post("/reset-password", forgotPasswordRateLimiter, asyncHandler(async (req, res) => {
  let input;
  try {
    input = resetPasswordSchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.flatten() });
    }
    throw err;
  }

  const tokenHash = hashToken(input.token);
  const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired" });
  }

  const newPasswordHash = await bcrypt.hash(input.newPassword, BCRYPT_COST_FACTOR);

  await prisma.$transaction([
    prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash: newPasswordHash } }),
    prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
    prisma.session.updateMany({
      where: { userId: resetToken.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  return res.status(200).json({ ok: true });
}));

// Same brute-force posture as loginRateLimiter — this endpoint takes a
// password guess, same abuse shape as login itself.
const deleteAccountRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTestEnv ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

/**
 * Account deletion (2026-07-13 backend audit #4 — the roadmap's own GDPR
 * promise: "delete endpoint removes all data including S3 objects"). Requires
 * re-entering the current password in the body — the single most destructive,
 * irreversible action in the app deserves its own confirmation step, not just
 * an active session.
 *
 * Order matters: best-effort EXTERNAL cleanup (S3 objects, the Rekognition
 * face collection) happens FIRST, while the DB rows (s3Key, ownerId) still
 * exist to look them up — then the User row is deleted, and Prisma's own
 * cascades (every Photo/Folder/Collection/Session/GuestUser -> User relation
 * is onDelete: Cascade) remove every other DB row in one transaction. The
 * audit row is written before the delete and has NO FK relation to User, so
 * it durably survives the account's own deletion.
 */
router.delete("/me", requireAuth, deleteAccountRateLimiter, asyncHandler(async (req, res) => {
  const { password } = (req.body ?? {}) as { password?: unknown };
  if (typeof password !== "string" || password.length === 0) {
    return res.status(400).json({ error: "Password confirmation is required" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    // Session outlived the user row somehow — treat as already-deleted.
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return res.status(200).json({ deleted: true });
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  await purgeAllStorageForOwner(user.id);
  await deleteFaceCollection(user.id);

  logAudit({
    actorType: "owner",
    actorId: user.id,
    ownerId: user.id,
    action: "account_deleted",
    resourceType: "user",
    resourceId: user.id,
    metadata: { email: user.email },
  });

  await prisma.user.delete({ where: { id: user.id } });

  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  return res.status(200).json({ deleted: true });
}));

export default router;
