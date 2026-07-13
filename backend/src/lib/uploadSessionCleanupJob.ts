import { prisma } from "./prisma";
import { abortMultipartUpload } from "./storage";
import { logger } from "./logger";

/**
 * specs/production-upload-batch.md PUB4 (DECIDED: a daily BullMQ repeatable
 * job, same pattern as lib/trashPurgeJob.ts's runTrashPurgeJob). Finds every
 * UploadSession row past its expiresAt still `in_progress` (the browser
 * closed/crashed mid-batch, no /api/upload/abort ever called), aborts any
 * outstanding multipart uploads via abortMultipartUpload (using
 * UploadSessionFile rows still `pending`), and flips the session to
 * `expired`.
 *
 * Idempotent, same discipline as the trash-purge job: abortMultipartUpload
 * is itself a no-op success on an already-gone/aborted upload, so running
 * this sweep twice on the same session (or racing DELETE /api/upload/abort)
 * is safe — no error, no double-effect. Sessions are processed one at a
 * time (not a bulk updateMany) so each session's per-file MinIO abort calls
 * run individually and a partial crash mid-sweep doesn't need to be
 * all-or-nothing.
 *
 * Exported separately from the BullMQ wiring (worker.ts) so it's directly
 * unit/integration-testable without needing a live queue/worker round-trip —
 * same rationale as runTrashPurgeJob.
 */
export async function runUploadSessionCleanupJob(): Promise<{
  sessionsExpired: number;
  partsAborted: number;
}> {
  const staleSessions = await prisma.uploadSession.findMany({
    where: { status: "in_progress", expiresAt: { lt: new Date() } },
    include: { files: { where: { status: "pending" } } },
  });

  let sessionsExpired = 0;
  let partsAborted = 0;

  for (const session of staleSessions) {
    for (const file of session.files) {
      try {
        await abortMultipartUpload(file.key, file.uploadId);
        partsAborted += 1;
      } catch (err) {
        // Best-effort — log and continue rather than letting one bad file
        // block the rest of the sweep or leave the session stuck forever.
        logger.error(
          { err, sessionId: session.id, fileId: file.id },
          "upload-session-cleanup: abortMultipartUpload failed for one file (continuing)",
        );
      }
    }

    await prisma.$transaction([
      prisma.uploadSessionFile.updateMany({
        where: { sessionId: session.id, status: "pending" },
        data: { status: "aborted" },
      }),
      prisma.uploadSession.update({
        where: { id: session.id },
        data: { status: "expired" },
      }),
    ]);
    sessionsExpired += 1;
  }

  return { sessionsExpired, partsAborted };
}
