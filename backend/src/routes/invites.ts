import type { Request } from "express";
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import {
  createGuestSessionFromHash,
  GUEST_SESSION_COOKIE_NAME,
  guestSessionCookieOptions,
  guestSessionTtlHours,
  hashGuestToken,
} from "../lib/guestSession";
import { getExposedOtp, sendOwnerOtp } from "../lib/notifications";
import { generateOtp, hashOtp } from "../lib/otp";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  inviteRequestRateLimiter,
  inviteStatusRateLimiter,
} from "../middleware/inviteRateLimiter";

/**
 * Public (unauthenticated) invite-entry routes (specs/guest-access-otp.md §5).
 * Highest-abuse surface here — own IP-keyed rate-limit bucket (§6). Invalid
 * tokens ALWAYS return a generic 404 (never confirm token validity, to
 * defeat enumeration). The OTP goes to the OWNER; the guest never types it.
 *
 * Decision G7 handoff (kept deliberately localized to this router so a later
 * change is contained): the owner's approve call only flips the request to
 * `approved`. The GUEST SESSION is minted HERE, exactly once, by the guest's
 * own status poll the first time it observes `approved` — the poll mints a
 * fresh opaque token (raw -> httpOnly guest cookie on the polling browser,
 * SHA-256 hash -> guest_sessions, mirroring owner sessions), then latches
 * `sessionClaimedAt` so a concurrent double-poll can't mint two sessions. The
 * raw guest token therefore never reaches the owner and is never persisted
 * anywhere (only its hash). Session lifetime is capped at the earliest live
 * permission expiry (decision G2).
 */
const router = Router();

const OTP_TTL_MS = 5 * 60 * 1000; // 5 min (roadmap §12, decision G1)

function clientIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function deviceInfo(req: Request): { userAgent: string | null } {
  return { userAgent: req.get("user-agent") ?? null };
}

// Compute the session expiry cap = min(TTL, earliest live permission expiry).
async function computeSessionExpiry(guestUserId: string): Promise<Date> {
  const now = new Date();
  const livePermissions = await prisma.folderPermission.findMany({
    where: {
      guestUserId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { expiresAt: true },
  });
  const ttlExpiry = new Date(Date.now() + guestSessionTtlHours() * 60 * 60 * 1000);
  const cap = livePermissions.reduce<Date | null>((earliest, p) => {
    if (!p.expiresAt) return earliest;
    if (!earliest || p.expiresAt.getTime() < earliest.getTime()) return p.expiresAt;
    return earliest;
  }, null);
  return cap && cap.getTime() < ttlExpiry.getTime() ? cap : ttlExpiry;
}

// GET /api/invites/requests/:requestId/status — MUST be registered BEFORE the
// :token/request route so the literal "requests" segment isn't swallowed by
// the :token param (same lesson as /api/photos/unfiled vs /:id).
router.get(
  "/requests/:requestId/status",
  inviteStatusRateLimiter,
  asyncHandler(async (req, res) => {
    const ar = await prisma.accessRequest.findUnique({ where: { id: req.params.requestId } });
    // Unknown requestId -> 404 (requestId is an unguessable UUID; no
    // enumeration of others' requests).
    if (!ar) return res.status(404).json({ error: "Request not found" });

    // G7 handoff: on the FIRST poll observing `approved` before the session
    // has been claimed, mint the guest session and set the cookie on THIS
    // (the guest's) browser. Claim-once via an atomic latch on sessionClaimedAt.
    if (ar.status === "approved" && !ar.sessionClaimedAt) {
      const claimed = await prisma.accessRequest.updateMany({
        where: { id: ar.id, status: "approved", sessionClaimedAt: null },
        data: { sessionClaimedAt: new Date() },
      });
      if (claimed.count === 1) {
        // We won the claim — mint the session now.
        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = hashGuestToken(rawToken);
        const expiresAt = await computeSessionExpiry(ar.guestUserId);
        await createGuestSessionFromHash(ar.guestUserId, tokenHash, expiresAt, {
          ip: clientIp(req),
          userAgent: deviceInfo(req).userAgent,
        });
        res.cookie(GUEST_SESSION_COOKIE_NAME, rawToken, guestSessionCookieOptions());
      }
      // If we lost the claim (a concurrent poll already minted), we simply
      // don't set a cookie on this response — the winning poll's response
      // carried the cookie. status stays 'approved'.
    }

    return res.status(200).json({ status: ar.status });
  }),
);

// GET /api/invites/requests/:requestId/otp — TEST/DEV-ONLY. Exposes the
// plaintext OTP for a request so the Tester Agent can complete the flow
// without DB access. Gated: returns 404 unless NOTIFICATIONS_EXPOSE_OTP ===
// "true" or NODE_ENV === "test" (the mock's getExposedOtp() itself refuses
// outside those modes). Never wired for real users.
router.get(
  "/requests/:requestId/otp",
  inviteStatusRateLimiter,
  asyncHandler(async (req, res) => {
    const code = getExposedOtp(req.params.requestId);
    if (!code) return res.status(404).json({ error: "Not available" });
    return res.status(200).json({ otp: code });
  }),
);

// POST /api/invites/:token/request — guest opens the link, requests access.
router.post(
  "/:token/request",
  inviteRequestRateLimiter,
  asyncHandler(async (req, res) => {
    const tokenHash = hashGuestToken(req.params.token);
    const invite = await prisma.inviteToken.findUnique({
      where: { tokenHash },
      include: { guestUser: { include: { owner: true } } },
    });

    const now = Date.now();
    const invalid =
      !invite ||
      !invite.isActive ||
      (invite.expiresAt && invite.expiresAt.getTime() < now) ||
      (invite.maxUses != null && invite.useCount >= invite.maxUses);
    if (invalid || !invite) {
      // Generic 404 for every failure mode — no enumeration signal.
      return res.status(404).json({ error: "Invite not found" });
    }

    // G10 re-click: a live session already exists -> already_approved, no new OTP.
    const liveSession = await prisma.guestSession.findFirst({
      where: {
        guestUserId: invite.guestUserId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (liveSession) {
      return res.status(200).json({ status: "already_approved" });
    }

    // G10 re-click: an unexpired pending request already exists -> reuse it
    // (don't spam the owner with a fresh OTP per click).
    const existingPending = await prisma.accessRequest.findFirst({
      where: {
        inviteTokenId: invite.id,
        status: "pending",
        otpExpiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existingPending) {
      return res.status(200).json({ requestId: existingPending.id, status: "pending" });
    }

    // Fresh request: generate + hash OTP, store hash + 5-min expiry, hand the
    // plaintext to the mock provider addressed to the OWNER.
    const code = generateOtp();
    const otpHash = hashOtp(code);
    const otpExpiresAt = new Date(now + OTP_TTL_MS);

    const ar = await prisma.accessRequest.create({
      data: {
        inviteTokenId: invite.id,
        guestUserId: invite.guestUserId,
        ipAddress: clientIp(req),
        deviceInfo: deviceInfo(req),
        status: "pending",
        otpHash,
        otpExpiresAt,
        otpAttempts: 0,
      },
    });

    await sendOwnerOtp({
      ownerEmail: invite.guestUser.owner.email,
      ownerName: invite.guestUser.owner.name,
      guestEmail: invite.guestUser.email,
      code, // plaintext hits the mock only — never persisted, never returned here
      requestId: ar.id,
    });

    return res.status(200).json({ requestId: ar.id, status: "pending" });
  }),
);

export default router;
