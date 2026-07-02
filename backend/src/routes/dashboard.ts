import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

/**
 * Dashboard stats (specs/dashboard-stats-and-upload-polish.md). A single
 * read-only aggregate rollup across collections/folders/photos/storage for
 * the requesting user - nothing else in the codebase sums Photo rows or
 * exposes User.storageUsedBytes/storageLimitBytes to the client today.
 *
 * GET only, no params/body -> requireAuth + asyncHandler, no Zod needed.
 * Every query below is scoped by req.user!.id - there's no :id param here,
 * so there's no ownership-mismatch case to get wrong (unlike collections.ts
 * /folders.ts), just consistent per-owner scoping throughout.
 */
const router = Router();

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user!.id;

    const [user, photoCount, folderCount, collections] = await Promise.all([
      prisma.user.findUnique({
        where: { id: ownerId },
        select: { storageUsedBytes: true, storageLimitBytes: true },
      }),
      // totals.photoCount: every photo regardless of status (spec Open
      // Question 1 default) - a library-size stat, not an org-health one.
      prisma.photo.count({ where: { ownerId } }),
      prisma.folder.count({ where: { collection: { ownerId } } }),
      prisma.collection.findMany({
        where: { ownerId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          isDefault: true,
          _count: { select: { folders: true } },
        },
      }),
    ]);

    if (!user) {
      // Session pointed at a user row that no longer exists - treat like
      // any other requireAuth-passed-but-user-gone edge case elsewhere in
      // this codebase (routes/photos.ts's upload handler).
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Per-collection photoCount: counted directly from Photo rows scoped to
    // the collection, NOT summed from each folder's photoCount counter -
    // stays correct even for a photo with collectionId set but folderId
    // still null (can't happen today per the worker's atomicity, but cheap
    // to get right without trusting folder-level counters to always sum).
    const collectionPhotoCounts = await Promise.all(
      collections.map((c) => prisma.photo.count({ where: { ownerId, collectionId: c.id } })),
    );

    const usedBytes = user.storageUsedBytes;
    const limitBytes = user.storageLimitBytes;
    // Server-side float math only - client never does BigInt-to-float
    // conversion itself. Guard against a zero/negative limit (shouldn't
    // happen given the schema default, but division-by-zero is cheap to
    // avoid) and cap at 1.0 per spec.
    const usedPercent =
      limitBytes > 0n ? Math.min(1, Number(usedBytes) / Number(limitBytes)) : 0;

    return res.status(200).json({
      storage: {
        // BigInt -> string for JSON (BigInt is not JSON-serializable and
        // would 500 on JSON.stringify otherwise - the well-known Node/Express
        // footgun the spec calls out).
        usedBytes: usedBytes.toString(),
        limitBytes: limitBytes.toString(),
        usedPercent,
      },
      totals: {
        photoCount,
        folderCount,
        collectionCount: collections.length,
      },
      collections: collections.map((c, i) => ({
        id: c.id,
        name: c.name,
        isDefault: c.isDefault,
        folderCount: c._count.folders,
        photoCount: collectionPhotoCounts[i],
      })),
    });
  }),
);

export default router;
