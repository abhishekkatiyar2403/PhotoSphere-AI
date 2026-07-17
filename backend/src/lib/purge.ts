import { Prisma } from "@prisma/client";
import { deleteObject } from "./storage";
import { prisma } from "./prisma";
import { thumbnailKey } from "./storageKeys";
import { logAudit, type AuditAction } from "./audit";
import { logger } from "./logger";

/**
 * Shared PERMANENT purge logic (specs/trash-system.md), used by BOTH
 * `DELETE /api/trash/:type/:id` (skip-the-wait single-item purge) AND the
 * daily auto-purge BullMQ job — so the cascade/cleanup code lives in exactly
 * one reviewed place, not duplicated.
 *
 * ─── Idempotency (hard requirement) ───
 * Every function here tolerates the row already being gone (Prisma P2025 —
 * "record not found") as a NO-OP SUCCESS, and `deleteObject` already treats
 * an already-gone MinIO key as a no-op success (lib/storage.ts). Safe to
 * call twice in a row (retry/overlap) with no error and no double-effect.
 *
 * ─── photoCount discipline (hard requirement) ───
 * NEITHER function here ever touches `Folder.photoCount`. A photo's count
 * was already decremented at SOFT-delete time (DELETE /api/photos/:id); a
 * photo purged standalone or via a folder cascade must not double-decrement
 * or decrement-on-behalf-of-a-folder-also-being-deleted. The purge path
 * simply never touches the counter, full stop — see spec §6.
 */

const THUMBNAIL_SIZES = [150, 400, 1200] as const;

export type PurgeTrigger = "manual" | "auto_purge";

/**
 * Permanently purge ONE photo: cascade-null any OTHER photo's
 * `duplicateOfPhotoId` pointing at it (same data-hygiene cascade as the
 * soft-delete endpoint, run again here defensively — a photo could reach
 * purge without ever having been through DELETE /api/photos/:id's own
 * cascade if it was purged via a FOLDER cascade, see purgeFolder below),
 * then delete the DB row, then best-effort delete the MinIO original +
 * every thumbnail size. Tolerates the row already being gone.
 *
 * Does NOT touch `Folder.photoCount` (see module header).
 */
