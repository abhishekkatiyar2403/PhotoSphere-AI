import { Router } from "express";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { prisma } from "../lib/prisma";
import { createFolderSchema } from "../lib/validation";
import { requireAuth } from "../middleware/requireAuth";

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

export default router;
