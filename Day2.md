# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Note: this repo already has a root `CLAUDE.md` (multi-agent orchestration workflow) and `Day1.md` (application codebase guide as of the upload-pipeline build, commit `74d1f4b`). This file supersedes Day1.md's "Architecture" section with what changed today, on `feature/ai-classification` (commits `8f1f065`…`27afa75`, branched off `74d1f4b`) — the AI classification / folder-organizing layer. Read Day1.md first for auth, upload, and the frontend/testing baseline; this file only covers what's new or changed since.

## What today added, in one sentence

Classification results stop being dead weight on the `photos` row — labels now become folders, low-confidence results get a reviewable "Uncategorized" bucket, users can move photos or force a re-run, and three carried-over hardening items from the previous Tester report (auth rate-limit friction, a pHash false-positive, an EXIF testability gap) are fixed.

## Commands (additions/changes to Day1.md's list)

```bash
# New migration on top of Day1.md's baseline + upload-pipeline migration
# backend/prisma/migrations/20260702090917_add_collections_folders_classification/
npx prisma migrate deploy   # replays all 3 migrations cleanly on a fresh DB (verified)

# Test files added this session (vitest filename filter, same convention as Day1.md)
npm run test -w backend -- classification.smoke     # live-worker e2e: folders, dedup, reclassify, pagination
npm run test -w backend -- classification.offline    # classify() runs with every network entry point stubbed to throw
npm run test -w backend -- dedup.regression           # deterministic DB-state tests for the dedup candidate queries
```

No new top-level scripts; the `dev:backend`/`dev:frontend`/`worker` commands and Docker Compose usage from Day1.md are unchanged. `NODE_ENV=test` now matters more than before — see Rate limiting below.

## Architecture additions

### Schema: `Collection` and `Folder` (new tables)

`backend/prisma/schema.prisma` gains two models feeding off the existing `Photo.collectionId`/`folderId` columns (present but always-null since the upload-pipeline pass):

- **`Collection`** — `@@unique([ownerId, name])`. This pass only ever creates one per user: a lazy default named `"My Photos"`, created by the worker at first folder assignment (not at signup). There is no collections CRUD beyond `GET /api/collections` (list-only).
- **`Folder`** — `@@unique([collectionId, name])`, `categoryType: "ai_generated" | "custom"`, `photoCount` maintained by increment/decrement (never a live `COUNT(*)`). Create-only: no rename/merge/delete endpoints exist yet (Week 7–8 scope).

Both unique constraints exist specifically so **find-or-create is race-safe under worker concurrency 2** — see the pattern below.

### The find-or-create-under-concurrency pattern

`backend/src/worker.ts`'s `findOrCreateDefaultCollection` / `findOrCreateFolder`: plain find-then-create is unsafe when two jobs can create the same brand-new folder simultaneously (e.g. two photos in a never-before-seen category, both racing at concurrency 2). The pattern is: find → create → **on a P2002 unique-violation, refetch and return the winner's row** instead of erroring. Any new "get-or-make" resource in this codebase under worker concurrency should follow this shape, not a naive `findFirst ?? create`.

### Category mapping: `backend/src/lib/classification/categoryMapping.ts` (new)

A **pure module, deliberately a sibling of the classification provider (`lib/classification/index.ts`), never merged into it** — this is the seam that keeps a future real-Vision swap-in a one-file change. `mapToCategory(result)`:
- confidence `< 0.60` (strict less-than — exactly 0.60 **is** categorized) → always `"Uncategorized"`, regardless of labels.
- otherwise, matches every label against `LABEL_TO_CATEGORY` and returns the **highest-priority** matched category per `CATEGORY_PRIORITY` (People > Nature > Animals > Food > Vehicles > Documents > Screenshots) — a multi-category label set doesn't average or pick arbitrarily, priority order is a real product decision baked into this list.
- no label matches anything → `"Uncategorized"`.

