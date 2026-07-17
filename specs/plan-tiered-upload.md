# Spec — Plan-Tiered Upload: Batch Caps, Storage Quotas & Job Priority

**Roadmap source:** Addendum to `specs/production-upload-batch.md` (PUB, built end-to-end, commit `e86f126`), reinstating two items that spec's Non-goals deliberately trimmed ("BullMQ job priority by plan tier" and "per-plan batch/storage limit tiers") now that Abhishek has explicitly asked for them with concrete numbers. Also touches `PhotoSphere_AI_Master_Roadmap.md`'s billing-adjacent enforcement started by `lib/plans.ts`'s existing free-guest-cap work.
**Supersedes:** `specs/production-upload-batch.md`'s Non-goals bullets "BullMQ job priority by plan tier" and "Per-plan batch/storage limit tiers" only — everything else in that spec (the presigned multipart mechanics, `UploadSession`/`UploadSessionFile`, the worker pipeline, the existing single-file `POST /api/photos/upload` route's own behavior) is unchanged and reused as-is.
**Status:** draft
**Written by:** Planner Agent, 2026-07-13

## Problem

`specs/production-upload-batch.md` shipped a flat `MAX_BATCH_FILES = 1000` cap (enforced today as a static `.max()` on the Zod schema in `lib/validation.ts`, i.e. before the request even knows who the caller is) and a flat `storageLimitBytes` default of 5GB for every user regardless of `User.plan`. Every `photoProcessingQueue.add(...)` call (both the single-file route and the batch `/complete` route) also runs at BullMQ's implicit default priority — there is no tiering of any kind today. `lib/plans.ts` currently only enforces a free-tier guest-count cap; `User.plan` is otherwise unread everywhere else in the app, and there is no way for Abhishek to switch a test account between tiers without a raw DB write.

Abhishek wants exactly three things, with concrete numbers: a batch-upload cap and BullMQ job priority that vary by plan, a storage quota that varies by plan, and a no-billing plan-switcher so all three tiers can be exercised without touching the database by hand.

## Goals

- `lib/plans.ts` gains real, exported plan-tier constants: batch cap, storage limit, and BullMQ job priority, each keyed by plan.
- `POST /api/upload/initiate` enforces the caller's plan-specific batch cap (not the old flat `MAX_BATCH_FILES`), with an error response that names the limit and the caller's plan (frontend upgrade-nudge material).
- `POST /api/upload/initiate` (batch) and `POST /api/photos/upload` (single-file) both continue to quota-check against `storageLimitBytes` — but that column now actually reflects the caller's plan tier, not a flat 5GB for everyone.
- Every `photoProcessingQueue.add(...)` call (single-file route + batch `/complete`) passes an explicit `priority` option derived from the caller's plan — Studio processes first, Free last, on the SAME queue (no new queue).
- A new owner-facing, clearly-labeled-as-testing plan switcher (`PATCH /api/auth/plan`) lets Abhishek set `free`/`pro`/`studio` on his own account with no payment step, and a minimal frontend surface to drive it.

## Non-goals (explicitly out of scope for this pass)

- **No Stripe, no real billing, no payment processing, no webhooks** — per CLAUDE.md's ground rules, unconditional regardless of anything else in this spec. The plan switcher is a dev/testing control that writes `user.plan` directly; it is not a self-serve upgrade flow and must not be labeled as one in the UI.
- **No change to the presigned multipart mechanics, `UploadSession`/`UploadSessionFile` schema, worker pipeline, or content-sniffing** established by `specs/production-upload-batch.md` — this spec only changes WHICH numbers apply to WHOM and adds a `priority` option to two already-existing `.add()` calls.
- **No per-plan feature gating beyond the three numbers above** (e.g. no plan-gated AI features, no plan-gated guest counts beyond what `lib/plans.ts` already enforces for Free). `checkGuestLimit`'s existing Free-guest-cap logic is untouched except for whatever knock-on effect the enum-vs-string decision below has on its one `plan !== "free"` comparison.
- **No separate BullMQ queue per tier.** Confirmed explicitly: BullMQ `priority` is a per-job option on the existing single `photoProcessingQueue` (`Queue.add(name, data, { priority })`), not a priority-queue-per-tier concept. This spec adds zero new `Queue`/`Worker` instances.
- **No admin/support UI for setting OTHER users' plans** — the switcher is scoped to the authenticated caller's own account (`PATCH /api/auth/plan`, same auth posture as the existing `PATCH /api/auth/me`), matching how every other self-service account endpoint in `auth.ts` already works. A multi-tenant admin console is a different, unbuilt feature.

