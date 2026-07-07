import { Prisma } from "@prisma/client";
import { deleteObject } from "./storage";
import { prisma } from "./prisma";
import { thumbnailKey } from "./storageKeys";
import { logAudit, type AuditAction } from "./audit";

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

  // Best-effort MinIO cleanup AFTER the DB row is gone (same DB-wins ordering
  // as photo-deletion.md's PD1: correctness of DB state wins, storage cleanup
  // is best-effort after and never resurrects the row on failure).
  try {
    await deleteObject(photo.s3Key);
    for (const size of THUMBNAIL_SIZES) {
      await deleteObject(thumbnailKey(photo.ownerId, photo.id, size));
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[purge] MinIO cleanup failed for photo ${photo.id} (DB row already removed):`, err);
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
 * hard-delete ALL of its photos FIRST (regardless of whether those photos
 * ever got their own `deletedAt` set — they were never individually
 * soft-deleted per T-folder-photos, they were just attached to a trashed
 * folder), then delete the folder row. Tolerates the row already being gone.
 *
 * Per-photo purge here reuses `purgePhoto` (same cascade-null + DB delete +
 * MinIO cleanup) but its OWN photoCount-non-touch guarantee already covers
 * this — nothing extra needed for the cascade case.
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

  // Cascade: hard-delete every photo currently pointing at this folder, ONE
  // AT A TIME (per spec — not a single deleteMany, so the per-photo MinIO
  // cleanup + duplicate-cascade-null runs for each; naturally idempotent on
  // retry since purgePhoto tolerates an already-gone row).
  const photos = await prisma.photo.findMany({
    where: { folderId: folder.id },
    select: { id: true },
  });
  for (const p of photos) {
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
    metadata: { trigger: opts.trigger, folderName: folder.name, photosPurged: photos.length },
  });
}