If you touch the mock's label sets (`lib/classification/index.ts`'s `MOCK_LABEL_SETS`), check this file's alias list stays in sync — three aliases (`landscape`/`nature`/`outdoor` → Nature) exist purely so the mock's fixture labels exercise mapping at all, not because the roadmap's table lists them.

### The two-phase dedup gate — read this before touching anything duplicate-related

`worker.ts`'s step 3 changed from a single pHash check (Day1.md) to two phases, and the candidate-selection logic now lives in **`backend/src/lib/dedup.ts`** (extracted specifically so it's unit-testable against a real DB, see `dedup.regression.test.ts`):

1. **Phase 1 (exact):** `photos.file_sha256` (set at upload time, before any job runs) — `findExactDuplicateOriginal`.
2. **Phase 2 (near-dup):** pHash Hamming distance `< 10` — `findNearDuplicateOriginal`, only run if phase 1 found nothing (and the pHash computation itself is skipped entirely for exact dups).

**Both phases share one invariant, and it is load-bearing — don't weaken it without re-deriving the proof:** every dedup edge must point to a candidate that is (a) **not itself already a duplicate** (`duplicateOfPhotoId: null`) and (b) **strictly older** under the total order `(createdAt, id)`. This was not obvious from a naive implementation — the first cut only constrained the SHA-256 phase, and a same-bytes double-upload could produce **mutual duplicates** (photo A marked duplicate-of B via phash while B was marked duplicate-of A via sha256, both permanently stuck with no folder and never classified) through a timing-dependent race at worker concurrency 2 or a BullMQ retry. The fix constrains *both* phases identically, and rows marked `duplicate` have their `phash` explicitly nulled (not just left unread) as defense-in-depth. If you ever add a third dedup signal, it must obey the same two constraints or the cycle-impossibility proof no longer holds.

The other pre-existing dedup behavior is unchanged from Day1.md: flat/solid-color images degenerate to an identical dHash (`DEGENERATE_PHASH`, all zeros) and are guarded against comparing to each other via pHash — they still dedup correctly through the SHA-256 exact pass on a byte-identical re-upload, just never falsely via near-dup.

### Reclassify: a second BullMQ job type sharing the same queue

`POST /api/photos/:id/reclassify` (in `routes/photos.ts`) is the manual retry/override path — the user-facing rescue for a photo stuck `failed`, and the escape hatch for a pHash/sha256 false-positive `duplicate`. Two things about it matter architecturally:

- **`processing_jobs` bookkeeping is keyed by BullMQ job id, not `photoId`.** This is a correctness fix, not a style choice: once a photo can have *two* job rows (its original pipeline job and a later reclassify job), any `updateMany({ where: { photoId } })` in the worker's processor/completed/failed handlers would silently update **both** rows on every event — resurrecting a long-completed pipeline row to `active`, or marking it `failed` because a *later* reclassify job failed. Both enqueue call sites (`routes/photos.ts`'s upload handler and reclassify handler) pass `{ jobId: processingJobRow.id }` specifically so the worker can key bookkeeping by `job.id` (`updateProcessingJobById` in `worker.ts`) and always update the *right* row. If you add a third job type, keep this convention.
- **The reclassify endpoint claims the photo atomically, not via a check-then-act 409 guard.** A naive "read status, if terminal then enqueue" is a TOCTOU race — two rapid clicks both pass the guard and both enqueue. The actual implementation is a single conditional `UPDATE photos SET ai_classification_status='pending' WHERE id=? AND owner_id=? AND ai_classification_status NOT IN ('pending','processing')`; only the request that gets `count === 1` proceeds to create the job row and enqueue. Everyone else gets a clean 409. If the enqueue itself then fails (e.g. Redis hiccup), the handler compensates by deleting the orphan job row and reverting the status — otherwise the photo would be stuck `pending` forever with every future reclassify attempt also 409ing. **Any future "claim a resource then do async work" endpoint in this codebase should follow this same atomic-conditional-update shape**, not a separate read-then-write.

