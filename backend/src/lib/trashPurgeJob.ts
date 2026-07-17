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

// How long past a TERMINAL state a row is kept before the housekeeping sweep
// below removes it. Deliberately generous — these are cheap rows, not
// storage, so retention is about not growing the tables forever, not urgency.
const SESSION_RETENTION_DAYS = 30; // past expiresAt
const INVITE_TOKEN_RETENTION_DAYS = 30; // unused, past expiresAt
const ACCESS_REQUEST_RETENTION_DAYS = 30; // in a terminal status
const PROCESSING_JOB_RETENTION_DAYS = 90; // completed only — failed kept indefinitely for debugging

// A photo stuck in 'pending'/'processing' longer than this, with no active
// (queued/active) processing_jobs row backing it, is orphaned — not
// mid-pipeline, just stuck. 1 hour is comfortably longer than any real job
// (classification/thumbnailing/EXIF normally complete in seconds).
const STALE_PHOTO_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Housekeeping sweep (2026-07-13 backend audit #12): several tables were
 * accumulating rows forever with no cleanup path at all — expired owner/guest
 * sessions, unused expired invite tokens, terminal access requests (and their
 * cascade-linked touch rows), and completed processing-job rows for photos
 * that are otherwise perfectly healthy. Piggybacks on the EXISTING daily
 * repeatable job below rather than standing up new scheduling infrastructure.
 *
 * Every delete here is bulk (deleteMany) rather than one-at-a-time — unlike
 * photo/folder purge, none of these rows have external (S3/Rekognition)
 * side-effects to clean up per-row, so there's no idempotency/partial-crash
 * concern that would require the slower one-at-a-time pattern.
 */
async function runHousekeepingSweep(): Promise<{
  sessionsDeleted: number;
  guestSessionsDeleted: number;
  inviteTokensDeleted: number;
  accessRequestsDeleted: number;
  processingJobsDeleted: number;
}> {
  const sessionCutoff = new Date(Date.now() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const inviteCutoff = new Date(Date.now() - INVITE_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const accessRequestCutoff = new Date(Date.now() - ACCESS_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const processingJobCutoff = new Date(Date.now() - PROCESSING_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const [sessions, guestSessions, inviteTokens, accessRequests, processingJobs] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: sessionCutoff } } }),
    prisma.guestSession.deleteMany({ where: { expiresAt: { lt: sessionCutoff } } }),
    // Only unused, expired tokens — a used-up single-use token is harmless
    // history, not growth pressure, but an unused expired one never will be.
    prisma.inviteToken.deleteMany({
      where: { expiresAt: { lt: inviteCutoff }, useCount: 0 },
    }),
    // AccessRequestTouch cascades via its FK's onDelete: Cascade (schema.prisma).
    prisma.accessRequest.deleteMany({
      where: { status: { in: ["denied", "expired"] }, createdAt: { lt: accessRequestCutoff } },
    }),
    prisma.processingJob.deleteMany({
      where: { status: "completed", createdAt: { lt: processingJobCutoff } },
    }),
  ]);

  return {
    sessionsDeleted: sessions.count,
    guestSessionsDeleted: guestSessions.count,
    inviteTokensDeleted: inviteTokens.count,
    accessRequestsDeleted: accessRequests.count,
    processingJobsDeleted: processingJobs.count,
  };
}

/**
 * Stale-pending/processing photo reconciliation (2026-07-13 backend audit
 * #14: "if enqueue fails after upload commits, the photo is stuck 'pending'
 * forever — no reconciliation sweep"). A photo can end up here two ways:
 * the BullMQ enqueue call itself failed after the DB row was already
 * written (upload/reclassify's own compensation logic tries to prevent
 * this, but a crash mid-request can still leave the gap), or a worker
 * crashed mid-job without BullMQ's own retry/failure path ever firing.
 *
 * Detection: 'pending'/'processing' for longer than STALE_PHOTO_THRESHOLD_MS
 * AND no processing_jobs row for it still in 'queued'/'active' — that second
 * condition is what distinguishes "genuinely stuck" from "just a slow real
 * job" (a real job's own processing_jobs row would still be active).
 *
 * Recovery: flip straight to 'failed' — the SAME terminal state a normal
 * job failure produces, so the existing, already-shipped Reclassify button
 * is the user's recovery path, with no new UI needed.
 */
async function reconcileStalePhotos(): Promise<{ photosReconciled: number }> {
  const staleCutoff = new Date(Date.now() - STALE_PHOTO_THRESHOLD_MS);

  const candidates = await prisma.photo.findMany({
    where: {
      aiClassificationStatus: { in: ["pending", "processing"] },
      updatedAt: { lt: staleCutoff },
    },
    select: {
      id: true,
      jobs: {
        where: { status: { in: ["queued", "active"] } },
        select: { id: true },
        take: 1,
      },
    },
  });

  const staleIds = candidates.filter((p) => p.jobs.length === 0).map((p) => p.id);
  if (staleIds.length === 0) {
    return { photosReconciled: 0 };
  }

  const result = await prisma.photo.updateMany({
    where: { id: { in: staleIds } },
    data: { aiClassificationStatus: "failed" },
  });

  return { photosReconciled: result.count };
}

export async function runTrashPurgeJob(): Promise<{
  photosPurged: number;
  foldersPurged: number;
  housekeeping: Awaited<ReturnType<typeof runHousekeepingSweep>>;
  staleReconciliation: Awaited<ReturnType<typeof reconcileStalePhotos>>;
}> {
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

  const housekeeping = await runHousekeepingSweep();
  const staleReconciliation = await reconcileStalePhotos();

  return { photosPurged, foldersPurged, housekeeping, staleReconciliation };
}
