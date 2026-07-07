import { TRASH_RETENTION_DAYS } from "../routes/folders";
import { prisma } from "./prisma";
import { purgeFolder, purgePhoto } from "./purge";

/**
 * The daily auto-purge job body (specs/trash-system.md T4). Queries Photo and
 * Folder SEPARATELY for `deletedAt < now() - 7 days`, then reuses the EXACT
 * same per-item purge helpers (lib/purge.ts) that
 * `DELETE /api/trash/:type/:id` calls — no duplicated cascade/cleanup code.
 *
 * ─── Idempotency (hard requirement) ───
 * Items are processed ONE AT A TIME (not deleteMany) so the per-item MinIO
 * cleanup runs for each and a partial crash/retry doesn't need to be
 * all-or-nothing. `purgePhoto`/`purgeFolder` both already tolerate an
 * already-gone row (P2025 → no-op success) and an already-gone MinIO key
 * (deleteObject's own no-op-on-not-found). Running this function twice in a
 * row is safe: no error, no double-effect.
 *
 * ─── photoCount discipline ───
 * Neither the folder cascade nor the standalone photo purge below touches
 * `Folder.photoCount` — see lib/purge.ts's module header for the full
 * reasoning (already decremented at soft-delete time; a folder-cascaded
 * photo's folder is being deleted in the same pass regardless).
 *
 * Exported separately from the BullMQ wiring (worker.ts) so it's directly
 * unit/integration-testable without needing a live queue/worker round-trip.
 */
export async function runTrashPurgeJob(): Promise<{ photosPurged: number; foldersPurged: number }> {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const expiredFolders = await prisma.folder.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true },
  });
  let foldersPurged = 0;
  for (const f of expiredFolders) {
    await purgeFolder(f.id, { trigger: "auto_purge" });
    foldersPurged += 1;
  }

  // Standalone expired photos — NOT under a folder that's ALSO expired (that
  // case is already covered transitively by the folder cascade above, and
  // re-processing it here would just be a harmless no-op given purgePhoto's
  // idempotency, but querying it out avoids the redundant work/log noise).
  const expiredPhotos = await prisma.photo.findMany({
    where: {
      deletedAt: { lt: cutoff },
      OR: [{ folderId: null }, { folder: { deletedAt: null } }, { folder: { deletedAt: { gte: cutoff } } }],
    },
    select: { id: true },
  });
  let photosPurged = 0;
  for (const p of expiredPhotos) {
    await purgePhoto(p.id, { trigger: "auto_purge" });
    photosPurged += 1;
  }

  return { photosPurged, foldersPurged };
}