`FORCE_FAIL_` (forces a pipeline job to fail 3x, ending in `failed`) applies **only to the initial pipeline job**, deliberately — this is what lets a Tester walk a single file through `failed → reclassify → done`. `FORCE_LOWCONF_` (forces confidence to `0.42`, landing in Uncategorized) applies to **both** job types, since the mock's real confidence range (~0.75–0.94) can never otherwise exercise the `<0.60` branch.

### `photoCount` reconciliation needs Serializable isolation

Any code that moves a photo between folders (`assignPhotoToFolder` in `worker.ts`, and `PATCH /api/photos/:id` in `routes/photos.ts`) re-reads the photo's *current* `folderId` inside its own transaction before incrementing/decrementing counts. Under Postgres's default Read Committed isolation, that read can be stale by write time when two such operations race (e.g. a manual move landing mid-reclassify) — both transactions can read the same "before" state and the counts drift permanently. The fix, `backend/src/lib/serializableTransaction.ts`, runs these specific transactions at `Serializable` isolation and transparently retries on Postgres's `P2034` conflict error (jittered backoff, capped retries). **Any new code that reads-then-writes a counter shared across concurrent operations should use `serializableTransaction()` instead of `prisma.$transaction()` directly** — plain Read Committed is not safe for this shape.

### New routes

- `GET /api/collections` — list-only, requester's own collections.
- `GET /api/collections/:id/folders`, `POST /api/collections/:id/folders` — list/create folders in an owned collection (`routes/collections.ts`, new file). POST is `categoryType: "custom"`; a duplicate name within the collection is a 409 off the `@@unique` constraint, not an app-level pre-check.
- `GET /api/folders/:id/photos` — paginated (`limit`/`offset`, Zod-validated, `limit > 100` is a 400 not a clamp), newest-first, each photo's thumbnail returned as a pre-signed 60s URL (`routes/folders.ts`, new file) — same "never a raw storage key" rule as everywhere else in this codebase.
- `PATCH /api/photos/:id` — move a photo to another owned folder; reconciles both folders' `photoCount` via the serializable-transaction pattern above; never touches classification fields.
- `POST /api/photos/:id/reclassify` — see above. Has its own rate limiter (`middleware/reclassifyRateLimiter.ts`, 30/15min per-user), independent of both `uploadRateLimiter` and the auth limiters.

All four new/changed route files follow the exact conventions Day1.md already documents: `requireAuth` + `asyncHandler` + Zod validation + **404 (never 403) on any ownership mismatch** — extended in this pass to cover collections, folders, and folder-photos, not just the existing photo endpoints.

### Additive fields on existing endpoints