## Architecture notes

### Why the batch-cap check must move out of the Zod schema

Today `initiateUploadSchema`'s `files` array is capped via a static `.max(MAX_BATCH_FILES)` in `lib/validation.ts` — this runs during `zod.parse()`, **before** the route handler has looked up the caller's `User` row, so it has no way to know which plan's cap applies. A per-plan cap cannot live at the schema layer as a single number.

**Design:** keep a schema-layer cap, but repurpose it as an absolute ceiling across all tiers (`ABSOLUTE_MAX_BATCH_FILES = 1500`, Studio's own cap — the highest number any plan is ever allowed) — this remains a cheap defense-in-depth check that rejects a wildly oversized payload (e.g. 50,000 file descriptors) before any DB/plan lookup happens at all. Then, **after** `dbUser` is fetched (the route already does this, for the quota check), add an explicit plan-aware check:

```ts
const batchLimit = getBatchLimit(dbUser.plan);
if (input.files.length > batchLimit) {
  return res.status(400).json({
    error: "batch_limit_exceeded",
    message: `Your ${dbUser.plan} plan allows up to ${batchLimit} photos per batch upload.`,
    plan: dbUser.plan,
    limit: batchLimit,
    requested: input.files.length,
  });
}
```

This is a distinct `error` value (`"batch_limit_exceeded"`) from the generic `{ error: "Validation failed", details }` Zod shape the route already returns for other 400s — deliberate, so the frontend can special-case exactly this response to show an upgrade nudge without string-matching a message. Order in the route: parse (absolute ceiling) → fetch `dbUser` → plan batch-cap check (400) → storage quota check (413, unchanged) → duplicate pre-check → `createMultipartUpload` per file (unchanged).

### Why storage-limit stays a stored, synced column (not computed live)

Master's framing poses this as a real fork: sync `storageLimitBytes` to the plan's tier at switch-time (risk: drift if anything else ever writes `plan` without going through the switcher) vs. compute the effective limit from `plan` live at every quota-check call site (risk: touches more call sites, and diverges from how every existing quota check already trusts the stored column).

**Decision: sync-at-switch.** `PATCH /api/auth/plan` writes `storageLimitBytes` to match the new plan's tier in the SAME update as `plan` itself (one `prisma.user.update` call, both fields). Every existing quota-check call site (`routes/photos.ts`'s single-file route, `routes/upload.ts`'s `/initiate`) is **unchanged** — they already trust `dbUser.storageLimitBytes` as the source of truth, and that continues to be correct as long as the switcher is the only path that ever writes `plan`. This is the lower-risk, lower-touch option: zero changes to either quota-check call site, one new call site (the switcher) that keeps both columns in lockstep. The trade-off (if `plan` is ever written by something other than the switcher — nothing does today) is flagged as PTU2 below.

**Existing-user backfill: confirmed unnecessary.** Grepped every write site of `storageLimitBytes` in `backend/src/` — the ONLY places that ever set it are test fixtures (`upload.smoke.test.ts`, `upload-batch.smoke.test.ts`, `dashboard.smoke.test.ts`), never application code. Every real row in the database today carries the schema default (`5368709120` = 5GB), which is also exactly Free's tier number below — so no existing user is out of sync with what their (implicit, unset) plan already implies. No migration/backfill script is needed for this pass; the sync-at-switch logic is sufficient going forward since nothing pre-dates it that needs correcting.

### BullMQ priority direction (stated explicitly, this is the easy mistake)

BullMQ: **lower `priority` number = processed FIRST.** "High priority" (Studio) must map to the SMALLEST integer, not the largest.

## Scope for this sprint

### 1. `backend/src/lib/plans.ts` — new exports, same file, same pattern as `FREE_PLAN_MAX_ACTIVE_GUESTS`/`checkGuestLimit`

```ts
export type PlanTier = "free" | "pro" | "studio";

export const BATCH_LIMITS: Record<PlanTier, number> = {
  free: 50,
  pro: 500,
  studio: 1500,
};

export const STORAGE_LIMITS_BYTES: Record<PlanTier, bigint> = {
  free: 5n * 1024n * 1024n * 1024n,     // 5 GB
  pro: 100n * 1024n * 1024n * 1024n,    // 100 GB
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

function normalizePlan(plan: string): PlanTier {
  return plan === "pro" || plan === "studio" ? plan : "free";
}

export function getBatchLimit(plan: string): number {
  return BATCH_LIMITS[normalizePlan(plan)];
}

export function getStorageLimitBytes(plan: string): bigint {
  return STORAGE_LIMITS_BYTES[normalizePlan(plan)];
}

export function getJobPriority(plan: string): number {
  return PRIORITY_BY_PLAN[normalizePlan(plan)];
}
```

`normalizePlan` defensively treats any unrecognized string (including a stale/corrupt value) as `free` — the same safe-default posture `checkGuestLimit` already takes with `owner?.plan !== "free"`. `checkGuestLimit`/`countActiveGuestsForOwner` are untouched.

**PTU1 (enum vs. string) affects this file's type signatures — see Open Questions.**

### 2. `backend/src/routes/upload.ts` — `POST /api/upload/initiate`

- `lib/validation.ts`'s `MAX_BATCH_FILES` (currently `1000`) is renamed `ABSOLUTE_MAX_BATCH_FILES` and set to `1500` (Studio's own cap — the ceiling across all tiers, kept at the Zod-schema layer as a cheap pre-DB-lookup sanity bound). `completeUploadSchema`'s parallel `.max(MAX_BATCH_FILES, ...)` is updated to the same renamed constant (unchanged behavior there — `/complete`'s per-request chunk size is bounded by the frontend's own chunking, ~50/request per PUB9, nowhere near 1500).
- After `dbUser` is fetched (already happens, for the quota check), insert the plan-aware batch-cap check exactly as shown in Architecture notes above, returning the `batch_limit_exceeded` shape — BEFORE the existing storage-quota check (fail fast on the cheaper check first).
- No other change to `/initiate`'s logic (duplicate pre-check, `createMultipartUpload` loop, `UploadSession` creation) — all unchanged.

