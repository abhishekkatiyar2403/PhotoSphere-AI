import crypto from "node:crypto";
import { Router } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { hashGuestToken, revokeGuestSessionsForGuest } from "../lib/guestSession";
import { prisma } from "../lib/prisma";
import { createGuestSchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";

/**
 * Owner share-management routes (specs/guest-access-otp.md §5). Every route:
 * requireAuth + Zod + 404 (never 403) on any folder/guest not owned by the
 * caller. The invite token is opaque (raw hex to the link, SHA-256 hash to
 * the DB) — the raw token is returned exactly once, at creation.
 */
const router = Router();

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";

function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// POST /api/guests — create a share: a guest_user, an invite_token (hash
// stored), and one folder_permission per selected folder. All-or-nothing:
// if any folderId isn't owned by the caller, 404 and create NOTHING.
router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = createGuestSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;
    const uniqueFolderIds = [...new Set(input.folderIds)];

    // Validate EVERY folder belongs to a collection this owner owns. 404 on
    // any miss, before any write — never partially create.
    const folders = await prisma.folder.findMany({
      where: { id: { in: uniqueFolderIds } },
      include: { collection: { select: { id: true, ownerId: true } } },
    });
    const ownedFolders = folders.filter((f) => f.collection.ownerId === ownerId);
    if (ownedFolders.length !== uniqueFolderIds.length) {
      // Some folder id was missing or not owned — indistinguishable to the
      // caller (404, never 403, never confirm which).
      return res.status(404).json({ error: "One or more folders not found" });
    }

    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    // The invite carries an informational collection_id (decision G3): the
    // collection the folders belong to. Real scope is folder_permissions.
    const collectionId = ownedFolders[0].collection.id;

    const rawToken = generateInviteToken();
    const tokenHash = hashGuestToken(rawToken);

    const guest = await prisma.$transaction(async (tx) => {
      const guestUser = await tx.guestUser.create({
        data: {
          email: input.guestEmail,
          name: input.guestName ?? null,
          createdBy: ownerId,
        },
      });

      await tx.inviteToken.create({
        data: {
          tokenHash,
          guestUserId: guestUser.id,
          collectionId,
          createdBy: ownerId,
          maxUses: 1, // decision G6: one named guest, no link-forwarding
          expiresAt,
          isActive: true,
        },
      });

      await tx.folderPermission.createMany({
        data: ownedFolders.map((f) => ({
          guestUserId: guestUser.id,
          folderId: f.id,
          permissionLevel: input.permissionLevel,
          expiresAt,
          grantedBy: ownerId,
        })),
      });

      return guestUser;
    });

    // The frontend maps /g/:token -> POST /api/invites/:token/request. The raw
    // token is surfaced HERE, once — never persisted in plaintext.
    const inviteUrl = `${FRONTEND_ORIGIN}/g/${rawToken}`;

    return res.status(201).json({
      guestId: guest.id,
      inviteToken: rawToken,
      inviteUrl,
      expiresAt,
    });
  }),
);

// GET /api/guests — all guests this owner created, each with a derived status.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user!.id;
    const now = Date.now();

    const guests = await prisma.guestUser.findMany({
      where: { createdBy: ownerId },
      orderBy: { createdAt: "desc" },
      include: {
        inviteTokens: true,
        folderPermissions: { include: { folder: { select: { id: true, name: true } } } },
        guestSessions: true,
      },
    });

    const items = guests.map((g) => {
      const anyActivePermission = g.folderPermissions.some(
        (p) => !p.revokedAt && (!p.expiresAt || p.expiresAt.getTime() > now),
      );
      const allRevoked =
        g.folderPermissions.length > 0 && g.folderPermissions.every((p) => p.revokedAt);
      const anyLiveSession = g.guestSessions.some(
        (s) => !s.revokedAt && s.expiresAt.getTime() > now,
      );

      // Derived status: revoked (owner cut them off) > expired (grant lapsed)
      // > active (has a live session) > pending (invited, not yet in).
      let status: "pending" | "active" | "revoked" | "expired";
      if (allRevoked || g.inviteTokens.every((t) => !t.isActive)) {
        status = "revoked";
      } else if (!anyActivePermission) {
        status = "expired";
      } else if (anyLiveSession) {
        status = "active";
      } else {
        status = "pending";
      }

      const lastUsedAt = g.guestSessions.reduce<Date | null>((latest, s) => {
        if (!latest || s.lastUsedAt.getTime() > latest.getTime()) return s.lastUsedAt;
        return latest;
      }, null);

      const permissionLevel = g.folderPermissions[0]?.permissionLevel ?? null;

      return {
        id: g.id,
        email: g.email,
        name: g.name,
        status,
        permissionLevel,
        folders: g.folderPermissions.map((p) => ({ id: p.folder.id, name: p.folder.name })),
        lastAccessAt: lastUsedAt,
        createdAt: g.createdAt,
      };
    });

    return res.status(200).json({ guests: items });
  }),
);

// DELETE /api/guests/:id — one-tap revoke. Instantly cuts off access:
// invite deactivated, all permissions revoked, all sessions revoked, any
// pending access requests denied. Idempotent. 404 if not this owner's guest.
router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user!.id;
    const guest = await prisma.guestUser.findUnique({ where: { id: req.params.id } });
    if (!guest || guest.createdBy !== ownerId) {
      return res.status(404).json({ error: "Guest not found" });
    }

    const now = new Date();
    await prisma.$transaction([
      prisma.inviteToken.updateMany({
        where: { guestUserId: guest.id, isActive: true },
        data: { isActive: false },
      }),
      prisma.folderPermission.updateMany({
        where: { guestUserId: guest.id, revokedAt: null },
        data: { revokedAt: now },
      }),
      prisma.accessRequest.updateMany({
        where: { guestUserId: guest.id, status: "pending" },
        data: { status: "denied", otpHash: null, resolvedAt: now, resolvedBy: ownerId },
      }),
    ]);
    // Session revoke is its own helper (mirrors the owner-session helper);
    // run after the txn so the choke-point liveness filter already reflects
    // the revoked permissions too.
    await revokeGuestSessionsForGuest(guest.id);

    return res.status(200).json({ ok: true });
  }),
);

export default router;
