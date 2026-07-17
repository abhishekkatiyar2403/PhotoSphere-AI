import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getGuestSession, GUEST_SESSION_COOKIE_NAME } from "../lib/guestSession";
import { prisma } from "../lib/prisma";

// Augment Express's Request with the resolved guest, attached by this
// middleware after validating the opaque guest session token against Postgres
// (never a JWT check — opaque tokens are checked server-side on every request
// so an owner's revoke is instant and durable). Kept separate from
// req.user (owner) so a logged-in owner previewing a share never collides.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      guest?: {
        guestUserId: string;
        sessionId: string;
      };
    }
  }
}

export const requireGuest = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const rawToken = req.cookies?.[GUEST_SESSION_COOKIE_NAME];
  const session = await getGuestSession(rawToken);

  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Fire-and-forget (2026-07-13 backend audit #17): lastUsedAt was set once
  // at session CREATION and never touched again, but routes/guests.ts
  // surfaces it to the owner as "last access" — actively misleading (it was
  // really "first access"). Update on every authenticated request rather than
  // await it inline — this is telemetry, not something a request should ever
  // wait on or fail because of.
  prisma.guestSession
    .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  req.guest = { guestUserId: session.guestUserId, sessionId: session.id };
  next();
});

/**
 * THE single scope choke point (specs/guest-access-otp.md §3). Returns the set
 * of folder IDs this guest currently has a LIVE permission for — live means
 * `revokedAt = null` AND (`expiresAt` null OR in the future). EVERY guest
 * folder/photo query MUST filter against this set; anything outside it is 404.
 * This is what makes cross-scope leakage structurally impossible: a folder or
 * photo the owner owns but didn't share (or a completely different owner's
 * photo) simply isn't in the set, so it's indistinguishable from nonexistent.
 *
 * specs/trash-system.md audit row #15: a TRASHED folder is excluded from this
 * set even if the guest's `folder_permission` row is still technically live
 * (never explicitly revoked) — the OWNER trashing the folder makes it
 * disappear from the guest's view exactly like an explicit revoke would.
 * Filtered HERE, at the single choke point, so every downstream guest route
 * (#16/#17/#18/#19) inherits the exclusion automatically via membership
 * checks against this set — no per-route duplication needed.
 */
export async function getPermittedFolderIds(guestUserId: string): Promise<Set<string>> {
  const now = new Date();
  const permissions = await prisma.folderPermission.findMany({
    where: {
      guestUserId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      folder: { deletedAt: null },
    },
    select: { folderId: true },
  });
  return new Set(permissions.map((p) => p.folderId));
}

/**
 * The live permission LEVEL for a specific folder (or null if not permitted).
 * Used by the download endpoint to enforce view vs download/download_all.
 * Applies the same liveness filter as getPermittedFolderIds so a revoked or
 * expired grant reports null, never a stale level.
 */
export async function getFolderPermissionLevel(
  guestUserId: string,
  folderId: string,
): Promise<string | null> {
  const now = new Date();
  const permission = await prisma.folderPermission.findFirst({
    where: {
      guestUserId,
      folderId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { permissionLevel: true },
  });
  return permission?.permissionLevel ?? null;
}
