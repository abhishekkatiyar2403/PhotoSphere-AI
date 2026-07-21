import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { hashGuestToken, revokeGuestSessionsForGuest } from "../lib/guestSession";
import { prisma } from "../lib/prisma";
import {
  addGuestFoldersSchema,
  createGuestSchema,
  sendGuestInviteSchema,
  updateGuestPermissionSchema,
} from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";
import { checkGuestLimit } from "../lib/plans";
import { sendGuestInviteEmail } from "../lib/notifications";
import { logger } from "../lib/logger";
import { publishEvent } from "../lib/sse";

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

    // Plan enforcement (2026-07-13 backend audit #7): free tier caps active
    // guests. Checked before any write, same "reject before creating
    // anything" posture as the folder-ownership check right below.
    const limitError = await checkGuestLimit(ownerId);
    if (limitError) {
      return res.status(402).json({ error: limitError });
    }

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

    // NOTE (2026-07-13, revised): does NOT auto-email the guest on creation.
    // Abhishek's call: generating the link and sending it are two separate,
    // owner-controlled steps — the frontend shows the link with a "Send"
    // button, and POST /api/guests/:id/send-invite (below) fires the actual
    // email only when clicked. This also matches how a real inbox works:
    // the owner sees the link BEFORE it goes anywhere, and can choose to
    // share it some other way (Slack, WhatsApp, in person) without an email
    // going out at all.

    // Audit (specs/audit-and-polish.md §A2): fire-and-forget, POST-commit — the
    // share is already created. A failed audit write can't undo it.
    logAudit({
      actorType: "owner",
      actorId: ownerId,
      ownerId,
      action: "share_created",
      resourceType: "guest",
      resourceId: guest.id,
      metadata: {
        guestEmail: input.guestEmail,
        folderIds: ownedFolders.map((f) => f.id),
        folderNames: ownedFolders.map((f) => f.name),
        permissionLevel: input.permissionLevel,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
      ipAddress: req.ip ?? null,
    });

    return res.status(201).json({
      guestId: guest.id,
      inviteToken: rawToken,
      inviteUrl,
      expiresAt,
    });
  }),
);

// Resend-friendly: an owner clicking "Send" a second time (guest says they
// didn't get it) shouldn't be blocked, but this is still a real email-send
// button reachable by anyone with a session — cap it well above normal use.
const sendInviteRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many invite emails sent. Please try again later." },
});

/**
 * POST /api/guests/:id/send-invite — the explicit "Send" action (2026-07-13,
 * revised #9): generating the link (POST /api/guests above) and emailing it
 * are two separate, owner-controlled steps. The frontend already has the
 * inviteUrl from the create response (or from a page that still has it in
 * memory) and passes it back here — the backend never re-derives or
 * re-persists the raw token (only its hash exists in the DB, by design), so
 * this is the only way to (re)send it. Safe to call more than once — each
 * click is just another email.
 */
router.post(
  "/:id/send-invite",
  requireAuth,
  sendInviteRateLimiter,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = sendGuestInviteSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;
    const guest = await prisma.guestUser.findUnique({ where: { id: req.params.id } });
    if (!guest || guest.createdBy !== ownerId) {
      return res.status(404).json({ error: "Guest not found" });
    }

    try {
      await sendGuestInviteEmail({
        guestEmail: guest.email,
        ownerName: req.user!.name,
        inviteUrl: input.inviteUrl,
      });
    } catch (err) {
      logger.error({ err, guestId: guest.id }, "failed to send guest invite email");
      return res.status(502).json({ error: "Failed to send the invite email. Please try again." });
    }

    return res.status(200).json({ sent: true });
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

      // Only LIVE (non-revoked, non-expired) permissions represent what this
      // guest can currently see — a fully- or per-folder-revoked permission
      // shouldn't show up in "folders shared with them" (bug report: add/
      // remove individual folders needs this list to reflect CURRENT access,
      // not history).
      const livePermissions = g.folderPermissions.filter(
        (p) => !p.revokedAt && (!p.expiresAt || p.expiresAt.getTime() > now),
      );
      const permissionLevel = livePermissions[0]?.permissionLevel ?? g.folderPermissions[0]?.permissionLevel ?? null;

      return {
        id: g.id,
        email: g.email,
        name: g.name,
        status,
        permissionLevel,
        folders: livePermissions.map((p) => ({ id: p.folder.id, name: p.folder.name })),
        lastAccessAt: lastUsedAt,
        createdAt: g.createdAt,
      };
    });

    return res.status(200).json({ guests: items });
  }),
);

// PATCH /api/guests/:id — change an existing guest's permission level
// (bug report: previously the ONLY option once shared was Revoke — no way
// to e.g. start a guest at `view` and later upgrade them to `download`
// without tearing down and recreating the whole share). Applies the new
// level to every currently-live (non-revoked) folder_permission row this
// guest has — the same "one level per guest" model the GET /api/guests list
// already assumes (it surfaces folderPermissions[0].permissionLevel as THE
// guest's level). 404 if not owned. A guest with zero live permissions
// (fully revoked/expired) has nothing to update — 404, not a silent no-op.
router.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = updateGuestPermissionSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;
    const guest = await prisma.guestUser.findUnique({ where: { id: req.params.id } });
    if (!guest || guest.createdBy !== ownerId) {
      return res.status(404).json({ error: "Guest not found" });
    }

    const now = new Date();
    const result = await prisma.folderPermission.updateMany({
      where: {
        guestUserId: guest.id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { permissionLevel: input.permissionLevel },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: "Guest has no active shares to update" });
    }

    logAudit({
      actorType: "owner",
      actorId: ownerId,
      ownerId,
      action: "guest_permission_changed",
      resourceType: "guest",
      resourceId: guest.id,
      metadata: { guestEmail: guest.email, permissionLevel: input.permissionLevel, foldersUpdated: result.count },
      ipAddress: req.ip ?? null,
    });
    publishEvent(`sse:guest:${guest.id}`, { type: "permission_changed", permissionLevel: input.permissionLevel });

    return res.status(200).json({ ok: true, permissionLevel: input.permissionLevel, foldersUpdated: result.count });
  }),
);

