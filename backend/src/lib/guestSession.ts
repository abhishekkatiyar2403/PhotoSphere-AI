import crypto from "node:crypto";
import { prisma } from "./prisma";

/**
 * Guest session helper (specs/guest-access-otp.md §2). Mirrors lib/session.ts
 * one-to-one but for GUESTS — deliberately kept SEPARATE from the owner
 * session helper (do not overload session.ts with a guest branch), the same
 * way the auth/upload/reclassify rate limiters are separate buckets.
 *
 * Opaque tokens, never JWT: `crypto.randomBytes(32).toString("hex")` raw to
 * the client's httpOnly cookie, SHA-256 hash to the DB, checked server-side on
 * every guest request so revocation is instant and durable.
 *
 * Distinct cookie name so an owner previewing their own share can hold BOTH
 * the owner and guest cookies simultaneously without collision.
 */

export const GUEST_SESSION_COOKIE_NAME = "photosphere_guest_session";

// Decision G2: guest sessions expire (roadmap §6 omits this — a deliberate,
// flagged deviation). Default 24h, capped by the caller at
// min(this, earliest live permission expiry) so a session can't outlive its
// grant. `GUEST_SESSION_TTL_HOURS` env overrides the default.
const TTL_HOURS = Number(process.env.GUEST_SESSION_TTL_HOURS ?? 24);

export function guestSessionTtlHours(): number {
  return TTL_HOURS;
}

function generateRawToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashGuestToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Mint a guest session. `expiresAt` is capped at min(TTL, cap) when a cap
 * (earliest live permission expiry) is supplied, so the session can never
 * outlive the grant (decision G2). Returns the raw token (client-only) and
 * the SHA-256 hash (for the caller to stash on the access_request during the
 * G7 handoff, or to set the cookie directly).
 */
export async function createGuestSession(
  guestUserId: string,
  opts: { ip?: string | null; userAgent?: string | null; cap?: Date | null } = {},
): Promise<{ rawToken: string; tokenHash: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const tokenHash = hashGuestToken(rawToken);

  const ttlExpiry = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);
  const expiresAt =
    opts.cap && opts.cap.getTime() < ttlExpiry.getTime() ? opts.cap : ttlExpiry;

  await prisma.guestSession.create({
    data: {
      guestUserId,
      tokenHash,
      ipAddress: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      expiresAt,
    },
  });

  return { rawToken, tokenHash, expiresAt };
}

/**
 * Persist a pre-minted session row directly from its hash (used by the G7
 * handoff: the session is minted at owner-approval time, its hash stashed on
 * the access_request, then this row is created when the guest's status poll
 * claims it). Kept as a distinct entry point from createGuestSession so the
 * approval path can generate the raw token, hand back only the hash, and let
 * the poll materialize the row exactly once.
 */
export async function createGuestSessionFromHash(
  guestUserId: string,
  tokenHash: string,
  expiresAt: Date,
  opts: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  await prisma.guestSession.create({
    data: {
      guestUserId,
      tokenHash,
      ipAddress: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      expiresAt,
    },
  });
}

/** The active guest (+ session) for a raw cookie token, or null if invalid/revoked/expired. */
export async function getGuestSession(rawToken: string | undefined) {
  if (!rawToken) return null;

  const tokenHash = hashGuestToken(rawToken);
  const session = await prisma.guestSession.findUnique({
    where: { tokenHash },
    include: { guestUser: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;

  return session;
}

/** Revoke every session for a guest — the instant cut-off used by DELETE /api/guests/:id. */
export async function revokeGuestSessionsForGuest(guestUserId: string): Promise<void> {
  await prisma.guestSession.updateMany({
    where: { guestUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function guestSessionCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd, // Secure requires HTTPS; local Compose dev is plain HTTP (mirrors owner cookie)
    sameSite: "lax" as const,
    maxAge: TTL_HOURS * 60 * 60 * 1000,
    path: "/",
  };
}