### 3. Storage quota check — `routes/upload.ts` `/initiate` and `routes/photos.ts` single-file route

**No code change to either quota-check call site.** Both already compare `dbUser.storageUsedBytes + <this request's bytes> > dbUser.storageLimitBytes` — this remains correct because `storageLimitBytes` is now kept in sync with `plan` at switch-time (see Architecture notes). Confirmed via grep: no other write site of `storageLimitBytes` exists in application code today.

### 4. BullMQ priority — `routes/upload.ts` `/complete` and `routes/photos.ts` single-file route

Neither call site currently passes a `priority` option to `photoProcessingQueue.add(...)`. Both need it:

- **`routes/photos.ts`'s single-file route:** `dbUser` is already fetched in full (no `select`, so `.plan` is already present on the object) — change the existing `photoProcessingQueue.add("pipeline", { photoId }, { jobId: job.id })` call to `photoProcessingQueue.add("pipeline", { photoId }, { jobId: job.id, priority: getJobPriority(dbUser.plan) })`.
- **`routes/upload.ts`'s `/complete`:** today this route never fetches the session owner's `User` row at all (`completeOneFile` only reads `UploadSessionFile`/creates `Photo`). Add ONE `prisma.user.findUnique({ where: { id: session.ownerId }, select: { plan: true } })` call before the per-file loop in the `/complete` handler (not per-file — the whole session has one owner, so one lookup, priority computed once and passed into `completeOneFile` as a parameter), then thread that priority into the existing `photoProcessingQueue.add("pipeline", { photoId: photo.id }, { jobId: job.id })` call inside `completeOneFile`, becoming `{ jobId: job.id, priority }`.
- No new queue, no new worker, no change to `photoProcessingQueue`'s definition in `lib/queue.ts` itself (`registerTrashPurgeJob`/`registerUploadSessionCleanupJob`'s own repeatable-job `.add()`-equivalent calls are maintenance jobs, not per-user photo jobs — deliberately left with NO explicit priority, same as today; they are rare/scheduled, not part of the per-user throughput story this spec is about).

