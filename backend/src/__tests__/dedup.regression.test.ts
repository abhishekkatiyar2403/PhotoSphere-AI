import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { prisma } from "../lib/prisma";
import { findExactDuplicateOriginal, findNearDuplicateOriginal } from "../lib/dedup";
import { DEGENERATE_PHASH, hammingDistance, DUPLICATE_HAMMING_THRESHOLD } from "../lib/phash";

// Deterministic regression coverage for the 2026-07-02 circular-duplicate
// finding (see lib/dedup.ts header for the full derivation): the pHash
// phase-2 candidate scan lacked BOTH the `duplicateOfPhotoId: null`
// exclusion and the strictly-older ((createdAt, id) total order) constraint,
// so a newer sibling B — already sha256-marked duplicate-of A, with its
// phash committed — could be returned by A's own scan at hamming distance 0,
// producing A→B (phash) + B→A (sha256): both stuck `duplicate`, never
// classified.
//
// The live race itself is timing-dependent (worker concurrency 2 / BullMQ
// retry ordering), so instead of a flaky full-race e2e this suite constructs
// the exact DB state the race produces and runs the REAL candidate queries
// (the same lib/dedup.ts functions worker.ts calls) directly against it,
// asserting each invariant constraint independently. DB-only — no MinIO, no
// worker; skips gracefully if Postgres is unreachable, same convention as
// the other suites.
//
// Isolation: all tests share one owner (the scans are owner-scoped), so each
// test uses its OWN phash value, pairwise hamming distance >= 32 (asserted
// below), to keep one test's leftover rows from ever matching another's scan.

const PHASH = {
  repro: "a5a5a5a5a5a5a5a5",
  strictlyOlder: "0f0f0f0f0f0f0f0f",
  dupExclusion: "ffffffffffffffff",
  tiebreak: "3333333333333333",
  scoping: "cccccccccccccccc",
} as const;

const SHA_REPRO = "e".repeat(64); // stand-in SHA-256 hex for "same bytes"
const SHA_CANONICAL = "f".repeat(64); // distinct sha for the phase-1 block

const baseTime = new Date("2026-07-02T10:00:00.000Z");
const olderTime = new Date(baseTime.getTime() - 60_000);
const newerTime = new Date(baseTime.getTime() + 60_000);

const testEmail = `dedup-regression-${Date.now()}@example.com`;
const otherEmail = `dedup-regression-other-${Date.now()}@example.com`;
let userId: string;
let otherUserId: string;
let infraAvailable = true;

async function makePhoto(overrides: {
  id?: string;
  ownerId?: string;
  createdAt: Date;
  fileSha256?: string | null;
  phash?: string | null;
  duplicateOfPhotoId?: string | null;
  dedupMethod?: string | null;
}) {
  return prisma.photo.create({
    data: {
      ownerId: userId,
      s3Key: `test/dedup-regression/${Math.random().toString(36).slice(2)}`,
      originalFilename: "dedup-regression.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      ...overrides,
    },
  });
}

beforeAll(async () => {
  try {
    await prisma.$connect();
  } catch {
    infraAvailable = false;
    return;
  }

  const user = await prisma.user.create({
    data: { email: testEmail, passwordHash: "not-a-real-hash", name: "Dedup Regression" },
  });
  userId = user.id;
  const other = await prisma.user.create({
    data: { email: otherEmail, passwordHash: "not-a-real-hash", name: "Dedup Regression Other" },
  });
  otherUserId = other.id;
});

afterAll(async () => {
  if (infraAvailable) {
    // Delete duplicate rows first (self-referencing FK), then originals.
    await prisma.photo.deleteMany({
      where: { ownerId: { in: [userId, otherUserId] }, duplicateOfPhotoId: { not: null } },
    });
    await prisma.photo.deleteMany({ where: { ownerId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [testEmail, otherEmail] } } });
    await prisma.$disconnect();
  }
});

