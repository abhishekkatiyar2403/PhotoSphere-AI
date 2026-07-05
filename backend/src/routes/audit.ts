import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/prisma";
import { auditQuerySchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";

/**
 * Owner activity log (specs/audit-and-polish.md §A4, roadmap §11
 * `GET /api/audit`). APPEND-ONLY, LIST-ONLY from the API — there is NO
 * PATCH/DELETE and NO `GET /api/audit/:id` (roadmap §12 Layer 6, constraint 5).
 *
 * OWNER-SCOPED, LEAK-PROOF: the `where` ALWAYS carries `ownerId: req.user!.id`,
 * so an owner can never page into another owner's trail. No per-id lookup
 * exists, so no 404-not-403 case arises — the list is inherently scoped. The
 * surface returns NO image data / no pre-signed URLs (audit rows carry only
 * ids + metadata).
 */
const router = Router();

// GET /api/audit — this owner's trail, newest first, paginated + filtered.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let query;
    try {
      query = auditQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;

    // Leak-proof: ownerId is unconditional. Optional filters narrow within it.
    const where: Prisma.AuditLogWhereInput = { ownerId };
    if (query.action) where.action = query.action;
    if (query.actorType) where.actorType = query.actorType;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      };
    }

    const [total, rows] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: query.offset,
        take: query.limit,
      }),
    ]);

    // Best-effort actor label resolution. Owner-actor rows resolve to the
    // owner (one lookup — always this owner). Guest-actor rows resolve to the
    // guest email — preferably from metadata captured at write time (survives
    // guest deletion), else a lookup for still-present guests. Never fails the
    // request if a label can't be resolved (append-only history may outlive
    // the resource): fall back to just the id.
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, email: true, name: true },
    });

    // Collect guest actor ids that DON'T already carry an email in metadata.
    const guestIdsNeedingLookup = new Set<string>();
    for (const r of rows) {
      if (r.actorType === "guest") {
        const md = (r.metadata ?? null) as Record<string, unknown> | null;
        if (!md || typeof md.guestEmail !== "string") {
          guestIdsNeedingLookup.add(r.actorId);
        }
      }
    }
    const guestLabels = new Map<string, string>();
    if (guestIdsNeedingLookup.size > 0) {
      const guests = await prisma.guestUser.findMany({
        where: { id: { in: [...guestIdsNeedingLookup] } },
        select: { id: true, email: true },
      });
      for (const g of guests) guestLabels.set(g.id, g.email);
    }

    const entries = rows.map((r) => {
      let email: string | undefined;
      if (r.actorType === "owner") {
        email = owner?.email;
      } else {
        const md = (r.metadata ?? null) as Record<string, unknown> | null;
        email =
          md && typeof md.guestEmail === "string"
            ? (md.guestEmail as string)
            : guestLabels.get(r.actorId);
      }
      return {
        id: r.id,
        actorType: r.actorType,
        actor: { id: r.actorId, email },
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        metadata: r.metadata,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt,
      };
    });

    return res.status(200).json({
      entries,
      total,
      limit: query.limit,
      offset: query.offset,
    });
  }),
);

export default router;
