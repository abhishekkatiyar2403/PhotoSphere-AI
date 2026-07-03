import { Router } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/prisma";
import { createFolderSchema, folderPhotosQuerySchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";
import { PHOTO_CARD_SELECT, toPhotoCard } from "./folders";

/**
 * Collections routes (specs/ai-classification.md §6). Listing + folder
 * read/create only this pass — no collections CRUD, no rename/merge/delete
 * (Non-goals). All routes: requireAuth + asyncHandler + Zod on every body,
 * 404 (never 403) on ownership mismatch.
 */
const router = Router();

// GET /api/collections — the requesting user's collections only. Empty
// array (not an error) before the worker's first folder assignment lazily
// creates the default "My Photos" collection.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const collections = await prisma.collection.findMany({
      where: { ownerId: req.user!.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, isDefault: true, createdAt: true },
    });

    return res.status(200).json({ collections });
  }),
);

// GET /api/collections/:id/folders — folders in an owned collection,
// sorted by name asc.
router.get(
  "/:id/folders",
  requireAuth,
  asyncHandler(async (req, res) => {
    const collection = await prisma.collection.findUnique({ where: { id: req.params.id } });
    // 404, never 403 - never confirm a foreign collection exists.
    if (!collection || collection.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Collection not found" });
    }

    const folders = await prisma.folder.findMany({
      where: { collectionId: collection.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, categoryType: true, photoCount: true, createdAt: true },
    });

    return res.status(200).json({ folders });
  }),
);

// POST /api/collections/:id/folders — manual folder creation (categoryType
// "custom"), so the reclassification UI always has move targets beyond
// whatever the AI happened to create (spec Open Question 9).
router.post(
  "/:id/folders",
  requireAuth,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = createFolderSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const collection = await prisma.collection.findUnique({ where: { id: req.params.id } });
    if (!collection || collection.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Collection not found" });
    }

    try {
      const folder = await prisma.folder.create({
        data: {
          collectionId: collection.id,
          name: input.name,
          categoryType: "custom",
        },
        select: { id: true, name: true, categoryType: true, photoCount: true, createdAt: true },
      });
      return res.status(201).json(folder);
    } catch (err) {
      // @@unique([collectionId, name]) violation -> duplicate name in this collection.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return res.status(409).json({ error: "A folder with this name already exists in this collection" });
      }
      throw err;
    }
  }),
);

// GET /api/collections/:id/unfiled-photos — paginated, newest first.
// Additive route (not in specs/ai-classification.md — added while building
// the organize UI against design/wireframes/reclassify-ui.svg). Gap found:
// `failed` and `duplicate` photos always have folderId: null (the dedup
// gate short-circuits before folder assignment for duplicates; a failed
// pipeline job never reaches folder assignment at all — see worker.ts), so
// they are structurally invisible to GET /api/folders/:id/photos for every
// folder. The wireframe requires failed/duplicate cards to be reachable and
// actionable (Reclassify / "Not a duplicate?"), so this route exposes them
// as a virtual "Unfiled" bucket scoped to the collection, same pagination
// and card shape as the real folders/:id/photos endpoint. Deliberately
// excludes pending/processing (no wireframe state for "still working" cards
// mixed into this grid, and they resolve into a real folder or this bucket
// on their own within seconds).
router.get(
  "/:id/unfiled-photos",
  requireAuth,
  asyncHandler(async (req, res) => {
    let query;
    try {
      query = folderPhotosQuerySchema.parse(req.query);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const collection = await prisma.collection.findUnique({ where: { id: req.params.id } });
    // 404, never 403 - never confirm a foreign collection exists.
    if (!collection || collection.ownerId !== req.user!.id) {
      return res.status(404).json({ error: "Collection not found" });
    }

    // Scoped by ownerId, NOT collectionId: failed/duplicate photos never
    // reach the folder-assignment step (worker.ts), so collectionId is also
    // null on them, same as folderId - filtering on collectionId here would
    // silently return zero rows always. ownerId is the correct scope (and
    // is already enforced as the collection-ownership check above); this
    // MVP only ever has one collection per user in practice (spec Open
    // Question 1), so "unfiled photos owned by this user" and "unfiled
    // photos belonging to this collection" are the same set today, but the
    // filter is written correctly rather than relying on that coincidence.
    const where: Prisma.PhotoWhereInput = {
      ownerId: req.user!.id,
      folderId: null,
      aiClassificationStatus: { in: ["failed", "duplicate"] },
    };

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
