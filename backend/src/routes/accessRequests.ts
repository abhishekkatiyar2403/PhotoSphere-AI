import { Router } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { prisma } from "../lib/prisma";
import { verifyOtp } from "../lib/otp";
import { accessRequestsQuerySchema, approveAccessRequestSchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";
import { publishEvent, streamChannel } from "../lib/sse";

/**
 * Owner OTP-approval routes (specs/guest-access-otp.md §5). Every route:
 * requireAuth + 404 (never 403) when the access_request doesn't belong to one
 * of THIS owner's guests. The OTP gate (roadmap §12 Layer 5): 5-min TTL,
 * single-use, constant-time compare, 3 wrong attempts -> auto-deny.
 *
 * approve/deny/revoke are the single choke-point handlers the audit log
 * (Week 11-12, decision G9) will hook into without a refactor.
 */
const router = Router();

const MAX_OTP_ATTEMPTS = 3; // decision G1 (roadmap §12)

// Fetch an access request only if it belongs to one of this owner's guests.
// Returns null otherwise so callers can 404 uniformly (never confirm existence).
async function findOwnedRequest(requestId: string, ownerId: string) {
  const ar = await prisma.accessRequest.findUnique({
    where: { id: requestId },
    include: { guestUser: true },
  });
  if (!ar || ar.guestUser.createdBy !== ownerId) return null;
  return ar;
}

// GET /api/access-requests/stream — real-time push (replaces the Share
// page's old fixed-interval poll). One SSE connection per owner tab,
// subscribed to this owner's own Redis channel; a "access_request_created"
// event fires the moment a guest requests access (see routes/invites.ts),
// so the approval card appears without a reload. Registered before the
// plain GET "/" below only by convention (no actual path collision - this
// is a literal segment, not a param).
router.get(
  "/stream",
  requireAuth,
  (req, res) => {
    streamChannel(req, res, `sse:owner:${req.user!.id}`);
  },
);

// GET /api/access-requests?status=pending — the owner's approval queue.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let query;
    try {
      query = accessRequestsQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;
    const requests = await prisma.accessRequest.findMany({
      where: {
        guestUser: { createdBy: ownerId },
        ...(query.status === "all" ? {} : { status: query.status }),
      },
      orderBy: { createdAt: "desc" },
      include: {
        guestUser: { select: { id: true, email: true, name: true } },
        // Link-forwarding detection: every click recorded while this
        // request was pending (see POST /api/invites/:token/request).
        touches: { select: { ipAddress: true }, orderBy: { createdAt: "asc" } },
      },
    });

    return res.status(200).json({
      requests: requests.map((r) => {
        // Distinct IPs that touched this request — >1 means the invite link
        // was opened from more than one place before it was resolved, which
        // is exactly what link-forwarding looks like (the guest sharing the
        // link with someone else, or the same person switching networks —
        // this can't tell those apart, it's a signal to review, not proof).
        // A null IP (e.g. local dev) counts as its own bucket so it doesn't
        // silently collapse into a false "only one device" read.
        const distinctIps = new Set(r.touches.map((t) => t.ipAddress ?? "unknown"));
        return {
          id: r.id,
          status: r.status,
          guest: { id: r.guestUser.id, email: r.guestUser.email, name: r.guestUser.name },
          ipAddress: r.ipAddress,
          deviceInfo: r.deviceInfo,
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
          touchCount: r.touches.length,
          distinctDeviceCount: distinctIps.size,
          multipleDevicesDetected: distinctIps.size > 1,
          // Never expose otpHash / session-claim internals.
        };
      }),
    });
  }),
);

