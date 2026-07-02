import bcrypt from "bcryptjs";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/prisma";
import { createSession, revokeSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "../lib/session";
import { loginSchema, signupSchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

const BCRYPT_COST_FACTOR = 12; // per roadmap §12

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
router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  return res.status(200).json({ user: req.user });
}));

export default router;
