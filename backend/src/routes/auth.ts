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
// Keyed by IP; 5 attempts / 15 minutes, matching the acceptance criteria.
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

router.post("/signup", authRateLimiter, asyncHandler(async (req, res) => {
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

router.post("/login", authRateLimiter, asyncHandler(async (req, res) => {
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