// POST /api/access-requests/:id/approve — owner submits the OTP they received.
router.post(
  "/:id/approve",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = approveAccessRequestSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;
    const ar = await findOwnedRequest(req.params.id, ownerId);
    if (!ar) return res.status(404).json({ error: "Access request not found" });

    if (ar.status === "approved") {
      return res.status(409).json({ error: "Request already approved" });
    }
    if (ar.status === "denied" || ar.status === "expired") {
      // Auto-denied (attempt cap) or otherwise resolved-negative.
      return res.status(403).json({ error: "Request denied" });
    }

    // Expiry check (5-min TTL) — reject even a correct code after expiry.
    if (!ar.otpExpiresAt || ar.otpExpiresAt.getTime() < Date.now()) {
      await prisma.accessRequest.update({
        where: { id: ar.id },
        data: { status: "expired", otpHash: null, resolvedAt: new Date(), resolvedBy: ownerId },
      });
      // Audit (specs/audit-and-polish.md §A2): access_denied, reason=otp_expired.
      logAudit({
        actorType: "owner",
        actorId: ownerId,
        ownerId,
        action: "access_denied",
        resourceType: "access_request",
        resourceId: ar.id,
        metadata: { guestEmail: ar.guestUser.email, reason: "otp_expired" },
        ipAddress: req.ip ?? null,
      });
      publishEvent(`sse:access-request:${ar.id}`, { type: "status_changed", status: "expired" });
      return res.status(403).json({ error: "OTP expired" });
    }

    // Constant-time compare against the stored hash.
    const matches = verifyOtp(input.otp, ar.otpHash);

    if (!matches) {
      const nextAttempts = ar.otpAttempts + 1;
      if (nextAttempts >= MAX_OTP_ATTEMPTS) {
        // 3rd wrong -> auto-deny, clear the hash so no further guess is possible.
        await prisma.accessRequest.update({
          where: { id: ar.id },
          data: {
            otpAttempts: nextAttempts,
            status: "denied",
            otpHash: null,
            resolvedAt: new Date(),
            resolvedBy: ownerId,
          },
        });
        // Audit: access_denied, reason=otp_attempts_exceeded (auto-deny).
        logAudit({
          actorType: "owner",
          actorId: ownerId,
          ownerId,
          action: "access_denied",
          resourceType: "access_request",
          resourceId: ar.id,
          metadata: { guestEmail: ar.guestUser.email, reason: "otp_attempts_exceeded" },
          ipAddress: req.ip ?? null,
        });
        publishEvent(`sse:access-request:${ar.id}`, { type: "status_changed", status: "denied" });
        return res.status(403).json({ error: "Request denied after too many incorrect codes" });
      }
      await prisma.accessRequest.update({
        where: { id: ar.id },
        data: { otpAttempts: nextAttempts },
      });
      return res.status(401).json({ error: "Invalid code" });
    }

    // Match. Flip to `approved` and invalidate the OTP (single-use). The
    // guest SESSION is NOT minted here — decision G7 mints it exactly once on
    // the guest's own status poll (routes/invites.ts), so the raw guest token
    // never touches the owner's screen or any copy-paste path. Increment the
    // invite's use_count on this single successful approval.
    const now = new Date();
    await prisma.$transaction([
      prisma.accessRequest.update({
        where: { id: ar.id },
        data: {
          status: "approved",
          otpHash: null, // single-use: a replay of the same code now fails
          resolvedAt: now,
          resolvedBy: ownerId,
        },
      }),
      prisma.inviteToken.update({
        where: { id: ar.inviteTokenId },
        data: { useCount: { increment: 1 } },
      }),
    ]);

    // Audit (specs/audit-and-polish.md §A2): access_approved, POST-commit.
    logAudit({
      actorType: "owner",
      actorId: ownerId,
      ownerId,
      action: "access_approved",
      resourceType: "access_request",
      resourceId: ar.id,
      metadata: { guestEmail: ar.guestUser.email },
      ipAddress: req.ip ?? null,
    });
    publishEvent(`sse:access-request:${ar.id}`, { type: "status_changed", status: "approved" });

    return res.status(200).json({ status: "approved" });
  }),
);

// POST /api/access-requests/:id/deny — owner rejects.
router.post(
  "/:id/deny",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user!.id;
    const ar = await findOwnedRequest(req.params.id, ownerId);
    if (!ar) return res.status(404).json({ error: "Access request not found" });

    if (ar.status === "approved") {
      return res.status(409).json({ error: "Request already approved" });
    }
    if (ar.status === "denied" || ar.status === "expired") {
      // Idempotent-ish: already negative-resolved.
      return res.status(200).json({ status: "denied" });
    }

    await prisma.accessRequest.update({
      where: { id: ar.id },
      data: {
        status: "denied",
        otpHash: null,
        resolvedAt: new Date(),
        resolvedBy: ownerId,
      },
    });

    // Audit (specs/audit-and-polish.md §A2): access_denied, reason=owner_denied.
    // Only on this real state-transition deny — the idempotent
    // already-denied/expired branch above returns early without a new row.
    logAudit({
      actorType: "owner",
      actorId: ownerId,
      ownerId,
      action: "access_denied",
      resourceType: "access_request",
      resourceId: ar.id,
      metadata: { guestEmail: ar.guestUser.email, reason: "owner_denied" },
      ipAddress: req.ip ?? null,
    });
    publishEvent(`sse:access-request:${ar.id}`, { type: "status_changed", status: "denied" });

    return res.status(200).json({ status: "denied" });
  }),
);

export default router;
