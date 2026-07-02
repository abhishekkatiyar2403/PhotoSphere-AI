import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Interactive Prisma transaction at Serializable isolation, retried on
 * P2034 (write conflict / deadlock) with jittered exponential backoff.
 *
 * Why (review finding, 2026-07-02): the folder photoCount reconciliation in
 * both the worker's assignPhotoToFolder and the PATCH /api/photos/:id move
 * reads the photo's previous folderId with a plain read inside the
 * transaction. Under the default Read Committed isolation that read can be
 * stale by the time the photo row is written (worker concurrency is 2, and
 * the API can move a photo while a reclassify job is in flight), producing
 * photoCount drift — decrementing the wrong folder or never decrementing.
 * Serializable isolation makes Postgres abort one of the conflicting
 * transactions instead (SQLSTATE 40001/40P01, surfaced by Prisma as P2034),
 * and this helper transparently retries the aborted side.
 */
const MAX_RETRIES = 5;

export async function serializableTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      const retriable =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
      if (!retriable || attempt >= MAX_RETRIES) {
        throw err;
      }
      const backoffMs = 20 * 2 ** attempt + Math.floor(Math.random() * 20);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
