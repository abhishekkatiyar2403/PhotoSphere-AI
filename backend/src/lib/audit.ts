import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * The ONLY writer to `audit_log` (specs/audit-and-polish.md §A3, roadmap §12
 * Layer 6 "immutable log of all actions"). Same discipline as the classifier /
 * notification mock headers — a single choke-point module.
 *
 * ─── FIRE-AND-FORGET, NEVER-BREAK-PRIMARY CONTRACT (constraint 4, AP5) ───
 *
 * Logging is a SIDE EFFECT, never part of the transaction that performs the
 * primary action. Every caller must uphold three rules, which this module
 * enforces on its side:
 *
 *   1. `logAudit(...)` is NOT `await`-ed inside any primary `$transaction`, and
 *      must be called AFTER the primary operation has committed (or, for guest
 *      reads, right before `res.json(...)` on the SUCCESS/200 path only). It
 *      returns `void` immediately — it kicks off the insert and does not block
 *      the primary handler.
 *
 *   2. The insert is wrapped in `.catch()` that LOGS-AND-SWALLOWS. A failed
 *      audit-log insert (DB blip, constraint, outage) can therefore NEVER roll
 *      back or fail an approval / deny / revoke / share / view / download. The
 *      primary action has already succeeded and been reported to the client by
 *      the time this insert runs.
 *
 *   3. NOT queued via BullMQ (AP5): a single fast indexed write doesn't warrant
 *      a Redis dependency + latency + failure modes on the write path — the
 *      same "async only if genuinely slow" rule the guest-access OTP applied.
 *
 * The log is APPEND-ONLY (constraint 5): this module only ever inserts. There
 * is no update/delete path, and the API exposes no PATCH/DELETE/`:id` route.
 *
 * IDs (`actorId`/`ownerId`/`resourceId`) are plain strings, NOT FK relations —
 * a row must survive deletion of the resource it describes (a revoked guest, a
 * deleted folder/photo). Human labels are captured into `metadata` at write
 * time so a read never depends on the (possibly-deleted) resource still
 * existing.
 */

export type AuditAction =
  | "share_created"
  | "access_requested"
  | "access_approved"
  | "access_denied"
  | "guest_revoked"
  | "photo_viewed"
  | "photo_downloaded"
  // specs/folder-mgmt-download-search.md P4 (F4): destructive folder ops that
  // interact with sharing get an owner-actor audit row. Plain rename is NOT
  // audited (cosmetic, high-frequency — matches the AP1 owner-content exclusion).
  | "folder_merged"
  | "folder_deleted";

export type AuditActorType = "owner" | "guest";

export type AuditResourceType = "photo" | "folder" | "guest" | "access_request";

export interface LogAuditInput {
  actorType: AuditActorType;
  actorId: string;
  ownerId: string;
  action: AuditAction;
  resourceType?: AuditResourceType;
  resourceId?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

// The concrete insert. Isolated behind a mutable reference ONLY so a test can
// force an insert failure and assert the primary action still succeeds (the
// never-break-primary property, AC A3). Never swapped in production.
let insertImpl = (input: LogAuditInput): Promise<unknown> =>
  prisma.auditLog.create({
    data: {
      actorType: input.actorType,
      actorId: input.actorId,
      ownerId: input.ownerId,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      metadata: input.metadata ?? undefined,
      ipAddress: input.ipAddress ?? null,
    },
  });

/**
 * Insert one audit row, fire-and-forget. Returns immediately (`void`); the
 * insert runs in the background and any failure is caught, logged, and
 * swallowed so it can never affect the primary action. See the module header.
 */
export function logAudit(input: LogAuditInput): void {
  // Intentionally NOT awaited by callers. Kick off the insert and let it
  // resolve/reject in the background; a rejection is caught below.
  void insertImpl(input).catch((err) => {
    // Log-and-swallow: a failed audit write MUST NOT surface to the primary
    // action (it has already committed and responded). Never re-throw.
    // eslint-disable-next-line no-console
    console.error(
      `[audit] failed to write audit_log row (action=${input.action}, owner=${input.ownerId}); primary action unaffected:`,
      err,
    );
  });
}

/**
 * TEST-ONLY: replace the insert implementation to simulate an audit-write
 * failure (or to observe writes). Returns a restore function. Guarded to
 * NODE_ENV=test so it can never be used in dev/prod.
 */
export function __setAuditInsertForTest(fn: (input: LogAuditInput) => Promise<unknown>): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setAuditInsertForTest is test-only");
  }
  const prev = insertImpl;
  insertImpl = fn;
  return () => {
    insertImpl = prev;
  };
}
