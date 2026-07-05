import { Router } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { PHOTO_CARD_SELECT, toPhotoCard } from "../lib/photoCard";
import { prisma } from "../lib/prisma";
import { getPresignedGetUrl } from "../lib/storage";
import { thumbnailKey } from "../lib/storageKeys";
import { folderPhotosQuerySchema } from "../lib/validation";
import {
  getFolderPermissionLevel,
  getPermittedFolderIds,
  requireGuest,
} from "../middleware/requireGuest";

/**
 * Scoped guest portal (specs/guest-access-otp.md §5). requireGuest on every
 * route; EVERY folder/photo query filters against getPermittedFolderIds — the
 * single choke point that makes cross-scope leakage structurally impossible.
 * Anything outside the permitted set is 404 (never confirm existence of
 * something the guest can't see). Images are ALWAYS 60s pre-signed URLs
 * (reuse toPhotoCard / the owner photo endpoint's path) — never a raw s3Key.
 */
const router = Router();

const THUMBNAIL_SIZES = [150, 400, 1200] as const;

// GET /api/guest/folders — only permitted, live (non-revoked, non-expired)
// folders, each with name + photoCount + this guest's permission level.
router.get(
  "/folders",
  requireGuest,
  asyncHandler(async (req, res) => {
    const guestUserId = req.guest!.guestUserId;
    const permittedIds = await getPermittedFolderIds(guestUserId);
    if (permittedIds.size === 0) {
      return res.status(200).json({ folders: [] });
    }

    // Fetch the live permissions to carry each folder's permission level.
    const now = new Date();
    const permissions = await prisma.folderPermission.findMany({
      where: {
        guestUserId,
        folderId: { in: [...permittedIds] },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: { folder: { select: { id: true, name: true, photoCount: true } } },
    });

    const folders = permissions.map((p) => ({
      id: p.folder.id,
      name: p.folder.name,
      photoCount: p.folder.photoCount,
      permissionLevel: p.permissionLevel,
    }));

    return res.status(200).json({ folders });
  }),
);

// GET /api/guest/folders/:id/photos — 404 unless :id ∈ permitted set.
router.get(
  "/folders/:id/photos",
  requireGuest,
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

    const permittedIds = await getPermittedFolderIds(req.guest!.guestUserId);
    if (!permittedIds.has(req.params.id)) {
      return res.status(404).json({ error: "Folder not found" });
    }

    const [total, photos] = await prisma.$transaction([
      prisma.photo.count({ where: { folderId: req.params.id } }),
      prisma.photo.findMany({
        where: { folderId: req.params.id },
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

// GET /api/guest/photos/:id — metadata + 60s pre-signed thumbnail + original
// URLs. 404 unless the photo's folderId ∈ permitted set (covers both a
// non-permitted folder AND a completely different owner's photo).
router.get(
  "/photos/:id",
  requireGuest,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
    const permittedIds = await getPermittedFolderIds(req.guest!.guestUserId);
    if (!photo || !photo.folderId || !permittedIds.has(photo.folderId)) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const originalUrl = await getPresignedGetUrl(photo.s3Key, 60);

    const thumbnails: Record<string, string> = {};
    if (photo.s3ThumbnailKey) {
      for (const size of THUMBNAIL_SIZES) {
        const key = thumbnailKey(photo.ownerId, photo.id, size);
        try {
          thumbnails[String(size)] = await getPresignedGetUrl(key, 60);
        } catch {
          // Object doesn't exist yet for this size — omit rather than error.
        }
      }
    }

    // Audit (specs/audit-and-polish.md §A2): photo_viewed — SUCCESS/200 path
    // ONLY (a 401/404 above never reaches here, so no row for a non-view). The
    // actor is the guest; ownerId is the photo's owner (== the trail owner).
    // Fire-and-forget, right before the response is sent (A3 read ordering).
    logAudit({
      actorType: "guest",
      actorId: req.guest!.guestUserId,
      ownerId: photo.ownerId,
      action: "photo_viewed",
      resourceType: "photo",
      resourceId: photo.id,
      metadata: { folderId: photo.folderId },
      ipAddress: req.ip ?? null,
    });

    return res.status(200).json({
      id: photo.id,
      originalFilename: photo.originalFilename,
      original: { url: originalUrl, expiresInSeconds: 60 },
      thumbnails,
      exif: {
        takenAt: photo.exifTakenAt,
        gpsLat: photo.exifGpsLat,
        gpsLng: photo.exifGpsLng,
        cameraMake: photo.exifCameraMake,
        cameraModel: photo.exifCameraModel,
      },
      folderId: photo.folderId,
    });
  }),
);

// GET /api/guest/photos/:id/download — 404 if the photo isn't in a permitted
// folder; 403 if the folder's permission is `view` only (decision G5: the
// guest legitimately knows the photo exists, so 404 would be misleading).
// download / download_all both permit (decision G12: download_all >= download).
router.get(
  "/photos/:id/download",
  requireGuest,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({ where: { id: req.params.id } });
    const guestUserId = req.guest!.guestUserId;
    const permittedIds = await getPermittedFolderIds(guestUserId);
    if (!photo || !photo.folderId || !permittedIds.has(photo.folderId)) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const level = await getFolderPermissionLevel(guestUserId, photo.folderId);
    if (level === "view" || level === null) {
      // 403 (not 404): existence is legitimately known to this view-guest.
      return res.status(403).json({ error: "Download not permitted for this share" });
    }

    // Audit (specs/audit-and-polish.md §A2): photo_downloaded — SUCCESS/200
    // path ONLY. Crucially, a view-only 403 refusal and any 404 above return
    // early WITHOUT reaching here, so neither produces a download row.
    logAudit({
      actorType: "guest",
      actorId: guestUserId,
      ownerId: photo.ownerId,
      action: "photo_downloaded",
      resourceType: "photo",
      resourceId: photo.id,
      metadata: { folderId: photo.folderId },
      ipAddress: req.ip ?? null,
    });

    const url = await getPresignedGetUrl(photo.s3Key, 60);
    return res.status(200).json({ download: { url, expiresInSeconds: 60 } });
  }),
);

export default router;