### 5. `PATCH /api/auth/plan` — new endpoint in `backend/src/routes/auth.ts`

Follows the file's existing conventions (same file, same `requireAuth` + rate-limiter-per-sensitive-action pattern used by `/change-password`, same 400-on-Zod-failure shape):

```ts
// lib/validation.ts
export const updatePlanSchema = z.object({
  plan: z.enum(["free", "pro", "studio"]),
});
```

```ts
router.patch("/plan", requireAuth, asyncHandler(async (req, res) => {
  // parse via updatePlanSchema (400 on failure, standard shape)
  const newLimit = getStorageLimitBytes(input.plan);
  const user = await prisma.user.update({
    where: { id: req.user!.id },
    data: { plan: input.plan, storageLimitBytes: newLimit },
  });
  logAudit({
    actorType: "owner",
    actorId: user.id,
    ownerId: user.id,
    action: "plan_changed",
    resourceType: "user",
    resourceId: user.id,
    metadata: { fromPlan: /* previous value, read before the update */, toPlan: input.plan },
  });
  return res.status(200).json({
    user: { id: user.id, email: user.email, name: user.name, plan: user.plan },
    storage: { limitBytes: user.storageLimitBytes.toString(), usedBytes: user.storageUsedBytes.toString() },
  });
}));
```

