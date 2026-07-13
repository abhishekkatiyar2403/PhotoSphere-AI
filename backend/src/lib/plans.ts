import { $Enums } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Plan enforcement (2026-07-13 backend audit #7): `users.plan` has existed
 * since the original schema but was never READ anywhere — the free tier's
 * documented 3-guest limit was entirely unenforced (a free user could invite
 * unlimited guests). This is the first, minimal enforcement: guest-count
 * only, no billing. Full Stripe billing (upgrading `plan` itself) stays
 * deferred per CLAUDE.md until explicitly approved — this module only reads
 * the field, never writes it.
 */
export const FREE_PLAN_MAX_ACTIVE_GUESTS = 3;

/**
 * "Active" = has at least one LIVE folder_permission (not revoked, not
 * expired) — the same liveness definition already used everywhere else in
 * the guest-access system (see middleware/requireGuest.ts's
 * getPermittedFolderIds). A fully-revoked guest frees up their slot; this
 * matters because otherwise a free user who revokes-then-reinvites would be
 * permanently stuck at the limit despite having no live shares.
 */
export async function countActiveGuestsForOwner(ownerId: string): Promise<number> {
  const now = new Date();
  return prisma.guestUser.count({
    where: {
      createdBy: ownerId,
      folderPermissions: {
        some: {
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      },
    },
  });
}

/**
 * Returns an error message if creating one more guest would exceed the
 * owner's plan limit, or null if it's fine to proceed. Centralized here
 * (rather than inlined at the one call site) so a second enforcement point
 * — or a future plan tier with a different limit — has somewhere to share
 * this logic.
 */
export async function checkGuestLimit(ownerId: string): Promise<string | null> {
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { plan: true } });
  // PTU1: `plan` is now the real $Enums.Plan enum, not a plain string — this
  // comparison is unchanged in behavior (the enum's `free` member compares
  // equal to the string literal "free"), just now typo-proof at compile time.
  if (owner?.plan !== "free") return null; // paid tiers: no guest limit today

  const activeGuests = await countActiveGuestsForOwner(ownerId);
  if (activeGuests >= FREE_PLAN_MAX_ACTIVE_GUESTS) {
    return `Free plan is limited to ${FREE_PLAN_MAX_ACTIVE_GUESTS} active guests. Revoke an existing guest or upgrade your plan to invite more.`;
  }
  return null;
}

/**
 * specs/plan-tiered-upload.md — batch-upload cap, storage quota, and BullMQ
 * job priority, all keyed by plan tier. Same file/pattern as
 * FREE_PLAN_MAX_ACTIVE_GUESTS/checkGuestLimit above.
 *
 * PTU1 (RESOLVED, Abhishek 2026-07-13): `User.plan` is a real Prisma enum
 * ($Enums.Plan) now, not the plain string the spec's own literal code block
 * showed (that block was written before PTU1 was resolved) — `PlanTier` is
 * aliased to the generated enum type directly so every lookup below is
 * exhaustive-checked by the TypeScript compiler (a typo/missing branch is a
 * compile error, not a runtime `undefined`).
 */
export type PlanTier = $Enums.Plan;

export const BATCH_LIMITS: Record<PlanTier, number> = {
  free: 50,
  pro: 500,
  studio: 1500,
};

export const STORAGE_LIMITS_BYTES: Record<PlanTier, bigint> = {
  free: 5n * 1024n * 1024n * 1024n, // 5 GB
  pro: 100n * 1024n * 1024n * 1024n, // 100 GB
  studio: 500n * 1024n * 1024n * 1024n, // 500 GB
};

// BullMQ: LOWER number = processed FIRST. Studio (highest paid tier) gets
// the smallest integer. Values spread with headroom (not 1/2/3) in case a
// future tier needs to be inserted between existing ones without renumbering.
export const PRIORITY_BY_PLAN: Record<PlanTier, number> = {
  studio: 1,
  pro: 5,
  free: 10,
};

/**
 * Defensive normalization kept even though `plan` is now enum-typed at the
 * Prisma/Postgres level — callers that received a plan value from outside
 * a fully-typed Prisma read (e.g. a raw string threaded through a test
 * fixture, or a future JSON payload) get the same safe-default posture
 * checkGuestLimit already takes, rather than an `undefined` lookup.
 */
function normalizePlan(plan: string): PlanTier {
  return plan === "pro" || plan === "studio" ? plan : "free";
}

export function getBatchLimit(plan: PlanTier | string): number {
  return BATCH_LIMITS[normalizePlan(plan)];
}

export function getStorageLimitBytes(plan: PlanTier | string): bigint {
  return STORAGE_LIMITS_BYTES[normalizePlan(plan)];
}

export function getJobPriority(plan: PlanTier | string): number {
  return PRIORITY_BY_PLAN[normalizePlan(plan)];
}