export async function purgePhoto(
  photoId: string,
  opts: { trigger: PurgeTrigger; auditOwnerId?: string },
): Promise<void> {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) {
    return; // already gone — no-op success (idempotency)
  }

  await prisma.photo.updateMany({
    where: { duplicateOfPhotoId: photo.id },
    data: { duplicateOfPhotoId: null },
  });

  try {
    await prisma.photo.delete({ where: { id: photo.id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return; // raced away between the read and the delete — already gone
    }
    throw err;
  }

  // Release the purged photo's bytes from the owner's storage quota. This was
  // the missing half of the size accounting: photos.ts increments
  // storageUsedBytes on upload, but nothing ever decremented it again, so a
  // permanently-deleted photo's bytes stayed counted forever (bug report:
  // dashboard "storage used" didn't drop after purging from Trash). Clamp at
  // 0 defensively — never let a race/replay drive the counter negative.
  const sizeBytes = BigInt(photo.sizeBytes);
  await prisma.user.updateMany({
    where: { id: photo.ownerId, storageUsedBytes: { gte: sizeBytes } },
    data: { storageUsedBytes: { decrement: sizeBytes } },
  });
  await prisma.user.updateMany({
    where: { id: photo.ownerId, storageUsedBytes: { lt: sizeBytes } },
    data: { storageUsedBytes: 0 },
  });

  // Best-effort MinIO cleanup AFTER the DB row is gone (same DB-wins ordering
  // as photo-deletion.md's PD1: correctness of DB state wins, storage cleanup
  // is best-effort after and never resurrects the row on failure).
  try {
    await deleteObject(photo.s3Key);
    for (const size of THUMBNAIL_SIZES) {
      await deleteObject(thumbnailKey(photo.ownerId, photo.id, size));
    }
  } catch (err) {
    logger.error({ err, photoId: photo.id }, "MinIO cleanup failed (DB row already removed)");
  }

  logAudit({
    actorType: "owner",
    actorId: opts.auditOwnerId ?? photo.ownerId,
    ownerId: opts.auditOwnerId ?? photo.ownerId,
    action: "photo_permanently_deleted" satisfies AuditAction,
    resourceType: "photo",
    resourceId: photo.id,
    metadata: { trigger: opts.trigger, originalFilename: photo.originalFilename },
  });
}

/**
 * Permanently purge ONE folder: T5 (FINAL DECISION, Option A) — cascade
 * hard-delete every LIVE photo still attached to it (never individually
 * soft-deleted — just attached to a trashed folder, no independent trash
 * clock of its own), then delete the folder row.
 *
 * A photo that was ALREADY independently soft-deleted (its own `deletedAt`
 * set, e.g. the user trashed it before trashing the folder) is NEVER swept
 * into this cascade — it has its own 7-day trash clock and its own explicit
 * recover/purge decision pending. Since the DB has no ON DELETE cascade on
 * `Photo.folderId` (folder deletion would otherwise fail on a dangling FK),
 * these photos are instead DECOUPLED — `folderId` set to null — right
 * before the folder row is removed, so they keep existing, independently,
 * and later restore straight into Unfiled (see photos.ts restore: a photo
 * with `folderId === null` already restores directly, no folder involved).
 *
 * Tolerates the row already being gone.
 */
export async function purgeFolder(
  folderId: string,
  opts: { trigger: PurgeTrigger },
): Promise<void> {
  const folder = await prisma.folder.findUnique({ where: { id: folderId } });
  if (!folder) {
    return; // already gone — no-op success
  }

  // Resolve the owner for audit purposes (folder -> collection -> ownerId).
  const collection = await prisma.collection.findUnique({
    where: { id: folder.collectionId },
    select: { ownerId: true },
  });
  const ownerId = collection?.ownerId ?? "";

  const allPhotos = await prisma.photo.findMany({
    where: { folderId: folder.id },
    select: { id: true, deletedAt: true },
  });
  const livePhotos = allPhotos.filter((p) => p.deletedAt === null);
  const alreadyTrashedPhotos = allPhotos.filter((p) => p.deletedAt !== null);

  // Decouple already-trashed photos FIRST so they never get swept into the
  // live-photo cascade below and survive the folder row's deletion. Remember
  // the folder's name on each so a later restore can ask the user to pick an
  // existing folder or create a new one, instead of silently landing them in
  // Unfiled (see photos.ts restore, deletedFolderName branch).
  if (alreadyTrashedPhotos.length > 0) {
    await prisma.photo.updateMany({
      where: { id: { in: alreadyTrashedPhotos.map((p) => p.id) } },
      data: { folderId: null, deletedFolderName: folder.name },
    });
  }

  // Cascade: hard-delete every LIVE photo currently pointing at this folder,
  // ONE AT A TIME (per spec — not a single deleteMany, so the per-photo
  // MinIO cleanup + duplicate-cascade-null runs for each; naturally
  // idempotent on retry since purgePhoto tolerates an already-gone row).
  for (const p of livePhotos) {
    await purgePhoto(p.id, { trigger: opts.trigger, auditOwnerId: ownerId });
  }

  try {
    await prisma.folder.delete({ where: { id: folder.id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return; // raced away — already gone
    }
    throw err;
  }

  logAudit({
    actorType: "owner",
    actorId: ownerId,
    ownerId,
    action: "folder_permanently_deleted" satisfies AuditAction,
    resourceType: "folder",
    resourceId: folder.id,
    metadata: {
      trigger: opts.trigger,
      folderName: folder.name,
      photosPurged: livePhotos.length,
      photosPreserved: alreadyTrashedPhotos.length,
    },
  });
}

/**
 * Best-effort S3/MinIO cleanup for EVERY photo an owner has (live or
 * trashed, in any folder or none) — used ONLY by account deletion
 * (2026-07-13 backend audit #4). Deliberately does NOT touch any DB rows:
 * the caller deletes the `User` row immediately after this, and Prisma's own
 * cascades (`onDelete: Cascade` on every Photo/Folder/Collection -> User
 * relation) remove every row in one transaction — looping purgePhoto() here
 * would be redundant per-row DB work for no benefit. This function's ONLY
 * job is making sure the account's files don't outlive its database rows.
 *
 * Same best-effort posture as purgePhoto's own storage cleanup: a failed
 * delete is logged and the sweep continues — a stuck S3 object must never
 * block the account deletion itself.
 */
export async function purgeAllStorageForOwner(ownerId: string): Promise<{ photosCleaned: number }> {
  const photos = await prisma.photo.findMany({
    where: { ownerId },
    select: { id: true, s3Key: true },
  });

  let photosCleaned = 0;
  for (const photo of photos) {
    try {
      await deleteObject(photo.s3Key);
      for (const size of THUMBNAIL_SIZES) {
        await deleteObject(thumbnailKey(ownerId, photo.id, size));
      }
      photosCleaned += 1;
    } catch (err) {
      logger.error({ err, photoId: photo.id }, "account-deletion storage cleanup failed");
    }
  }

  return { photosCleaned };
}
