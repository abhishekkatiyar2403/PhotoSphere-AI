import { Router } from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../lib/asyncHandler";
import { logAudit } from "../lib/audit";
import { DOWNLOAD_ALL_MAX_PHOTOS, preflightFolderDownload } from "../lib/folderDownload";
import { streamFolderZip } from "../lib/folderZip";
import { PHOTO_CARD_SELECT, toPhotoCard } from "../lib/photoCard";
import { prisma } from "../lib/prisma";
import { getPresignedDownloadUrl, getPresignedGetUrl } from "../lib/storage";
import { thumbnailKey } from "../lib/storageKeys";
import { downloadManyPhotosSchema, folderPhotosQuerySchema } from "../lib/validation";
import { getFolderPermissionLevel, getPermittedFolderIds, requireGuest } from "../middleware/requireGuest";
import { guestRateLimiter } from "../middleware/guestRateLimiter";

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
  guestRateLimiter,
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
  guestRateLimiter,
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

    // specs/trash-system.md audit row #16: getPermittedFolderIds (#15) already
    // excludes a trashed folder from the permitted set, so this membership
    // check alone already 404s a trashed folder — even though the guest's
    // folder_permission row itself may still be technically live. Explicit
    // per the spec's reasoning: "being in the set means 'was granted
    // access,' not 'still visible.'" Also filter the photo query itself to
    // deletedAt: null (an individual photo could be soft-deleted while its
    // folder stays live).
    const permittedIds = await getPermittedFolderIds(req.guest!.guestUserId);
    if (!permittedIds.has(req.params.id)) {
      return res.status(404).json({ error: "Folder not found" });
    }

    const where = { folderId: req.params.id, deletedAt: null };
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

// GET /api/guest/photos/:id — metadata + 60s pre-signed thumbnail + original
// URLs. 404 unless the photo's folderId ∈ permitted set (covers both a
// non-permitted folder AND a completely different owner's photo).
router.get(
  "/photos/:id",
  requireGuest,
  guestRateLimiter,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({
      where: { id: req.params.id },
      include: { folder: { select: { name: true, deletedAt: true } } },
    });
    const permittedIds = await getPermittedFolderIds(req.guest!.guestUserId);
    // specs/trash-system.md audit row #17: 404 if the photo itself is
    // trashed, OR its folder is trashed (folder-transitive — belt-and-
    // suspenders alongside #15's set-level exclusion, in case a future
    // caller ever bypasses getPermittedFolderIds), in addition to the
    // existing permitted-set check.
    if (
      !photo ||
      !photo.folderId ||
      !permittedIds.has(photo.folderId) ||
      photo.deletedAt != null ||
      photo.folder?.deletedAt != null
    ) {
      return res.status(404).json({ error: "Photo not found" });
    }

    const originalUrl = await getPresignedGetUrl(photo.s3Key, 3600);

    const thumbnails: Record<string, string> = {};
    if (photo.s3ThumbnailKey) {
      for (const size of THUMBNAIL_SIZES) {
        const key = thumbnailKey(photo.ownerId, photo.id, size);
        try {
          thumbnails[String(size)] = await getPresignedGetUrl(key, 3600);
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
      metadata: { folderId: photo.folderId, folderName: photo.folder?.name ?? null },
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
  guestRateLimiter,
  asyncHandler(async (req, res) => {
    const photo = await prisma.photo.findUnique({
      where: { id: req.params.id },
      include: { folder: { select: { name: true, deletedAt: true } } },
    });
    const guestUserId = req.guest!.guestUserId;
    const permittedIds = await getPermittedFolderIds(guestUserId);
    // specs/trash-system.md audit row #18: same trashed-checks as #17, BEFORE
    // the level check — a trashed photo shouldn't even reach the
    // 403-vs-200 permission branch, it's 404 first.
    if (
      !photo ||
      !photo.folderId ||
      !permittedIds.has(photo.folderId) ||
      photo.deletedAt != null ||
      photo.folder?.deletedAt != null
    ) {
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
      metadata: { folderId: photo.folderId, folderName: photo.folder?.name ?? null },
      ipAddress: req.ip ?? null,
    });

    // A forced-download URL (Content-Disposition: attachment), not the plain
    // view URL used elsewhere — this is what makes the browser actually save
    // the file instead of just opening it in the requesting tab (bug report:
    // "click download... shows the photo in another tab but not download").
    const url = await getPresignedDownloadUrl(photo.s3Key, photo.originalFilename, 60);
    return res.status(200).json({ download: { url, expiresInSeconds: 60 } });
  }),
);

// POST /api/guest/photos/download-many — zip a caller-chosen set of photos
// this guest has DOWNLOAD access to (bug report: multi-select + "select all"
// should be able to download the batch even when the guest's permission is
// `download`, not the folder-wide `download_all` — that stricter level still
// gates the single-request whole-folder zip below). Every requested photo
// must belong to a folder in the guest's permitted set AND that folder's
// live permission level must be `download` or `download_all` — a photo from
// a view-only folder, or not permitted at all, is silently excluded (Z4-style
// partial inclusion), never a hard error for the whole batch.
router.post(
  "/photos/download-many",
  requireGuest,
  guestRateLimiter,
  asyncHandler(async (req, res) => {
    let input;
    try {
      input = downloadManyPhotosSchema.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: err.flatten() });
      }
      throw err;
    }

    const guestUserId = req.guest!.guestUserId;
    const permittedIds = await getPermittedFolderIds(guestUserId);

    const candidates = await prisma.photo.findMany({
      where: {
        id: { in: input.photoIds },
        aiClassificationStatus: "done",
        s3Key: { not: "" },
        deletedAt: null,
        folderId: { in: [...permittedIds] },
      },
      select: { id: true, s3Key: true, originalFilename: true, folderId: true, ownerId: true },
    });

    // Per-folder permission-level check (view-only folders excluded even
    // though they're in the permitted set — that set only proves visibility,
    // not download rights).
    const levelCache = new Map<string, string | null>();
    const downloadable: { s3Key: string; originalFilename: string }[] = [];
    for (const photo of candidates) {
      const folderId = photo.folderId!;
      if (!levelCache.has(folderId)) {
        levelCache.set(folderId, await getFolderPermissionLevel(guestUserId, folderId));
      }
      const level = levelCache.get(folderId);
      if (level === "download" || level === "download_all") {
        downloadable.push({ s3Key: photo.s3Key, originalFilename: photo.originalFilename });
      }
    }

    if (downloadable.length === 0) {
      return res.status(400).json({ error: "None of the selected photos can be downloaded" });
    }
    if (downloadable.length > DOWNLOAD_ALL_MAX_PHOTOS) {
      return res.status(409).json({ error: "Too many photos selected to download as a single zip — narrow it down" });
    }

    logAudit({
      actorType: "guest",
      actorId: guestUserId,
      ownerId: candidates[0]?.ownerId ?? "",
      action: "photo_downloaded",
      resourceType: "photo",
      resourceId: "multiple",
      metadata: { count: downloadable.length },
      ipAddress: req.ip ?? null,
    });

    await streamFolderZip(res, { folderName: "Selected Photos", photos: downloadable });
  }),
);

