# MR Draft — Plan-tiered upload: batch caps, storage quotas & job priority

**Branch:** `feature/ai-classification` (local commit `e45672f`, not pushed — no GitHub remote connected)
**Spec:** `specs/plan-tiered-upload.md` (addendum to `specs/production-upload-batch.md`, commit `e86f126`)
**Status:** Backend + non-UI frontend BUILT and tested. The `/settings` page itself is **deliberately not built** — blocked on Abhishek's wireframe pick (see "Not done" below).

## Summary

Reinstates the two items `production-upload-batch.md` deliberately trimmed: per-plan batch caps/storage quotas, and BullMQ job priority by plan. Adds a no-billing, testing-only plan switcher.

## What changed

### Schema
- `User.plan` promoted from a plain `String @default("free")` to a real Prisma enum, `enum Plan { free pro studio }` (default `free`). PTU1, resolved by Abhishek.
- Hand-written migration `backend/prisma/migrations/20260713180000_promote_user_plan_to_enum/migration.sql` — `prisma migrate dev`/`--create-only` both refused to run non-interactively (the CLI detects a String→Enum column change as a potential-data-loss drop+recreate and prompts for confirmation, which isn't available in this environment). Written by hand instead, same precedent as the trash-system's hand-edited partial-unique-index migration: `CREATE TYPE "Plan" ...`, then `ALTER COLUMN "plan" TYPE "Plan" USING ("plan"::"Plan")` — a genuine cast, not a drop. **Confirmed via `psql` before migrating that all 67 existing rows were already exactly `"free"`** (the only value anything had ever written), so this is lossless. Applied via `prisma migrate deploy`, then `prisma generate`; re-verified 67/67 rows still `free` post-migration.

### `backend/src/lib/plans.ts`
- New exports: `PlanTier` (aliased directly to the generated `$Enums.Plan`, **not** the plain-string type the spec's own literal code block showed — that block was written before PTU1 was resolved to a real enum; reconciled deliberately per the task's instruction), `BATCH_LIMITS`/`STORAGE_LIMITS_BYTES`/`PRIORITY_BY_PLAN` (free `{50, 5GB, 10}` / pro `{500, 100GB, 5}` / studio `{1500, 500GB, 1}`), `getBatchLimit`/`getStorageLimitBytes`/`getJobPriority`.
- `checkGuestLimit`/`countActiveGuestsForOwner` untouched in logic — `checkGuestLimit`'s `plan !== "free"` comparison behaves identically against the enum (its members compare equal to the string literal), now just typo-proof at the type level.

### `backend/src/lib/validation.ts`
- `MAX_BATCH_FILES` renamed `ABSOLUTE_MAX_BATCH_FILES`, value changed `1000 → 1500` (Studio's own cap — the cross-tier ceiling, kept at the Zod-schema layer as cheap pre-DB-lookup defense-in-depth). Both `initiateUploadSchema` and `completeUploadSchema`'s `.max()` calls updated to the renamed constant.
- New `updatePlanSchema` (`z.enum(["free","pro","studio"])`) for the switcher.

### `backend/src/routes/upload.ts`
- `POST /initiate`: after `dbUser` is fetched (already happened, for the quota check), added the real plan-aware batch-cap check — `getBatchLimit(dbUser.plan)`, returning `400 { error: "batch_limit_exceeded", plan, limit, requested }` — ordered **before** the existing storage-quota 413 check, per the spec.
- `POST /complete`: added the session-owner `plan` lookup this route never did before (`prisma.user.findUnique({ where: { id: session.ownerId }, select: { plan: true } })`), computed once, threaded through `completeOneFile(sessionId, ownerId, item, priority)` into the existing `photoProcessingQueue.add(...)` call (`{ jobId: job.id, priority }`).

### `backend/src/routes/photos.ts`
- Single-file route's existing `photoProcessingQueue.add(...)` call gains `priority: getJobPriority(dbUser.plan)` — `dbUser` was already fully fetched (no `.select`) for the quota check, so `.plan` was already in hand.
- The unrelated `reclassify` route's own separate `.add()` call is **untouched** — out of scope per the spec (not part of the per-user upload throughput story).

### `backend/src/routes/auth.ts`
- New `PATCH /plan`: parses via `updatePlanSchema`, looks up the current plan (for the audit row's `fromPlan`), writes `plan` + `storageLimitBytes` (via `getStorageLimitBytes`) in **one** `prisma.user.update` call (PTU2's sync-at-switch decision — zero changes needed at either existing quota-check call site), writes a `plan_changed` audit row, returns `{ user: {..., plan}, storage: { limitBytes, usedBytes } }`. No new rate limiter (PTU6, unchallenged default) — same posture as every other non-secret-guessing account-mutation route in this file.
- `GET /me` extended with its own small `prisma.user.findUnique({ select: { plan: true } })` — `requireAuth`'s `req.user` shape (`id`/`email`/`name`) is deliberately **unchanged**, per the spec (widening it touches every route that reads `req.user`).
- PTU3 confirmed working exactly as decided: no downgrade guard. A downgrade while `storageUsedBytes` exceeds the new (lower) limit succeeds; the existing 413 quota check on the very next upload attempt handles it — verified live in the new test suite (see below), not just asserted.

### `backend/src/lib/audit.ts`
- Added `"plan_changed"` to the `AuditAction` union (metadata carries `fromPlan`/`toPlan`). Not added to `lib/validation.ts`'s `AUDIT_ACTIONS` filter enum — matching the pre-existing, already-documented gap that `"account_deleted"` isn't in that filter list either (a pre-existing pattern, not a new inconsistency introduced by this pass).

### Frontend (`frontend/src/lib/api.ts`, `frontend/src/app/upload/page.tsx`)
- `PlanTier`, `MeResponse`, `UpdatePlanResponse` types added; `authApi.me()` now typed to return `plan`; new `authApi.updatePlan(plan)`.
- New `BatchLimitExceededBody` type + `isBatchLimitExceeded()` type guard (same pattern as the existing `isRestoreConflict`/`isFolderDeletedConflict`).
- `/upload`'s `runBatch()` now special-cases a `batch_limit_exceeded` initiate-failure with a named message ("Your free plan allows batches of up to 50 photos — 120 were selected. Split into smaller batches, or switch plans in Settings.") instead of falling through to the generic "Could not start the upload batch" text. This was explicit copy latitude in the spec (not load-bearing enough to spec verbatim), so it did **not** need a wireframe round — it's error text on an existing surface, not new UI.

## Not done — the `/settings` page (deliberately stopped, not guessed)

Per CLAUDE.md's coordination protocol, a brand-new user-facing UI surface needs a propose→pick→build round before code, and the task's own instructions were explicit: stop and say so rather than build ahead of Abhishek's pick. No account/settings page exists anywhere in this app today, so the plan switcher's frontend is genuinely new UI.

Three lightweight SVG options proposed (posted to `agents/STATUS.md`'s Pending Decisions, saved at `design/wireframes/proposals/settings-option-{a,b,c}.svg`):
- **Option A** — dedicated `/settings` page, one card, a 3-way segmented control that applies instantly on click. *Recommended* — matches the existing "click = immediate action" precedent for low-stakes toggles, smallest amount of new UI state, and this is explicitly a testing-only control (cheap to undo).
- **Option B** — dedicated `/settings` page, 3 stacked radio rows with a mini comparison table per tier, plus an explicit "Apply plan" button. Safer runner-up if an explicit-apply step or more visible per-tier numbers are preferred.
- **Option C** — no dedicated page, a profile-menu dropdown off a new topbar avatar. Rejected in the recommendation: this app has no avatar/profile-menu affordance today, so it's new UI on top of new UI, and it skips the spec's own ask for a page reachable from the shared topbar nav (same place Trash/Activity/Search live).

Once picked, still to build: `frontend/src/app/settings/page.tsx` against the chosen layout, and the "Settings" topbar nav link on all 8 authed pages (`dashboard`/`organize`/`browse`/`search`/`guests`/`activity`/`trash`/`upload`), same one-line-per-page pattern `861ff25` used for Trash.

## Testing

- New `backend/src/__tests__/plan-tiered-upload.smoke.test.ts` — 12 tests, against real local Postgres/MinIO/Redis:
  - `lib/plans.ts` exports the exact spec'd numbers; `getJobPriority("studio") < getJobPriority("pro") < getJobPriority("free")` (the off-by-inversion the spec explicitly flags); an unrecognized plan string safely normalizes to `free`.
  - `PATCH /api/auth/plan`: 401 no session, 400 invalid value (plan unchanged), a full free→pro→studio→free switch cycle each confirmed via both `GET /api/auth/me` and `GET /api/dashboard`, and a `plan_changed` audit row readable via `GET /api/audit` for each switch.
  - Downgrade-while-over-quota: studio→10GB used→downgrade to free succeeds, next single-file upload attempt gets the existing 413 (not a new/different error path).
  - Batch cap: free plan + 51 files → `400 batch_limit_exceeded` with the exact `{plan, limit, requested}` shape, nothing created; the same 51 files on pro → `201`; studio + 1501 files → `400` but at the **generic Zod-schema layer** (`error: "Validation failed"`, not `batch_limit_exceeded`) — proving the two-layer design (the plan-aware check never runs because the absolute ceiling rejected it first).
  - BullMQ priority: single-file route AND batch `/complete` both produce `priority: 1` for a studio user and `priority: 10` for a free user, inspected directly via `photoProcessingQueue.getJob(id).opts.priority` (not just trusting the call was made).
- **Retargeted one pre-existing fixture**, flagged by the spec itself as expected: `upload-batch.smoke.test.ts`'s "over MAX_BATCH_FILES" test hardcoded the old flat 1000-file ceiling against a plain (now free-plan-by-default) test user — updated to assert the new `batch_limit_exceeded` shape at free's real 50-file cap; the absolute-ceiling case now lives in the new test file instead.
- `upload.smoke.test.ts`/`dashboard.smoke.test.ts`'s flat-5GB fixture resets needed **no change** — `getStorageLimitBytes("free")` is still exactly 5GB, so those fixtures remain correct for a fresh/default free-plan user.
- `plans.smoke.test.ts`'s existing `checkGuestLimit` coverage passes unmodified — confirms the enum promotion didn't change guest-limit behavior.
- **Full backend suite: 289/289** (277 pre-existing + 12 new). `tsc --noEmit` and `eslint` clean on both backend and frontend. `next build` not re-run standalone this pass (no new page/route added yet on the frontend — will re-run once `/settings` exists).

## Files touched

Backend: `prisma/schema.prisma`, `prisma/migrations/20260713180000_promote_user_plan_to_enum/migration.sql` (new), `src/lib/plans.ts` (new), `src/lib/validation.ts`, `src/lib/audit.ts`, `src/routes/auth.ts`, `src/routes/photos.ts`, `src/routes/upload.ts`, `src/__tests__/plan-tiered-upload.smoke.test.ts` (new), `src/__tests__/upload-batch.smoke.test.ts`.
Frontend: `src/lib/api.ts`, `src/app/upload/page.tsx`.
Design: `design/wireframes/proposals/settings-option-{a,b,c}.svg` (new).
Docs: `agents/STATUS.md`.

**Note on the working tree (same caveat as `production-upload-batch.md`'s MR draft):** this branch carried substantial uncommitted work from earlier sessions before this task started. `schema.prisma`, `lib/validation.ts`, `lib/audit.ts`, `routes/auth.ts`, `routes/photos.ts`, and `frontend/src/lib/api.ts`/`upload/page.tsx` all already had pre-existing uncommitted changes on them with no clean git-level way to separate hunks — this commit's diff on those files necessarily includes that pre-existing content too. Every other unrelated file was left untouched/unstaged (verified via `git status` before committing).

---

## Addendum (2026-07-14) — `/settings` page + nav link BUILT, commit `f18d409`

Unblocked by Abhishek's wireframe pick (`agents/STATUS.md`: "PICKED 2026-07-14 (Abhishek): a merge of A + B"). **Spec is now fully shipped end-to-end, both layers.**

### What changed
- New `frontend/src/app/settings/page.tsx`: a single card, a Free/Pro/Studio segmented control. Clicking a segment calls `authApi.updatePlan(plan)` immediately — Option A's mechanic, no separate "Apply" button, no confirm dialog. Each segment shows its tier name **and** inline comparison numbers ("Free — 50/batch · 5GB · Low", etc.) per Option B's information density, pulling the same hardcoded numbers `backend/src/lib/plans.ts` enforces (no new endpoint added just to fetch 9 static constants). `authApi.me()` on mount highlights the currently-active segment. Copy: "Plan (testing only — no billing)" above the control, no pricing, no upgrade-CTA styling. A transient inline success line ("Switched to Pro.") appears for 3s after a successful switch; `updatePlan()` failures (401 redirects to `/login`, 400/other renders inline via the same `.share-error` class used elsewhere) are surfaced, not swallowed.
- "Settings" added to the shared topbar nav on all 8 authed pages (`activity`, `browse`, `dashboard`, `guests`, `organize`, `search`, `share`, `upload`) — same one-line-per-page `<Link>` pattern `861ff25` used for "Trash", positioned immediately after the Trash link (same position/style, no new nav pattern invented).
- `design/wireframes/settings.svg`: the picked A+B merge saved as the lasting design record, per CLAUDE.md's "no separate Figma step" rule.

### On the A+B synthesis reading
The task handed down Master's interpretation of "both A and B" as: A's instant-apply mechanic + B's inline stat density. Built exactly that reading — it reconciles cleanly with no real tension: A and B differ on exactly two independent axes (apply-immediately vs. explicit-button; sparse label vs. dense stats), and the merge just picks one side of each axis rather than needing to invent new behavior. No adjustment needed, no alternative reading seemed more plausible while building it.

### Verification
- `tsc --noEmit` (frontend): clean, zero errors.
- `next lint`: "No ESLint warnings or errors."
- `next build`: clean production build, `/settings` compiles as a static (`○`) route at 3.54 kB / 99.6 kB First Load JS, alongside all other existing routes.
- **No browser-based click-through was performed.** This repo has no Playwright/browser-automation tooling installed anywhere (confirmed by prior Tester sessions on 2026-07-08, re-confirmed by absence of any such devDependency in `frontend/package.json` this pass) — this is a standing tooling gap, not something skipped for this feature specifically. Verified instead by: reading the built page against the exact wireframe/spec copy requirements line-by-line, confirming `authApi.updatePlan`/`authApi.me` and their response types already existed and were already backend-tested (`plan-tiered-upload.smoke.test.ts`, 12/12), and the clean typecheck/lint/build above. The one-click "switch plan" flow's correctness rests on the already-live-tested `PATCH /api/auth/plan` endpoint plus straightforward React state wiring — flagged as the one honest gap, same category prior UI passes have flagged.
- Backend untouched this pass (confirmed via `git status` before committing — no backend file staged).

### Git hygiene note
This branch's working tree still carries the same pre-existing uncommitted work flagged in the base MR draft above (backend audit fixes, a `/v2` design-system pass across most pages, etc.) — none of it authored by this task. Several of the 8 nav-link files and `globals.css` had *other*, unrelated uncommitted hunks already sitting in the working tree (a `UiV2Banner` import/usage on most pages, large `.ps2` v2 styles at the bottom of `globals.css`) before this task touched them. Rather than repeat the "your diff also swept up pre-existing content" caveat from the base draft, this pass used `git diff`+hunk-splitting (`git apply --cached` on hand-extracted per-file hunks) to stage **only** the Settings-link/Settings-CSS additions, leaving every pre-existing unrelated hunk unstaged exactly as it was found. Commit `f18d409`'s diff is scoped to exactly: 8× three-line nav-link additions, `settings/page.tsx` (new), `settings.svg` (new), and a single contiguous 106-line CSS block.

### Files touched (this addendum only)
Frontend: `src/app/settings/page.tsx` (new), `src/app/activity/page.tsx`, `src/app/browse/page.tsx`, `src/app/dashboard/page.tsx`, `src/app/guests/page.tsx`, `src/app/organize/page.tsx`, `src/app/search/page.tsx`, `src/app/share/page.tsx`, `src/app/upload/page.tsx`, `src/app/globals.css`.
Design: `design/wireframes/settings.svg` (new).
No backend file touched.
