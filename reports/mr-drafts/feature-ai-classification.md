# MR Draft — feature/ai-classification

**Title:** feat: AI classification organizing layer — category mapping, folder auto-creation, reclassify, dedup + rate-limit hardening

**Branch:** `feature/ai-classification` (off `feature/upload-pipeline` @ `74d1f4b`)
**Spec:** `specs/ai-classification.md` (built on the spec's stated defaults for all 11 Open Questions; no real Google Vision call anywhere — the mock in `backend/src/lib/classification/index.ts` remains the only classifier)

## Description

Implements the entire buildable portion of the AI-classification spec: labels finally become folders.

- **Schema** (`prisma/migrations/20260702090917_add_collections_folders_classification/`): new `collections` and `folders` tables (`@@unique([ownerId,name])` / `@@unique([collectionId,name])` for race-safe find-or-create), `photos.file_sha256` + `photos.dedup_method` columns, FKs for the pre-existing `collection_id`/`folder_id` columns, `(owner_id, file_sha256)` index. Verified: full history replays cleanly on a fresh database via `prisma migrate deploy`.
- **Category mapping** (`src/lib/classification/categoryMapping.ts`, new): pure module, sibling of (not part of) the provider — roadmap §13 step 5 table + priority order, three Nature aliases (Landscape/Nature/Outdoor, Open Question #2 default), case-insensitive, `<0.60` strictly-less-than threshold → Uncategorized, unmappable → Uncategorized. Threshold boundary (exactly 0.60 is categorized) is enforced by `result.confidence < CONFIDENCE_THRESHOLD`.
- **Worker** (`src/worker.ts`):
  - New step 5: mapping → race-safe find-or-create of the lazy default "My Photos" collection and the category folder (catch-P2002-and-refetch, safe at concurrency 2) → single transaction updating the photo and reconciling `photoCount` (guarded decrement, never below 0).
  - New `"reclassify"` job type: classify → hooks → mapping → folder assignment only (skips thumbnails/EXIF/dedup); clears `duplicateOfPhotoId`/`dedupMethod` when overriding a duplicate verdict (Open Question #4).
  - **Bookkeeping re-key (bug fix per spec §4):** `processing_jobs` updates now go through `prisma.processingJob.update({ where: { id: job.id } })` (BullMQ job id === row PK) instead of `updateMany`-by-photoId, which would clobber both rows once a photo has a pipeline AND a reclassify job. Tolerates cascade-deleted rows (P2025) so test cleanup can't crash the live worker.
  - Hooks: `FORCE_FAIL_` fires on pipeline jobs only (enables failed → reclassify → done); `FORCE_LOWCONF_` (0.42) fires on both job types.
  - Two-phase dedup: SHA-256 exact pass first (`dedupMethod: "sha256"`), then pHash near-dup pass that skips comparison when either hash is the degenerate all-zeros dHash (`DEGENERATE_PHASH` exported from `src/lib/phash.ts`) — Tester's flat-image false-positive is closed; flat images dedup only on exact bytes.
- **Routes:**
  - `GET /api/collections`, `GET/POST /api/collections/:id/folders` (`src/routes/collections.ts`, new; POST creates `categoryType: "custom"`, 409 on duplicate name, Zod 1–255-char name).
  - `GET /api/folders/:id/photos` (`src/routes/folders.ts`, new; Zod-validated limit ≤100/offset, 400 not clamp; 150px pre-signed 60s thumbnails, never raw keys).
  - `PATCH /api/photos/:id` (move; transaction reconciles both photoCounts; never touches classification fields), `POST /api/photos/:id/reclassify` (409 while pending/processing; own per-user 30/15min bucket in `src/middleware/reclassifyRateLimiter.ts`; enqueues with `{ jobId: processingJobRow.id }`).
  - Additive fields: `GET /api/photos/:id` gains `exif` object (carry-over c), `folder`, `collectionId`; `GET /api/photos/:id/status` gains `folder`, `collectionId`, `dedupMethod`, and `job {type,status,attempts,errorMessage}` (latest row — closes the Tester observability gap).
  - Upload handler stores `fileSha256` at row creation.
  - All new endpoints: `requireAuth` + `asyncHandler` + Zod + 404-not-403 ownership.
- **Auth limiter split (carry-over a):** `signupRateLimiter` (5/15min/IP) + `loginRateLimiter` (10/15min/IP), both limit-1000 under `NODE_ENV=test`. Handlers/Zod/session logic untouched.
- **Mock + fixtures:** `MOCK_LABEL_SETS` extended to 7 sets (People/Food/Documents/Nature-aliases/Animals/Vehicles/unmappable). Seven committed fixtures in `backend/test/fixtures/` (+ README with filename → labels → expected-folder table), each verified through the real `classify()`+`mapToCategory()` path, pairwise pHash distance ≥20 so same-user multi-fixture uploads never false-dedup.
- **Pre-existing test bug fixed:** `auth.smoke.test.ts` built its duplicate-signup email as `smoke-<ts>@example.com-dup` — invalid under zod 3.25's email regex (TLD letters-only), so both signups 400'd and the 409 path was never actually exercised. Verified pre-existing at `74d1f4b` (schema + test unchanged there, zod 3.25.76 already in the lockfile). Fixed to `dup-<email>` and the first signup's 201 is now asserted.

## Not in this MR (deliberately)

- Reclassification UI — **blocked on Abhishek's wireframe pick.** Three options at `design/wireframes/proposals/reclassify-ui-option-{a,b,c}.svg`.
- Real Vision API, collections CRUD, folder rename/merge/delete, secondary-tags table, bulk backfill, Next.js advisory upgrade (all spec Non-goals).

## Files touched

- `backend/prisma/schema.prisma`, `backend/prisma/migrations/20260702090917_add_collections_folders_classification/migration.sql`
- `backend/src/lib/classification/categoryMapping.ts` (new), `backend/src/lib/classification/index.ts`, `backend/src/lib/phash.ts`, `backend/src/lib/validation.ts`
- `backend/src/worker.ts`, `backend/src/routes/photos.ts`, `backend/src/routes/collections.ts` (new), `backend/src/routes/folders.ts` (new), `backend/src/routes/auth.ts`, `backend/src/app.ts`, `backend/src/middleware/reclassifyRateLimiter.ts` (new)
- `backend/src/__tests__/classification.smoke.test.ts` (new), `backend/src/__tests__/auth.smoke.test.ts`
- `backend/test/fixtures/fixture-{people,food,documents,nature,animals,vehicles,unmappable}.jpg` + `README.md` (new)
- `design/wireframes/proposals/reclassify-ui-option-{a,b,c}.svg` (new)

## Testing notes

- `npm run typecheck -w backend` — clean. `npm run lint -w backend` — clean, 0 errors.
- `NODE_ENV=test npm run test -w backend` — **24/24 passed, run twice back-to-back, zero 429s** (the exact flake documented in STATUS.md is fixed). Suite includes live-worker e2e (real BullMQ queue + the running worker process): folder auto-creation + default collection, folder reuse with photoCount=2, Uncategorized (unmappable + FORCE_LOWCONF_), sha256 duplicate + reclassify rescue, FORCE_FAIL_ → failed (attempts=3, errorMessage persisted, observed via the new `job` object) → reclassify → done in Animals, 409-in-progress, custom-folder 201/409/400, move with photoCount reconciliation, pagination + Zod 400s + pre-signed thumbnail URLs, 401 on all six new endpoints, 404-not-403 on all cross-user probes (incl. own-photo → foreign-folder), 8 rapid logins never 429 under test env. Worker-dependent tests skip-with-warning (never fake) if infra/worker are down.
- Fresh-DB migration replay verified: `prisma migrate deploy` against a scratch database applies all three migrations cleanly.
- Frontend untouched (status-endpoint changes are additive; `/upload` page keeps working) — frontend typecheck not run, per scope.
- Fixture regeneration recipe: 96×96 seeded-noise JPEG (LCG `s = s*1103515245+12345`, bytes `(s>>>16)&0xff`, Sharp quality 90); pick seeds until `sha256[0] % 7` hits the target set with pairwise dHash distance ≥20. Seeds used: people=3, food=7, documents=14, nature=2, animals=12, vehicles=18, unmappable=1; the in-test second-food image uses seed 102.