// GET /api/guest/folders/:id/download-all — stream a ZIP of a permitted
// folder's downloadable photos (specs/folder-mgmt-download-search.md PART P5).
// :id must be in the guest's permitted set else 404 (the single choke point).
// Z1: requires the LIVE permission level to be `download_all` — a `download`-
// only or `view`-only guest gets 403 (a known-resource authorization limit is
// 403, matching the per-photo view→download house rule). Z6: 0 downloadable →
// 400; Z3: > cap → 409. All pre-flight (scope, level, cap, non-empty) runs
// BEFORE any byte. Z7: ONE folder_downloaded audit row on the SUCCESS path only
// (a 403/404/400/409 writes NO row).
router.get(
  "/folders/:id/download-all",
  requireGuest,
  guestRateLimiter,
  asyncHandler(async (req, res) => {
    const guestUserId = req.guest!.guestUserId;

    // Choke point: not in the permitted set → 404 (indistinguishable from
    // nonexistent — never confirm a folder the guest can't see). specs/
    // trash-system.md audit row #19: #15's set-level exclusion already
    // covers a trashed folder here (before the level check, per the spec's
    // reasoning matching #16's "owner-trash disappears the folder just like
    // an explicit revoke"); queryDownloadablePhotos (#20 below) covers the
    // photo-set transitively too.
    const permittedIds = await getPermittedFolderIds(guestUserId);
    if (!permittedIds.has(req.params.id)) {
      return res.status(404).json({ error: "Folder not found" });
    }

    // Z1: bulk zip requires the `download_all` level specifically. A permitted
    // folder is legitimately known to this guest, so a level shortfall is 403
    // (not 404) — same as the per-photo view→download 403.
    const level = await getFolderPermissionLevel(guestUserId, req.params.id);
    if (level !== "download_all") {
      return res.status(403).json({ error: "Bulk download not permitted for this share" });
    }

    // Z6/Z3 pre-flight BEFORE streaming — clean HTTP errors only here.
    const pre = await preflightFolderDownload(req.params.id);
    if (!pre.ok) {
      return res.status(pre.status).json({ error: pre.error });
    }

    // Need the folder's name (header + audit) and owner (audit trail owner).
    const folder = await prisma.folder.findUnique({
      where: { id: req.params.id },
      include: { collection: { select: { ownerId: true } } },
    });
    if (!folder) {
      // Raced away between the checks above and here — 404, no row.
      return res.status(404).json({ error: "Folder not found" });
    }

    // Z7: audit ONE folder_downloaded row — SUCCESS path only, fire-and-forget,
    // right before streaming begins (a 403/404/400/409 above returned early and
    // never reaches here, so a refusal writes NO row). ownerId is the folder's
    // owner (the trail owner); actor is the guest.
    logAudit({
      actorType: "guest",
      actorId: guestUserId,
      ownerId: folder.collection.ownerId,
      action: "folder_downloaded",
      resourceType: "folder",
      resourceId: folder.id,
      metadata: {
        folderId: folder.id,
        folderName: folder.name,
        photoCount: pre.photos.length,
      },
      ipAddress: req.ip ?? null,
    });

    await streamFolderZip(res, { folderName: folder.name, photos: pre.photos });
  }),
);

export default router;