- **No rate limiter needed beyond the default** — this isn't a password-guessing surface like `/change-password`; it's a same-session, already-authenticated, no-secret-input mutation. (Confirm/veto if Abhishek wants one anyway for consistency with every other account-mutation route.)
- **Downgrade-while-over-the-new-limit is explicitly ALLOWED, not blocked.** If a Studio user with 80GB used downgrades to Free (5GB limit), the switch still succeeds — `storageUsedBytes` (80GB) now simply exceeds `storageLimitBytes` (5GB), and the EXISTING quota check at both upload call sites already 413s any further upload attempt until usage drops back under the limit (nothing new needed — this is exactly how the flat quota check already behaves today for anyone over their limit for any reason). No special "can't downgrade" guard. (PTU3 below, low-stakes, flagged for veto only.)
- **`GET /api/auth/me`** is extended to also select+return `plan` (today's `req.user` shape from `requireAuth` only carries `id`/`email`/`name` — deliberately UNCHANGED, since widening the session middleware's shape touches every route that reads `req.user` and isn't needed for this). Instead, `/me`'s handler does its own small `prisma.user.findUnique` (same pattern `routes/dashboard.ts` and `routes/upload.ts` already use whenever a route needs more than the session gives it) to include `plan` in the response, so the frontend switcher can show the currently-selected tier on page load.

### 6. Frontend — plan switcher UI + wiring

- **New page: `frontend/src/app/settings/page.tsx`.** No account/settings surface exists in this app today (confirmed — no file matches `account`/`settings` under `frontend/src/app/`, and grepping for those terms only turns up login/signup unrelated matches). This is genuinely new UI — per CLAUDE.md's coordination protocol, Developer presents 2–3 approaches with SVG wireframes in chat and posts the pick as a pending decision before building it; Planner is not pre-picking the layout here. What IS in scope to nail down now: the endpoint it calls (`PATCH /api/auth/plan`), the copy discipline ("Plan (testing only)" or equivalent — must not read as a real self-serve upgrade flow, no pricing, no "Upgrade now" CTA styling), and that it's reachable from the same topbar nav list every other top-level page carries (`dashboard`/`organize`/`browse`/`search`/`guests`/`activity`/`trash`/`upload` — a "Settings" link added alongside the existing "Trash" link, same one-line-per-page touch `861ff25` already did for Trash, since this app has no shared nav shell yet).
- **`frontend/src/lib/api.ts`:** `authApi.me()` response type gains `plan` (backend change above); a new `authApi.updatePlan(plan: PlanTier)` calling `PATCH /api/auth/plan` — same `apiFetch` helper, same `ApiError` shape as every other `authApi` call.
- **`/upload` page:** the `batch_limit_exceeded` 400's distinct `error` value gives the upload page a hook to show an upgrade-style message (e.g. "Your Free plan allows batches of up to 50 photos — 120 were selected. Split into smaller batches, or switch plans in Settings.") instead of the current generic Zod-validation-failure copy. Exact wording is a UI-copy call for Developer, not load-bearing enough to spec verbatim.

## Acceptance criteria

- [ ] `lib/plans.ts` exports `BATCH_LIMITS`/`STORAGE_LIMITS_BYTES`/`PRIORITY_BY_PLAN` (or the enum-typed equivalents per PTU1) with exactly: free `{50, 5GB, priority 10}`, pro `{500, 100GB, priority 5}`, studio `{1500, 500GB, priority 1}` — and a unit-level confirmation that `getJobPriority("studio") < getJobPriority("free")` (the off-by-inversion the spec explicitly calls out).
- [ ] `POST /api/upload/initiate` from a `free`-plan user with 51 files → `400 { error: "batch_limit_exceeded", plan: "free", limit: 50, requested: 51 }`, nothing created (no `UploadSession`, no `createMultipartUpload` calls against MinIO).
- [ ] The same 51-file batch from a `pro`-plan user → succeeds (under Pro's 500 cap).
- [ ] A batch of 1501 files (over the absolute ceiling) from a `studio`-plan user → still 400 at the Zod-schema layer (never reaches the DB/plan lookup) — proving the two-layer design (absolute ceiling + plan-aware check) both function.
- [ ] A fresh `free`-plan user's `storageLimitBytes` is 5GB (unchanged default); switching to `pro` via `PATCH /api/auth/plan` updates `storageLimitBytes` to 100GB in the same call, confirmed via a follow-up `GET /api/auth/me` or `GET /api/dashboard`; switching to `studio` → 500GB.
- [ ] Uploading (single-file OR batch) after a downgrade that puts `storageUsedBytes` over the new (lower) `storageLimitBytes` → the EXISTING 413 quota check fires exactly as it would for any other over-quota user — no new/different error path.
- [ ] A `studio`-plan user's photo (uploaded via either the single-file route or the batch `/complete` route) is enqueued to `photoProcessingQueue` with `priority: 1`; a `free`-plan user's photo (either route) is enqueued with `priority: 10` — confirmed by inspecting the BullMQ job's own `opts.priority` (not just trusting the call was made), for BOTH the single-file and batch code paths.
- [ ] `PATCH /api/auth/plan` with an invalid value (e.g. `"premium"`) → 400, standard Zod-failure shape, `user.plan` unchanged.
- [ ] `PATCH /api/auth/plan` with no session → 401.
- [ ] A `plan_changed` audit row is written on every successful switch, readable via the existing owner-scoped `GET /api/audit`.
- [ ] The pre-existing `production-upload-batch.md` test suite (`upload-batch.smoke.test.ts`) and the single-file `upload.smoke.test.ts` both still pass unmodified in their existing assertions (any test that hardcodes the OLD flat `MAX_BATCH_FILES = 1000` or the old flat 5GB-for-everyone assumption needs its fixture updated to explicitly set a plan/limit rather than relying on the old default — flagged for Developer/Tester, not a silent behavior regression).
- [ ] `checkGuestLimit`'s existing Free-guest-cap behavior is unchanged (regression check) regardless of which way PTU1 (enum vs. string) is resolved.

## Success signal

Tester Agent can: switch a test account through all three plans via `PATCH /api/auth/plan` and confirm `GET /api/auth/me`/`GET /api/dashboard` reflect the new `plan` and `storageLimitBytes` each time; attempt a batch upload at each tier that's one file over that tier's cap and get the named `batch_limit_exceeded` shape; attempt one that's exactly at the cap and have it succeed; upload a real photo as each tier and inspect the resulting BullMQ job's `priority` field directly (via BullMQ's own job-inspection API, not just the HTTP response) to confirm Studio < Pro < Free numerically; confirm the single-file route and the batch route produce the SAME priority for the SAME plan; and confirm downgrading below current usage doesn't crash or corrupt state, just naturally 413s the next upload attempt.

## Open questions

Posted to `agents/STATUS.md` under Pending Decisions as PTU1–PTU6, recommended defaults stated below per house rule:

1. **PTU1 — RESOLVED (Abhishek, 2026-07-13): promote to a real Prisma enum.** It's been a plain `String @default("free")` since the original schema, read in exactly one place before this spec (`checkGuestLimit`'s `plan !== "free"` string comparison). This spec adds real behavioral branching on its value in ≥4 more call sites (`lib/plans.ts`'s three lookup maps, `/initiate`'s cap check, both `.add()` priority calls, the new switcher endpoint). **Recommended: promote to a Prisma enum (`enum Plan { free pro studio }`)** now, while the touch surface is still small — eliminates a whole class of typo bugs (`"Studio"` vs `"studio"` vs `"premium"`) at both the TypeScript and Postgres-constraint level, and the migration is low-risk (every existing row is already exactly `"free"`, the only value ever written). Cost: one migration + updating `checkGuestLimit`'s comparison + `lib/plans.ts`'s map types to use the generated `$Enums.Plan` type instead of `string`. Veto toward keeping it a plain string (accepting the typo risk) if Abhishek would rather not touch `checkGuestLimit`/the migration surface this pass.
2. **PTU2 — storage-limit sync-at-switch vs. compute-live.** Decided above (sync-at-switch, zero changes to existing quota-check call sites) — flagged here only because Master's brief called it a genuine fork worth surfacing, not because it's still undecided. Veto toward compute-live only if Abhishek anticipates `plan` ever being written by something other than this switcher (nothing does today).
3. **PTU3 — RESOLVED (Abhishek, 2026-07-13): allowed, no special guard.** Matches how being over-quota for any other reason already behaves — matches how being over-quota for any other reason already behaves (413 on the next upload attempt, not an account-level block). Veto toward a 409-block-the-downgrade if Abhishek wants a harder guardrail (e.g. "you must delete photos below the new limit before downgrading").
4. **PTU4 — exact `PRIORITY_BY_PLAN` integers.** Recommended: `studio: 1, pro: 5, free: 10` (spread with headroom, not tightly-packed `1/2/3`, in case a future tier needs inserting between two existing ones without renumbering everything). Confirm the exact numbers, or state a different scheme.
5. **PTU5 — audit the plan switch?** Recommended: yes, a `plan_changed` audit row (`fromPlan`/`toPlan` metadata) — consistent with the existing pattern of auditing account-affecting changes (`account_deleted`) while `updateProfileSchema`'s cosmetic name change stays unaudited; a quota/priority-affecting plan switch is arguably closer to the former than the latter. Veto toward no audit row if this is judged too high-frequency/low-stakes to log (it's a dev-testing control, not a real customer action).
6. **PTU6 — rate limiter on `PATCH /api/auth/plan`?** Recommended: none beyond whatever default/global limiter already applies — this isn't a secret-guessing surface like `/change-password` or `/login`. Veto toward adding one anyway purely for consistency with every other account-mutation route in `auth.ts`.