`GET /api/photos/:id` and `.../status` gained, additively (nothing removed or renamed): `exif` (an object — `cameraMake`/`cameraModel`/GPS/`takenAt`, all-null when absent, not an error), `folderId`, `collectionId`, `dedupMethod` (`"sha256" | "phash" | null`), and `job` (`{type, status, attempts, errorMessage}` for the photo's *latest* processing-job row). These exist specifically so black-box testing can verify worker-internal behavior (EXIF extraction, retry counts, which dedup phase fired) without direct database access — before this pass, both EXIF and exact retry/error values were "code-reviewed only" gaps in every Tester report.

### Auth rate limiting is now two buckets, not one

Day1.md documents a single shared `authRateLimiter` (5/15min/IP) covering both `/signup` and `/login` — flagged there as a known friction source. `backend/src/routes/auth.ts` now has `signupRateLimiter` (5/15min/IP) and `loginRateLimiter` (10/15min/IP) as **fully independent** `express-rate-limit` instances, and **both are relaxed to `limit: 1000` when `process.env.NODE_ENV === "test"`** — this is why `npm run test -w backend` can now be run twice back-to-back without manual workarounds (previously required restarting the backend mid-suite to clear in-memory limiter state). If you add a new auth-adjacent endpoint, decide explicitly whether it needs its own bucket or can share one of these two; don't default it onto whichever limiter happens to be nearby.

### Reclassification UI: intentionally not built

Per this repo's UI-decision protocol (root `CLAUDE.md`), the manual reclassification/move UI was **not implemented** this session. Three SVG wireframe options exist at `design/wireframes/proposals/reclassify-ui-option-{a,b,c}.svg`, awaiting a pick; the backend (folder listing with counts, folder photos with thumbnails, move, create-folder, reclassify+poll) is fully built and tested so the UI build itself should be a thin client layer once a wireframe is chosen. `frontend/src/app/` is completely unchanged this session — no new pages.

## Testing (additions to Day1.md)

Three new backend test files, all Vitest + Supertest/direct-DB, same skip-not-fake discipline as `auth.smoke.test.ts`:
- **`classification.smoke.test.ts`** — the big one; live-worker e2e against the real running stack (category mappings, folder reuse, concurrency races, pagination, move, all four reclassify paths, cross-user isolation on every new endpoint).
- **`classification.offline.test.ts`** — stubs `fetch`/`http`/`https`/`net.Socket.connect` to throw, then runs the real `classify()` on all seven committed fixtures — proof that classification cannot reach the network, independent of the live stack.
- **`dedup.regression.test.ts`** — constructs specific DB states directly (rather than racing a live worker, which would be flaky) and asserts `lib/dedup.ts`'s candidate queries respect the strictly-older/non-duplicate invariant.

Seven committed fixture images live in `backend/test/fixtures/` with a `README.md` mapping filename → expected labels → expected folder — generated deterministically (seeded PRNG → JPEG bytes) so they're reproducible without binary assets in git history being a concern. If you add an eighth fixture, follow the README's seed-selection recipe (pick a seed until `sha256[0] % 7` lands on the target label set, and check pairwise pHash distance ≥20 against the existing seven so multi-fixture uploads by one user never accidentally near-dup each other).

## Known accepted trade-offs (not bugs — don't "fix" without reading the reasoning first)

- **A rapid double-upload of the same file always flags the newer copy as `duplicate`**, even if the older copy hasn't finished its own pipeline yet (and might itself later fail). This is intentional: the alternative (only matching already-fully-processed candidates) would let both copies of the overwhelmingly-common instant-re-upload case classify independently with zero dedup. The reclassify endpoint is the accepted escape hatch if the "duplicate" copy needs rescuing.
- **A duplicate can, under a narrow concurrent race (near-simultaneous upload of a re-encoded copy and a byte-identical copy of that re-encode), end up pointing at another duplicate rather than the canonical original.** Chains stay finite and acyclic — no data loss, no stuck state, reclassify still works on either photo — this is different from and much narrower than the mutual-cycle bug that was actually fixed. Documented in `agents/STATUS.md`'s Pending Decisions rather than chased further.
- **Reclassifying a photo permanently loses its `phash`** (explicitly nulled when marked duplicate, and reclassify doesn't recompute it) — an accepted side effect of closing the cycle bug cheaply; a reclassified-and-rescued photo can only be exact-matched (sha256) by future uploads, not near-dup matched.

## Where to look next

- `reports/mr-drafts/feature-ai-classification.md` — the full build history for this session, including the adversarial-review findings and the exact repro steps for both bugs that were caught before Tester ever saw the branch. More detail than this file; read it before touching dedup or the reclassify endpoint.
- `specs/ai-classification.md` — the spec this was built against, including 10 explicitly-flagged assumptions (default collection semantics, mapping aliases, rate-limit numbers, etc.) with stated defaults — check it before assuming a number or behavior here is arbitrary.
- `agents/STATUS.md` — current live status, the reclassification-UI wireframe decision pending, and the accepted-trade-off list above in more detail.
