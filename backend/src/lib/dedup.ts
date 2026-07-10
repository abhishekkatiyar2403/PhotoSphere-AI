import { prisma } from "./prisma";
import { DEGENERATE_PHASH, DUPLICATE_HAMMING_THRESHOLD, hammingDistance } from "./phash";

/**
 * Two-phase dedup gate queries (specs/ai-classification.md §5), extracted
 * from worker.ts so the candidate-selection logic is directly unit-testable
 * against a real database (see __tests__/dedup.regression.test.ts).
 *
 * INVARIANT (applies to BOTH phases, sha256 and phash): all dedup edges
 * point to strictly-older, non-duplicate photos — cycles are structurally
 * impossible. Concretely, a candidate "original" must:
 *
 *   1. not itself be a duplicate (`duplicateOfPhotoId: null`), so verdicts
 *      always point at a canonical original, never at another duplicate;
 *   2. be STRICTLY OLDER than the photo being scanned, under the total
 *      order (createdAt, id) — `createdAt < mine`, or `createdAt == mine
 *      AND id < mine`. Every edge therefore points strictly backwards in
 *      one total order, so no mix of sha256/phash edges can ever form a
 *      cycle.
 *
 * Why both constraints matter for the pHash phase specifically (2026-07-02
 * re-verification finding): each job writes its own phash only AFTER its
 * own dedup scan, but a SIBLING job can commit its phash (or its duplicate
 * verdict) at any point relative to this job's scan at worker concurrency
 * 2 / BullMQ retry. Without these constraints the verified repro was:
 * upload identical bytes twice (A older, B newer); B's job completes first,
 * sha256-dedups against A and commits phash=P; A's exact pass finds nothing
 * strictly older; A's pHash scan then finds B (phash set, hamming 0) and
 * marks A duplicate-of-B — yielding A→B (phash) and B→A (sha256), both
 * stuck `duplicate`, neither ever classified. With constraint (2), B is
 * never a candidate for A because B is strictly newer; with constraint (1),
 * B is additionally excluded the moment it is marked duplicate. Belt and
 * suspenders — each one independently kills the cycle.
 */

interface DedupSubject {
  id: string;
  ownerId: string;
  createdAt: Date;
}

/** Prisma where-fragment implementing the strictly-older half of the invariant. */
function strictlyOlderThan(photo: DedupSubject) {
  return [
    { createdAt: { lt: photo.createdAt } },
    { createdAt: photo.createdAt, id: { lt: photo.id } },
  ];
}

/**
 * Phase 1 — exact pass: oldest same-owner, non-duplicate, strictly-older
 * photo with identical SHA-256 (set by the upload handler at row creation;
 * pre-existing rows keep null and never match). Zero false-positive risk.
 * Returns the canonical original's id, or null.
 */
export async function findExactDuplicateOriginal(
  photo: DedupSubject,
  fileSha256: string,
): Promise<string | null> {
  const match = await prisma.photo.findFirst({
    where: {
      ownerId: photo.ownerId, // per-user scope only (upload-pipeline spec Open Question 7)
      fileSha256,
      duplicateOfPhotoId: null,
      deletedAt: null, // bug fix: a copy sitting in Trash must not block a fresh re-upload
      OR: strictlyOlderThan(photo),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // oldest non-duplicate = canonical original
    select: { id: true },
  });
  return match?.id ?? null;
}

/**
 * Phase 2 — near-dup pass (pHash) under the SAME invariant as phase 1:
 * candidates must be non-duplicate AND strictly older. Degenerate flat-image
 * guard: comparisons are skipped whenever either hash equals the all-zeros
 * degenerate dHash (Tester's 2026-07-02 flat-image finding) — flat images
 * only ever dedup via the exact byte pass. Returns the oldest matching
 * original's id, or null.
 */
export async function findNearDuplicateOriginal(
  photo: DedupSubject,
  phash: string,
): Promise<string | null> {
  if (phash === DEGENERATE_PHASH) return null;

  const candidates = await prisma.photo.findMany({
    where: {
      ownerId: photo.ownerId,
      phash: { not: null },
      duplicateOfPhotoId: null,
      deletedAt: null, // bug fix: a copy sitting in Trash must not block a fresh re-upload
      OR: strictlyOlderThan(photo), // also excludes self: nothing is strictly older than itself
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // oldest match wins, deterministically
    select: { id: true, phash: true },
  });

  for (const candidate of candidates) {
    if (!candidate.phash || candidate.phash === DEGENERATE_PHASH) continue;
    if (hammingDistance(phash, candidate.phash) < DUPLICATE_HAMMING_THRESHOLD) {
      return candidate.id;
    }
  }
  return null;
}
