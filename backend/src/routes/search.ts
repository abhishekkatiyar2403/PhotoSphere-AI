import { Router } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { PHOTO_CARD_SELECT, toPhotoCard } from "../lib/photoCard";
import { prisma } from "../lib/prisma";
import { searchQuerySchema, UNFILED_FOLDER_LITERAL } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";

/**
 * Basic search (specs/folder-mgmt-download-search.md PART P6). Owner-scoped
 * query over the caller's OWN photos by filename substring (S4 ILIKE), upload
 * date range (S2 createdAt), folder (S3), and AI category (S1 = folder-name
 * match). Plain Prisma/SQL — no full-text infra, no new index/schema/migration
 * (S5). No audit (S7 — owner-on-own-data read).
 *
 * LEAK-PROOF owner scoping is non-negotiable: EVERY query starts from
 * `photo.ownerId = req.user.id` and all filters narrow WITHIN that. A search
 * must never return another owner's photo; `folderId`/`category` can't widen
 * past the caller's own data (the category folder-name match is itself
 * owner-scoped — it only ever matches the caller's own folders).
 *
 * Results reuse toPhotoCard/PHOTO_CARD_SELECT so thumbnails are pre-signed
 * 60s URLs, never a raw storage key — same shape as GET /api/folders/:id/photos.
 */
const router = Router();

// GET /api/search — owner-scoped, paginated, newest-first.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    let query;
    try {
      query = searchQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const ownerId = req.user!.id;

    // from > to is invalid (both parsed to Dates by Zod above).
    if (query.from && query.to && query.from > query.to) {
      return res.status(400).json({ error: "`from` must not be after `to`" });
    }

    // Owner scope FIRST — every filter narrows within this. Nothing below can
    // widen past the caller's own photos.
    const where: Prisma.PhotoWhereInput = { ownerId };

    // q — substring on originalFilename, case-insensitive (SQL ILIKE, S4).
    // Empty/whitespace was normalized to undefined by the schema.
    if (query.q) {
      where.originalFilename = { contains: query.q, mode: "insensitive" };
    }

    // Date range on createdAt / upload time (S2). EXIF takenAt deferred.
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = query.from;
      if (query.to) where.createdAt.lte = query.to;
    }

    // folderId (S3). The reserved literal "unfiled" → folderId IS NULL photos.
    // A UUID must resolve to a folder the caller OWNS (folder -> collection ->
    // ownerId), else 404 (house rule — never confirm a foreign folder exists).
    if (query.folderId === UNFILED_FOLDER_LITERAL) {
      where.folderId = null;
    } else if (query.folderId) {
      const folder = await prisma.folder.findUnique({
        where: { id: query.folderId },
        include: { collection: { select: { ownerId: true } } },
      });
      if (!folder || folder.collection.ownerId !== ownerId) {
        return res.status(404).json({ error: "Folder not found" });
      }
      where.folderId = folder.id;
    }

    // category (S1) = match the photo's FOLDER NAME. AI folders are named for
    // their category. Owner-scoped: only the CALLER's own folders with that name
    // are considered (folder -> collection -> ownerId), so this can never match
    // another owner's identically-named folder.
    if (query.category) {
      const ownedFolders = await prisma.folder.findMany({
        where: { name: query.category, collection: { ownerId } },
        select: { id: true },
      });
      // No such folder → no photos in that category. Empty result (still
      // owner-scoped) rather than dropping the filter.
      const folderIds = ownedFolders.map((f) => f.id);
      if (folderIds.length === 0) {
        return res.status(200).json({ photos: [], total: 0, limit: query.limit, offset: query.offset });
      }
      // AND with any folderId filter above: if both are set and disjoint, the
      // { in: [...] } combined with a scalar folderId narrows correctly (Prisma
      // treats the later assignment — so guard against clobber by intersecting).
      if (where.folderId === null) {
        // "unfiled" AND a category (which is a folder) is contradictory → empty.
        return res.status(200).json({ photos: [], total: 0, limit: query.limit, offset: query.offset });
      }
      if (typeof where.folderId === "string") {
        // A specific folderId AND a category: only match if that folder is one
        // of the category folders; else empty.
        if (!folderIds.includes(where.folderId)) {
          return res.status(200).json({ photos: [], total: 0, limit: query.limit, offset: query.offset });
        }
        // keep the specific folderId (already a subset of the category folders)
      } else {
        where.folderId = { in: folderIds };
      }
    }

    // S6: empty query (no filters) → the owner's whole library, newest-first,
    // paginated. `where` is just { ownerId } in that case — browse-all.
    const [total, photos] = await prisma.$transaction([
      prisma.photo.count({ where }),
      prisma.photo.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: query.offset,
        take: query.limit,
        select: PHOTO_CARD_SELECT,
      }),
    ]);

    const items = await Promise.all(photos.map(toPhotoCard));

    return res.status(200).json({
      photos: items,
      total,
      limit: query.limit,
      offset: query.offset,
    });
  }),
);

export default router;