describe("pHash phase-2 candidate scan (circular-duplicate regression)", () => {
  it("uses pairwise-distant per-test phashes (isolation sanity check)", () => {
    const values = Object.values(PHASH);
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(hammingDistance(values[i], values[j])).toBeGreaterThanOrEqual(
          DUPLICATE_HAMMING_THRESHOLD,
        );
      }
      expect(values[i]).not.toBe(DEGENERATE_PHASH);
    }
  });

  it("excludes a newer sibling already marked duplicate-of the scanning photo (the exact repro state)", async () => {
    if (!infraAvailable) {
      console.warn("Skipping: Postgres not reachable. Run `docker compose up -d` first.");
      return;
    }

    // The state B's completed job leaves behind mid-race: B (newer) is
    // sha256-duplicate-of A (older) and has committed phash = P. Old code
    // returned B from A's scan (phash set, hamming 0) -> cycle.
    const photoA = await makePhoto({ createdAt: olderTime, fileSha256: SHA_REPRO });
    const photoB = await makePhoto({
      createdAt: newerTime,
      fileSha256: SHA_REPRO,
      phash: PHASH.repro,
      duplicateOfPhotoId: photoA.id,
      dedupMethod: "sha256",
    });

    // A's phase-2 scan must find nothing: B is excluded twice over (newer
    // AND already a duplicate) -> A proceeds to classification, no cycle.
    expect(await findNearDuplicateOriginal(photoA, PHASH.repro)).toBeNull();

    // And the edge that DOES exist still points strictly backwards:
    // re-running B's exact pass keeps returning A, never the reverse.
    expect(await findExactDuplicateOriginal(photoB, SHA_REPRO)).toBe(photoA.id);
    expect(await findExactDuplicateOriginal(photoA, SHA_REPRO)).toBeNull();
  });

  it("excludes a strictly-newer candidate even when it is NOT itself a duplicate", async () => {
    if (!infraAvailable) return;

    // Isolates the strictly-older constraint: newer non-duplicate sibling
    // with an identical phash must not be matched by the older photo's scan.
    const scanning = await makePhoto({ createdAt: olderTime });
    const newerNonDup = await makePhoto({ createdAt: newerTime, phash: PHASH.strictlyOlder });

    expect(await findNearDuplicateOriginal(scanning, PHASH.strictlyOlder)).toBeNull();

    // The newer photo's own scan, conversely, MUST match the older one once
    // the older photo's phash is committed (normal near-dup behavior intact).
    await prisma.photo.update({
      where: { id: scanning.id },
      data: { phash: PHASH.strictlyOlder },
    });
    expect(await findNearDuplicateOriginal(newerNonDup, PHASH.strictlyOlder)).toBe(scanning.id);
  });

  it("excludes an older candidate that is itself a duplicate, matching the older canonical original instead", async () => {
    if (!infraAvailable) return;

    // Isolates the duplicateOfPhotoId: null constraint: verdicts must point
    // at the canonical original, never at another duplicate row.
    const canonical = await makePhoto({
      createdAt: new Date(olderTime.getTime() - 60_000),
      phash: PHASH.dupExclusion,
    });
    const olderButDuplicate = await makePhoto({
      createdAt: olderTime,
      phash: PHASH.dupExclusion,
      duplicateOfPhotoId: canonical.id,
      dedupMethod: "phash",
    });
    const scanning = await makePhoto({ createdAt: newerTime });

    const verdict = await findNearDuplicateOriginal(scanning, PHASH.dupExclusion);
    expect(verdict).toBe(canonical.id);
    expect(verdict).not.toBe(olderButDuplicate.id);
  });

  it("breaks identical-createdAt ties by id, in one direction only", async () => {
    if (!infraAvailable) return;

    // Two rows sharing one createdAt (the tiebreak half of the (createdAt,
    // id) total order): only the lower id can ever be the "original".
    const lowId = await makePhoto({
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: baseTime,
      phash: PHASH.tiebreak,
    });
    const highId = await makePhoto({
      id: "22222222-2222-4222-8222-222222222222",
      createdAt: baseTime,
      phash: PHASH.tiebreak,
    });

    expect(await findNearDuplicateOriginal(highId, PHASH.tiebreak)).toBe(lowId.id);
    expect(await findNearDuplicateOriginal(lowId, PHASH.tiebreak)).toBeNull();
  });

  it("never matches across owners, and never matches on a degenerate flat-image hash", async () => {
    if (!infraAvailable) return;

    const foreign = await makePhoto({
      ownerId: otherUserId,
      createdAt: olderTime,
      phash: PHASH.scoping,
    });
    const scanning = await makePhoto({ createdAt: newerTime });

    // Per-user scoping (upload-pipeline spec Open Question 7) survives the rework.
    expect(foreign.ownerId).not.toBe(scanning.ownerId);
    expect(await findNearDuplicateOriginal(scanning, PHASH.scoping)).toBeNull();

    // Degenerate guard survives the rework: flat-image hash never compares,
    // even against an older same-owner flat candidate.
    const olderFlat = await makePhoto({ createdAt: olderTime, phash: DEGENERATE_PHASH });
    expect(olderFlat.phash).toBe(DEGENERATE_PHASH);
    expect(await findNearDuplicateOriginal(scanning, DEGENERATE_PHASH)).toBeNull();
  });
});

describe("sha256 phase-1 exact pass (same invariant, re-asserted post-extraction)", () => {
  it("matches only strictly-older, non-duplicate rows and picks the oldest as canonical", async () => {
    if (!infraAvailable) return;

    const oldest = await makePhoto({
      createdAt: new Date(olderTime.getTime() - 120_000),
      fileSha256: SHA_CANONICAL,
    });
    const middleDuplicate = await makePhoto({
      createdAt: olderTime,
      fileSha256: SHA_CANONICAL,
      duplicateOfPhotoId: oldest.id,
      dedupMethod: "sha256",
    });
    const scanning = await makePhoto({ createdAt: newerTime, fileSha256: SHA_CANONICAL });

    // Oldest non-duplicate wins; the duplicate row in between is skipped.
    const verdict = await findExactDuplicateOriginal(scanning, SHA_CANONICAL);
    expect(verdict).toBe(oldest.id);
    expect(verdict).not.toBe(middleDuplicate.id);
    // No backwards edge from the oldest.
    expect(await findExactDuplicateOriginal(oldest, SHA_CANONICAL)).toBeNull();
  });
});