// POST /api/guests/:id/folders — share one or more ADDITIONAL folders with
// an existing guest, without touching their existing shares (bug report:
// after approving a guest, there was no way to later share more folders with
// them, or to remove access to just one). All-or-nothing on ownership: if
// ANY requested folder isn't owned by this owner, 404 and add NOTHING.
// A folder already LIVE-shared with this guest is silently skipped
// (idempotent, not an error). A folder that was shared before and later
// individually removed (see DELETE below) gets its existing row REACTIVATED
// (revokedAt cleared) rather than a duplicate row — the schema has a
// (guestUserId, folderId) unique constraint, exactly one row per pair ever.
router.post(
  "/:id/folders",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = addGuestFoldersSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;
    const guest = await prisma.guestUser.findUnique({
      where: { id: req.params.id },
      include: { folderPermissions: true },
    });
    if (!guest || guest.createdBy !== ownerId) {
      return res.status(404).json({ error: "Guest not found" });
    }

    const uniqueFolderIds = [...new Set(input.folderIds)];
    const folders = await prisma.folder.findMany({
      where: { id: { in: uniqueFolderIds } },
      include: { collection: { select: { ownerId: true } } },
    });
    const ownedFolders = folders.filter((f) => f.collection.ownerId === ownerId);
    if (ownedFolders.length !== uniqueFolderIds.length) {
      return res.status(404).json({ error: "One or more folders not found" });
    }

    const now = new Date();
    // The guest's current level: any existing permission's level (this
    // model assumes one level per guest, same as PATCH above), else fall
    // back to "view" for a guest with no prior shares at all.
    const currentLevel =
      input.permissionLevel ??
      guest.folderPermissions.find((p) => p.revokedAt == null)?.permissionLevel ??
      guest.folderPermissions[0]?.permissionLevel ??
      "view";

    const existingByFolderId = new Map(guest.folderPermissions.map((p) => [p.folderId, p]));
    const added: string[] = [];

    for (const folder of ownedFolders) {
      const existing = existingByFolderId.get(folder.id);
      if (existing) {
        if (existing.revokedAt == null) continue; // already live — skip, idempotent
        await prisma.folderPermission.update({
          where: { id: existing.id },
          data: { revokedAt: null, permissionLevel: currentLevel, grantedBy: ownerId },
        });
      } else {
        await prisma.folderPermission.create({
          data: {
            guestUserId: guest.id,
            folderId: folder.id,
            permissionLevel: currentLevel,
            grantedBy: ownerId,
          },
        });
      }
      added.push(folder.id);
    }

    if (added.length > 0) {
      logAudit({
        actorType: "owner",
        actorId: ownerId,
        ownerId,
        action: "guest_folder_added",
        resourceType: "guest",
        resourceId: guest.id,
        metadata: {
          guestEmail: guest.email,
          folderIds: added,
          folderNames: ownedFolders.filter((f) => added.includes(f.id)).map((f) => f.name),
          permissionLevel: currentLevel,
        },
        ipAddress: req.ip ?? null,
      });
      publishEvent(`sse:guest:${guest.id}`, { type: "folders_added", folderIds: added });
    }

    return res.status(200).json({ ok: true, added, permissionLevel: currentLevel });
  }),
);

// DELETE /api/guests/:id/folders/:folderId — remove this guest's access to
// ONE specific folder, leaving every other folder they have untouched
// (unlike DELETE /api/guests/:id below, which revokes everything). 404 if
// the guest isn't owned, or has no LIVE permission on that folder already.
router.delete(
  "/:id/folders/:folderId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user!.id;
    const guest = await prisma.guestUser.findUnique({ where: { id: req.params.id } });
    if (!guest || guest.createdBy !== ownerId) {
      return res.status(404).json({ error: "Guest not found" });
    }

    const now = new Date();
    const result = await prisma.folderPermission.updateMany({
      where: { guestUserId: guest.id, folderId: req.params.folderId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (result.count === 0) {
      return res.status(404).json({ error: "This guest doesn't have active access to that folder" });
    }

    const folder = await prisma.folder.findUnique({ where: { id: req.params.folderId }, select: { name: true } });

    logAudit({
      actorType: "owner",
      actorId: ownerId,
      ownerId,
      action: "guest_folder_removed",
      resourceType: "guest",
      resourceId: guest.id,
      metadata: { guestEmail: guest.email, folderId: req.params.folderId, folderName: folder?.name ?? null },
      ipAddress: req.ip ?? null,
    });
    publishEvent(`sse:guest:${guest.id}`, { type: "folder_removed", folderId: req.params.folderId });

    return res.status(200).json({ ok: true });
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

    // Audit (specs/audit-and-polish.md §A2): fire-and-forget, POST-commit.
    logAudit({
      actorType: "owner",
      actorId: ownerId,
      ownerId,
      action: "guest_revoked",
      resourceType: "guest",
      resourceId: guest.id,
      metadata: { guestEmail: guest.email },
      ipAddress: req.ip ?? null,
    });
    publishEvent(`sse:guest:${guest.id}`, { type: "revoked" });

    return res.status(200).json({ ok: true });
  }),
);

export default router;
