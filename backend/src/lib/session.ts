import crypto from "node:crypto";
import { prisma } from "./prisma";

export const SESSION_COOKIE_NAME = "photosphere_session";

const TTL_HOURS = Number(process.env.SESSION_TOKEN_TTL_HOURS ?? 168); // 7 days default

/**
 * Opaque session tokens, never JWT (per project ground rules). The raw
 * token only ever lives in the client's cookie; the DB stores a SHA-256
 * hash of it so a DB leak alone can't be used to forge/replay sessions,
 * mirroring the roadmap's `invite_tokens.token_hash` pattern.
 */
function generateRawToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export async function createSession(userId: string) {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);

  await prisma.session.create({
    data: { userId, tokenHash, expiresAt },
  });

  return { rawToken, expiresAt };
}

/** Returns the active user for a raw cookie token, or null if invalid/expired/revoked. */
export async function getSessionUser(rawToken: string | undefined) {
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;

  return session.user;
}

export async function revokeSession(rawToken: string | undefined) {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await prisma.session.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd, // Secure requires HTTPS; local Compose dev is plain HTTP (spec Open Question 5)
    sameSite: "lax" as const,
    maxAge: TTL_HOURS * 60 * 60 * 1000,
    path: "/",
  };
}
