# Spec — AI Classification (Category Mapping, Folder Auto-Creation, Confidence Bucketing, Reclassification)

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 7 (Phase 1 — MVP, Week 5–6: AI Classification), § 6 (Database Schema — `collections`, `folders`, `photos.folder_id`), § 11 (API Design — COLLECTIONS, FOLDERS, PHOTOS), § 13 (AI/ML Pipeline steps 4–7: classify, category mapping, store results, error handling)
**Status:** draft (revised after adversarial review, 2026-07-02)
**Written by:** Planner Agent, 2026-07-02

## Problem

The upload pipeline is shipped and tested clean (28/28, 0 bugs, `reports/2026-07-02_0450.md`). Photos get uploaded, thumbnailed, EXIF-tagged, dedup-gated, and "classified" by the mock — but the classification result goes nowhere. `ai_labels`/`ai_confidence` land on the `photos` row and `folder_id`/`collection_id` stay null forever, because no `collections` or `folders` tables exist yet. The core product promise ("AI organizes them") has no organizing step: labels never become folders, low-confidence results aren't bucketed anywhere reviewable, and a user has no way to correct a wrong classification or rescue a photo that landed in `failed` or was false-positive-flagged as a `duplicate`.

This spec builds the entire organizing layer *around* the existing mock classifier: label→category mapping, confidence thresholding, per-collection folder auto-creation, a re-enqueue/reclassify path, and the minimal read/move endpoints the manual reclassification UI needs. It also folds in three small, well-scoped hardening items carried over from the 2026-07-02 Tester report (see "Carry-over hardening").

**Hard constraint, stated up front: there is NO real Google Vision API call in this spec.** The existing swappable mock in `backend/src/lib/classification/index.ts` remains the only classifier (CLAUDE.md ground rule — no real cloud credentials without Abhishek's explicit go-ahead). Everything this spec adds — category mapping, folder auto-creation, confidence bucketing, reclassification — consumes the provider's `ClassificationResult` contract (`{ labels, confidence }`) and lives *outside* the provider module, so that swapping in a real Google Vision client later is a one-file change to `backend/src/lib/classification/index.ts` and nothing else. The roadmap's "Google Vision API integration" checkbox stays unchecked until that swap is explicitly approved; this spec completes every *other* Week 5–6 bullet.

## Goals

- **Category mapping** (`Vision labels → PhotoSphere folders`): a pure mapping module implementing roadmap § 13 step 5's priority table (Person/Face/People → People; Tree/Mountain/Ocean/Flower → Nature; Dog/Cat/Bird/Animal → Animals; Food/Meal/Dish/Restaurant → Food; Car/Truck/Motorcycle/Bicycle → Vehicles; Passport/Receipt/Document/Text → Documents; Screenshot/App/UI → Screenshots), separate from the classifier provider so it survives the Vision swap-in untouched.
- **Confidence threshold handling**: classification confidence `< 0.60` (strictly less than) → photo lands in the "Uncategorized" folder regardless of labels, per roadmap § 13 step 5. Labels that map to no category also → Uncategorized.
- **Folder auto-creation per collection**: worker find-or-creates the mapped category's `folders` row (`category_type = "ai_generated"`) inside the user's default collection, race-safely (worker concurrency is 2), and assigns `photos.folder_id`/`collection_id`. Requires the `collections` and `folders` tables to exist for the first time — new Prisma models + `prisma migrate dev` migration (migration history exists as of commit `74d1f4b`; this continues it).
- **Retry logic for failed classification jobs**: BullMQ 3-attempt exponential backoff *already exists* (`backend/src/lib/queue.ts` `defaultJobOptions`). The retry/backoff itself carries over to the new job type unchanged, **but the worker's `processing_jobs` bookkeeping does NOT** — it is currently keyed by `photoId` and breaks the moment a photo has more than one job row. Section 4 mandates the fix (re-key by job id). What's also missing and specced here is the *manual re-enqueue path*: `POST /api/photos/:id/reclassify` re-runs classification+mapping+folder-assignment for a photo in a terminal state (`failed`, `done`, or `duplicate`), which is both the user-facing "retry failed classification" and the escape hatch for pHash false-positive duplicates.
- **Manual reclassification** (user can move photos between folders): backend fully specced and buildable now — `PATCH /api/photos/:id` (move to folder), plus the minimal read endpoints the UI needs (`GET /api/collections`, `GET /api/collections/:id/folders`, `GET /api/folders/:id/photos`) and `POST /api/collections/:id/folders` (manual folder creation, so the UI has move targets beyond AI-created folders). The UI itself is a **clearly-separated final section, blocked on Abhishek's SVG wireframe pick** per CLAUDE.md's UI decision protocol — see "Manual reclassification UI (BLOCKED)".
- **Carry-over hardening** from `reports/2026-07-02_0450.md` (distinct section below): split the shared auth signup/login rate-limit bucket + relax it under `NODE_ENV=test`; SHA-256 exact-file-hash first pass + degenerate-pHash guard for the flat-image false-positive; expose EXIF fields on `GET /api/photos/:id` for Tester verifiability.
- **Tester observability**: two consecutive reports have had to caveat "code-reviewed only, no DB access" for job bookkeeping and dedup internals. This spec adds a minimal observable surface for both (latest-job object and `dedupMethod` on the status endpoint) so the acceptance criteria below are actually checkable black-box.
- All new endpoints follow existing conventions exactly: `requireAuth`, `asyncHandler`, Zod validation on every body/query, opaque sessions, 404-not-403 on ownership mismatch, pre-signed URLs (60s TTL) for any image bytes, never a raw storage key.

## Non-goals (explicitly out of scope for this pass)

- **Real Google Vision API integration** — repeated for emphasis: the mock stays, no network call, no GCP credentials. The roadmap's cost optimizations that only matter with a real API (resize-before-submission for API cost, batch API calls, cross-run classification result caching) are deferred to the swap-in ticket.
- **Week 7–8 Core UI** — no dashboard, no polished folder-browser grid, no fullscreen photo viewer, no drag-and-drop upload flow, no storage-usage display. `GET /api/folders/:id/photos` exists only as the minimal data source the reclassification UI (and Tester) needs, not as the folder browser.
- **Folder rename / merge / delete** (`PATCH /api/folders/:id`, `DELETE /api/folders/:id`) — roadmap "Folder Management" scope, later pass. Only *create* (auto + manual) ships now.
- **Collections CRUD beyond listing** — no `POST /api/collections` (user-created collections), no `DELETE /api/collections/:id`, no `is_public` flag handling (guest-sharing scope, Week 9–10). This pass only auto-creates one default collection per user and lists it.
- **Secondary tags as a data model** — roadmap § 13 says "Multi-label: photo gets primary folder + secondary tags." This pass: primary folder is real (`folder_id`); "secondary tags" remain the raw `ai_labels` array already stored on the photo, no separate tags table. Flagged in Open Questions #3.
- **Automatic backfill / bulk reclassification** of photos uploaded before this feature (the Week 3–4 test photos with labels but null `folder_id`). Per-photo `POST /api/photos/:id/reclassify` covers them manually; a bulk job is not worth building against dev data.
- **Duplicate-detection warning before upload** (client-side pre-check) — Week 7–8 roadmap bullet, not this pass. The SHA-256 hash added here stays a worker-side dedup improvement only.
- **Owner notification on classification failure** (roadmap § 13 step 7 "alert owner") — no notification system exists yet; `failed` status remains surfaced via the status endpoint only.
- **Dead-letter queue tooling** — BullMQ already keeps failed jobs (`removeOnFail: false`); no analysis UI/tooling this pass.
- **Next.js security-advisory upgrade** — still deferred to a dedicated dependency pass, per STATUS.md notes; not bundled here.

## Scope for this sprint

### 1. Schema (`backend/prisma/schema.prisma` + `prisma migrate dev`)

New models, matching roadmap § 6 (snake_case DB / camelCase Prisma convention as established):

```prisma
model Collection {
  id          String   @id @default(uuid())
  ownerId     String   @map("owner_id")
  name        String
  description String?
  isDefault   Boolean  @default(false) @map("is_default")
  createdAt   DateTime @default(now()) @map("created_at")

  owner   User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  folders Folder[]
  photos  Photo[]

  @@unique([ownerId, name]) // race-safe find-or-create of the default collection; see Open Questions #1
  @@index([ownerId])
  @@map("collections")
}

model Folder {
  id           String   @id @default(uuid())
  collectionId String   @map("collection_id")
  name         String   // 'People', 'Nature', ..., 'Uncategorized', or custom
  categoryType String   @default("ai_generated") @map("category_type") // ai_generated | custom
  photoCount   Int      @default(0) @map("photo_count")
  createdAt    DateTime @default(now()) @map("created_at")

  collection Collection @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  photos     Photo[]

  @@unique([collectionId, name]) // race-safe find-or-create under worker concurrency 2
  @@index([collectionId])
  @@map("folders")
}
```

Required changes to **existing** models (Prisma refuses to validate one-sided relations — these back-relations are not optional):

```prisma
model User {
  // ...all existing fields and relations unchanged...
  collections Collection[] // NEW back-relation (Collection.owner requires it)
}

model Photo {
  // ...all existing fields unchanged; collectionId/folderId columns already exist...
  collection Collection? @relation(fields: [collectionId], references: [id])
  folder     Folder?     @relation(fields: [folderId], references: [id])

  fileSha256  String? @map("file_sha256")  // NEW — carry-over hardening b
  dedupMethod String? @map("dedup_method") // NEW — 'sha256' | 'phash', set only when flagged duplicate (observability)

  @@index([ownerId, fileSha256])
}
```

`fileSha256`/`dedupMethod` are nullable — pre-existing photos keep null and simply never match the exact-hash fast path; no backfill. The `collection_id`/`folder_id` columns already exist as nullable TEXT with all-null values (upload-pipeline migration); this migration only adds the FKs, the two new columns, and the new tables.

Roadmap's `collections.is_public` is deliberately omitted until Week 9–10 guest scope (see Non-goals). Migration created via `prisma migrate dev` (never `db push`), extending the existing history in `backend/prisma/migrations/`.

### 2. Category mapping module (`backend/src/lib/classification/categoryMapping.ts` — new file)

Pure, dependency-free module. Deliberately a sibling of, not part of, the provider in `classification/index.ts` — the Vision swap-in must not touch this file.

- `export const CONFIDENCE_THRESHOLD = 0.6;`
- `export const UNCATEGORIZED = "Uncategorized";`
- `export const CATEGORY_PRIORITY = ["People", "Nature", "Animals", "Food", "Vehicles", "Documents", "Screenshots"] as const;` — priority = the order roadmap § 13 step 5 lists the rules.
- `export const LABEL_TO_CATEGORY: Record<string, string>` — the roadmap table verbatim, plus three aliases so the existing mock's fixture labels exercise it: `Landscape → Nature`, `Nature → Nature`, `Outdoor → Nature` (flagged, Open Questions #2). Matching is case-insensitive (normalize label before lookup).
- `export function mapToCategory(result: ClassificationResult): string` — returns `UNCATEGORIZED` when `result.confidence < CONFIDENCE_THRESHOLD` (strictly less than — exactly 0.60 is categorized) or when no label maps to any category; otherwise, of all categories matched by any label, returns the highest-priority one per `CATEGORY_PRIORITY` (multi-label → primary folder; the rest stay as raw labels per Non-goals).

### 3. Mock fixture update (`backend/src/lib/classification/index.ts` — fixture list only, interface unchanged) + committed test fixtures

The `classify()` contract, provider structure, deterministic bytes→labels derivation, and call-counter stay exactly as-is. Only `MOCK_LABEL_SETS` is extended so the mapping table is actually exercisable end-to-end. The list must include at least: a People set (e.g. `["Person", "Outdoor"]` — also exercises multi-category priority, People > Nature), a Food set, a Documents set, an Animals set (e.g. `["Dog", "Animal"]`), a Vehicles or Screenshots set, and one set with no mappable labels (e.g. `["Abstract", "Pattern"]` → Uncategorized). Confidence derivation stays deterministic in the 0.75–0.94 range — the <0.60 path is exercised via the worker hook below, not by making the mock nondeterministic.

**Fixture files (required, for Tester determinism):** because the mock is deterministic per byte content, Developer must commit one image fixture per `MOCK_LABEL_SET` to `backend/test/fixtures/` (e.g. `fixture-people.jpg`, `fixture-food.jpg`, ..., `fixture-unmappable.jpg`), each verified to hash to its named label set, plus a short `backend/test/fixtures/README.md` mapping filename → label set → expected folder. Without this, hitting a *specific* set (e.g. the unmappable one) is trial-and-error uploading that burns distinct images and upload-rate-limit budget. Acceptance criteria below reference these fixtures by role.

### 4. Worker changes (`backend/src/worker.ts`)

- **New step 5 (folder assignment), after the existing step 4 classify() call, for non-duplicates:**
  1. `FORCE_LOWCONF_` filename hook (mirrors the existing `FORCE_FAIL_` hook): if `originalFilename` starts with `FORCE_LOWCONF_`, override the mock's returned confidence to `0.42` before mapping — deterministic, test-only way to exercise the <60% → Uncategorized bucket, since the mock's real range never dips below 0.60. Labels are kept as returned.
  2. `mapToCategory(result)` → category name.
  3. Find-or-create the owner's default collection (`name: "My Photos"`, `isDefault: true`) — race-safe via the `@@unique([ownerId, name])` constraint (upsert or catch-unique-violation-and-refetch; a plain find-then-create is not acceptable at concurrency 2).
  4. Find-or-create the folder (`collectionId`, `name = category`, `categoryType: "ai_generated"`) — race-safe via `@@unique([collectionId, name])`, same pattern.
  5. Single transaction: update photo (`aiLabels`, `aiConfidence`, `folderId`, `collectionId`, `aiClassificationStatus: "done"`), increment the target folder's `photoCount` (and decrement the previous folder's `photoCount` if a reclassify job is moving it — never below 0).
- **New job type `"reclassify"`** (worker branches on BullMQ job name): fetches the original buffer, runs classify() → hook → mapping → folder assignment only. Skips thumbnails, EXIF, and the pHash dedup gate entirely (they already ran on first ingest and are unchanged by reclassification). If the photo was `duplicate`, reclassify clears `duplicateOfPhotoId` (and `dedupMethod`) and proceeds — the user is explicitly overriding the dedup verdict (Open Questions #4).
- **Hook scoping, explicit:** the `FORCE_FAIL_` hook applies **only** to the initial `"pipeline"` job type, deliberately, so Tester can exercise the full `failed → reclassify → done` recovery path with the same file. The `FORCE_LOWCONF_` hook applies to **both** job types (`"pipeline"` and `"reclassify"`) — reclassifying a `FORCE_LOWCONF_`-named photo deterministically lands it back in Uncategorized, which gives Tester an assertable reclassify outcome; unlike `FORCE_FAIL_`, there is no recovery-path reason to scope it to pipeline only.
- **Duplicates still get no folder**: the dedup gate still short-circuits before classification; `folderId` stays null on `duplicate` photos until/unless reclassified.
- **`processing_jobs` bookkeeping must be re-keyed by job id (required change, NOT free).** Today the worker's processor and its `completed`/`failed` handlers all update via `prisma.processingJob.updateMany({ where: { photoId } })`. That was harmless with exactly one job row per photo; once reclassify adds a second row, every worker event clobbers BOTH rows — a reclassify going `active` would reset the long-completed `pipeline` row to `active` with the reclassify job's attempt count, and a failed reclassify would mark the original `pipeline` row `failed`. Fix: the upload handler already enqueues with `{ jobId: job.id }` where `job.id` is the `ProcessingJob` row's primary key (`backend/src/routes/photos.ts`), so BullMQ's `job.id` *is* the row's PK. The processor and both event handlers must switch to `prisma.processingJob.update({ where: { id: job.id } })`, and the reclassify enqueue (section 7) must use the same `{ jobId: processingJobRow.id }` pattern. The retry/backoff policy itself (`queue.ts` `defaultJobOptions`) carries over unchanged — only the bookkeeping keying changes.

### 5. Dedup hardening in the worker (carry-over b — `backend/src/worker.ts` step 3 + `backend/src/routes/photos.ts` upload handler + `backend/src/lib/phash.ts`)

- Upload handler computes `crypto.createHash("sha256")` of `file.buffer` (already in memory; cheap) and stores it in `photos.file_sha256` at row creation.
- Worker dedup step becomes two-phase:
  1. **Exact pass:** query same-owner photos with identical `fileSha256` (`id != this photo`) — match → `duplicate` with `dedupMethod: "sha256"`, done. Catches byte-identical re-uploads (the overwhelmingly common real case) with zero false-positive risk.
  2. **Near-dup pass (pHash), with degenerate guard:** unchanged Hamming-distance-<10 check, except comparisons are **skipped whenever either hash equals the degenerate all-zeros dHash** (`"0000000000000000"` — what every flat/solid-color image produces, per Tester's 2026-07-02 methodology finding). Export the constant from `phash.ts` (e.g. `DEGENERATE_PHASH`). A pHash match sets `dedupMethod: "phash"`. Net effect: flat images only ever dedup via exact byte match, never via pHash collision.
- Dedup remains per-user-scoped and remains a hard gate before classification. Flagged as Open Questions #7 for veto.

### 6. Routes — new (`backend/src/routes/collections.ts` + `backend/src/routes/folders.ts`, mounted at `/api/collections` and `/api/folders` in `app.ts`; all `requireAuth` + `asyncHandler`, Zod on every body/query)

- `GET /api/collections` → 200 `{ collections: [{ id, name, isDefault, createdAt }] }` for the requesting user only. Empty array (not an error) before first classification creates the default.
- `GET /api/collections/:id/folders` → ownership check (collection.ownerId, else 404) → 200 `{ folders: [{ id, name, categoryType, photoCount, createdAt }] }`, sorted by name asc.
- `POST /api/collections/:id/folders` → ownership check (404, never 403 — never confirm a foreign collection exists) → Zod body `{ name: string, 1–255 chars, trimmed }` (400 on violation) → creates folder with `categoryType: "custom"` → 201 with the folder object. Duplicate name within the collection → 409 (unique constraint). Exists so the reclassification UI has move targets beyond whatever the AI happened to create.
- `GET /api/folders/:id/photos` → ownership check via `folder.collection.ownerId` (404) → Zod-validated query `limit` (default 50, max 100) / `offset` (default 0, min 0); non-numeric, negative, or over-max values → 400 → 200 `{ photos: [{ id, originalFilename, status, aiLabels, aiConfidence, thumbnailUrl }], total, limit, offset }`, newest first. `thumbnailUrl` is a pre-signed 60s-TTL URL for the 150px thumbnail (existing `thumbnailKey` convention), `null` if not yet generated. Never a raw storage key.

### 7. Routes — changes to `backend/src/routes/photos.ts`

- **`PATCH /api/photos/:id`** (new — manual move): Zod body `{ folderId: string (uuid) }` (400 on violation). Ownership check on the photo (404) AND on the target folder via its collection (404 — never confirm a foreign folder exists). Transaction: set `photo.folderId` (+ `collectionId` to the folder's collection), decrement old folder's `photoCount` if there was one, increment new folder's. Does NOT touch `aiClassificationStatus`, `aiLabels`, or `aiConfidence` — a manual move is an organizational act, not a re-classification. → 200 `{ id, folderId, folderName }`.
- **`POST /api/photos/:id/reclassify`** (new — re-enqueue path): ownership check (404). 409 `{ error: "Classification already in progress" }` if status is `pending` or `processing`. Otherwise (for `done`, `failed`, `duplicate`): create a `ProcessingJob` row (`jobType: "reclassify"`, `status: "queued"`), enqueue a BullMQ job named `"reclassify"` with `{ photoId }` **and `{ jobId: processingJobRow.id }`** (same PK-as-BullMQ-id pattern the upload handler uses — required by section 4's bookkeeping re-key), set `aiClassificationStatus: "pending"` → 202 `{ photoId, jobId, status: "pending" }`. Rate-limited by a new `reclassifyRateLimiter` (`backend/src/middleware/reclassifyRateLimiter.ts`, 30/15min, keyed by user id) — its own bucket, not shared with upload's or auth's, per the established one-bucket-per-endpoint-group lesson. (This endpoint will hit the real Vision API's wallet post-swap, so it must be limited from day one.)
- **`GET /api/photos/:id`** (additive changes only, existing fields untouched): add `exif: { takenAt, gpsLat, gpsLng, cameraMake, cameraModel }` (nulls where absent — carry-over c, makes EXIF extraction Tester-verifiable without DB access at last), `folder: { id, name } | null`, and `collectionId` (so folder/collection assignment is directly observable, not inferred).
- **`GET /api/photos/:id/status`** (additive): add `folder: { id, name } | null` and `collectionId` alongside the existing `folderId`; add `dedupMethod` (`"sha256" | "phash" | null`, returned alongside `duplicateOfPhotoId` when status is `duplicate`) so Tester can prove *which* dedup pass fired; and add `job: { type, status, attempts, errorMessage } | null` — the photo's most recent `processing_jobs` row (by `createdAt`). This closes the exact observability gap the 2026-07-02 report documented ("exact attempts=3 and error_message population not independently confirmed without DB access") for both job types.

### 8. Carry-over hardening a — auth rate-limit split (`backend/src/routes/auth.ts`)

The shared `authRateLimiter` (5/15min/IP across signup AND login) has caused mid-suite 429 friction in two consecutive Tester runs and a documented smoke-test flake (STATUS.md Notes). Replace it with:
- `signupRateLimiter`: 5 / 15 min / IP on `POST /api/auth/signup` only.
- `loginRateLimiter`: 10 / 15 min / IP on `POST /api/auth/login` only (login legitimately gets retried more; still tight enough for brute-force protection per roadmap § 12 Layer 7).
- Both: `limit` raised to 1000 when `NODE_ENV === "test"` (limiter code path preserved, effectively disarmed) — fixes the documented `npm test` back-to-back 429 flake without deleting the production behavior.
- Note for live Tester runs: the dev server runs with `NODE_ENV=development`, so the *live* signup budget stays 5/15min. Live regression suites must be designed to need ≤5 signups per 15-minute window (reuse accounts across checks). If that proves too tight in practice, a dev-env bump is a veto option under Open Questions #6 — not specced by default.
- No other change to `auth.ts` — handlers, Zod schemas, session logic untouched. Flagged as Open Questions #6 for Abhishek's veto (it changes shipped, tested behavior).

### 9. Frontend

**None in the immediately-buildable portion.** The existing bare-bones `/upload` page keeps working unchanged (all status-endpoint changes are additive). All frontend work for this spec lives in the blocked section below.

**Deferred to later passes:** everything under Non-goals.

## Manual reclassification UI — BLOCKED on wireframe decision

This is new UI with genuine layout ambiguity, so per CLAUDE.md's protocol it is **not buildable until Abhishek picks a wireframe**. Developer must, at the *start* of the build (not after the backend is done, so the pick can land within the same cycle):

1. Present 2–3 approaches in chat with pros/cons and SVG wireframes (e.g. a folder-sidebar + thumbnail-grid page with a move dropdown per photo; a single-list view with inline folder select; a modal-based move flow on top of a minimal grid).
2. Post the choice as a pending decision in `agents/STATUS.md`.
3. **WAIT for Abhishek's pick.** Build the backend sections above in the meantime — they are complete and independently testable via API.
4. Save the chosen SVG to `design/wireframes/` as the design record.

Functional requirements the chosen design must satisfy (whatever the layout):
- List the user's folders (default collection) with photo counts; select a folder to see its photos as thumbnails (150px pre-signed URLs via `GET /api/folders/:id/photos`).
- Move a single photo to another existing folder (`PATCH /api/photos/:id`), with the counts visibly updating.
- Create a new custom folder inline (`POST /api/collections/:id/folders`) so a move target always exists.
- Trigger "Reclassify" on a photo (`POST /api/photos/:id/reclassify`) and see it re-resolve (poll `GET /api/photos/:id/status` as the upload page already does), including on `failed` and `duplicate` photos.
- Scope stays at "functional, minimally styled" — this is the Week 5–6 reclassification tool, not the Week 7–8 folder browser. No drag-and-drop, no bulk select, no fullscreen viewer.

## Acceptance criteria

Verification legend: unmarked items are live-verifiable by Tester through the API/browser. Items marked **[Developer-verified / code-review-only]** require shell, DB, process, or network control the Tester demonstrably lacks (per the 2026-07-02 report's documented constraints) — Developer verifies them and states so in the commit/handoff; Tester confirms by code review only, never fabricates a live pass.

**Classification → mapping → folder auto-creation (buildable/testable immediately):**
- [ ] Upload a fixture whose mock labels map to a category (e.g. `fixture-food.jpg`): status reaches `done`, `GET /api/photos/:id` (or `/status`) shows non-null `folderId` AND non-null `collectionId`, `GET /api/collections` shows exactly one "My Photos" default collection, and `GET /api/collections/:id/folders` shows the category folder with `categoryType: "ai_generated"` and `photoCount: 1`.
- [ ] Upload a second, visually different image mapping to the same category: same folder id is reused (no duplicate folder row), `photoCount` becomes 2.
- [ ] Upload the committed unmappable fixture (`fixture-unmappable.jpg`, labels e.g. `["Abstract", "Pattern"]`): it lands in an "Uncategorized" folder (auto-created, `ai_generated`). No trial-and-error hunting — the fixture is checked in per section 3.
- [ ] Upload a copy of a *mappable* committed fixture renamed to `FORCE_LOWCONF_<anything>.jpg` (rename doesn't change bytes, so its labels still map): stored `aiConfidence` is < 0.6 and the photo lands in "Uncategorized" — proving the threshold overrides label mapping.
- [ ] **[Developer-verified / code-review-only]** Threshold boundary: confidence exactly 0.60 is categorized (strictly-less-than rule) — verified via `mapToCategory`'s unit-level behavior; Tester should not hunt for a file hashing to exactly 0.60.
- [ ] Two near-simultaneous uploads both mapping to a brand-new category (worker concurrency 2) produce exactly one folder row — the unique constraint holds, neither job crashes.
- [ ] A `duplicate`-status photo has null `folderId` (dedup gate still short-circuits before classification and folder assignment).
- [ ] Multi-category priority: an image with labels spanning two categories (the `["Person", "Outdoor"]` fixture → People + Nature) lands in the higher-priority folder (People).
- [ ] **401 on every new/changed endpoint with no session:** `GET /api/collections`, `GET /api/collections/:id/folders`, `POST /api/collections/:id/folders`, `GET /api/folders/:id/photos`, `PATCH /api/photos/:id`, `POST /api/photos/:id/reclassify` — all six.
- [ ] **404 (never 403) on every id-taking endpoint against another user's resource:** `GET /api/collections/:id/folders` and `POST /api/collections/:id/folders` on another user's collection; `GET /api/folders/:id/photos` on another user's folder; `PATCH /api/photos/:id` on another user's photo AND (separately, own photo) targeting another user's folder; `POST /api/photos/:id/reclassify` on another user's photo.
- [ ] `GET /api/folders/:id/photos` paginates (`limit`/`offset` honored, `total` correct), returns 150px pre-signed thumbnail URLs that serve real bytes and expire after 60s, and never returns a raw storage key. Invalid query values (`limit` > 100, negative or non-numeric `offset`) → 400 via Zod.
- [ ] `POST /api/collections/:id/folders` with a valid name returns 201 with `categoryType: "custom"`; a duplicate name in the same collection returns 409; an invalid body (empty/overlong name) returns 400 via Zod before touching the DB.

**Manual move + reclassify (API-level, no UI needed):**
- [ ] `PATCH /api/photos/:id` moving a photo between folders returns 200, updates `folderId`, and both folders' `photoCount` values change by exactly 1; `aiLabels`/`aiConfidence`/`aiClassificationStatus` are untouched.
- [ ] `PATCH /api/photos/:id` with a malformed body (missing/non-uuid `folderId`) returns 400.
- [ ] `POST /api/photos/:id/reclassify` on a `FORCE_FAIL_`-named photo that previously landed in `failed`: returns 202, and the photo subsequently reaches `done` with a folder assigned (the forced-failure hook must not fire on `reclassify` jobs).
- [ ] `POST /api/photos/:id/reclassify` on a `FORCE_LOWCONF_`-named photo that's in Uncategorized: returns 202 and the photo deterministically re-resolves to Uncategorized (the low-conf hook fires on both job types per section 4).
- [ ] `POST /api/photos/:id/reclassify` on a `duplicate` photo: returns 202, `duplicateOfPhotoId` (and `dedupMethod`) are cleared, and the photo re-resolves to `done` with a folder.
- [ ] `POST /api/photos/:id/reclassify` while the photo is `pending`/`processing` returns 409.
- [ ] Reclassify has its own rate-limit bucket: exhausting it does not 429 uploads or auth calls, and vice versa.
- [ ] A `processing_jobs` row with `jobType: "reclassify"` is created per reclassify request and independently reaches `completed` (or `failed` after 3 attempts with `errorMessage` populated) — **live-verifiable via the new `job` object on `GET /api/photos/:id/status`** (`job.type === "reclassify"`, `job.status`, `job.attempts`, `job.errorMessage`).
- [ ] Bookkeeping isolation (the section-4 re-key, observable): after a photo's `pipeline` job completed and a subsequent reclassify runs/fails, the status endpoint's `job` object reflects only the reclassify row's lifecycle — and re-fetching a *different* photo's status mid-reclassify shows its own job untouched. (Full both-rows assertion is DB-level; Developer additionally verifies the original `pipeline` row still reads `completed` after a reclassify fails — **[Developer-verified]** for that half.)

**Carry-over hardening:**
- [ ] Byte-identical re-upload (same user) still resolves to `duplicate` — now provably via the SHA-256 exact pass: status endpoint returns `dedupMethod: "sha256"` alongside `duplicateOfPhotoId`. Empty `aiLabels`/null `aiConfidence` on the duplicate is the live proxy for "no classifier call"; the mock's call-counter assertion itself is **[Developer-verified / code-review-only]**.
- [ ] Upload two *different* flat/solid-color images (e.g. a red and a blue rectangle — Tester's exact 2026-07-02 repro): both resolve to `done` independently, neither flagged duplicate. Re-uploading one of them byte-identically DOES flag `duplicate` (with `dedupMethod: "sha256"`).
- [ ] **[Developer-verified / code-review-only]** `photos.file_sha256` is populated on new uploads and pre-existing rows keep null without breaking dedup for new photos (no endpoint exposes `file_sha256`; the pre-existing-rows half requires DB access).
- [ ] A burst of 6+ signup attempts 429s signup but a subsequent login attempt from the same IP still succeeds (and vice versa within login's own 10/15min budget) — buckets are genuinely independent. This is the Tester's live proof of carry-over a.
- [ ] **[Developer-verified]** `npm test -w backend` run twice back-to-back passes with no 429-induced failures (the exact flake documented in STATUS.md Notes) — `NODE_ENV=test` relaxation works. (Tester cannot run shell processes; Developer runs and reports this.)
- [ ] `GET /api/photos/:id` returns the `exif` object: populated values for an image with EXIF data, all-null (not an error) for one without — Tester can finally verify EXIF without DB access.
- [ ] Schema changes landed via `prisma migrate dev` — a new migration directory exists under `backend/prisma/migrations/` (Tester: code review of the migration dir). **[Developer-verified]** `prisma migrate dev` on a fresh DB replays the full history cleanly.
- [ ] No real Google Vision API call anywhere. Tester-verifiable portion: `backend/src/lib/classification/index.ts` remains the only classifier module, no GCP SDK in `backend/package.json`, no outbound Vision hostnames anywhere in `backend/src` (code review), and classification demonstrably succeeds via the mock in every test above. **[Developer-verified]** the classification path succeeds with outside networking unavailable (Tester cannot alter the host's network state).

**Reclassification UI (blocked — do not build before the wireframe pick):**
- [ ] 2–3 SVG wireframe options presented in chat, pending decision posted to `agents/STATUS.md`, Abhishek's pick recorded, chosen SVG saved to `design/wireframes/`.
- [ ] After the pick: the built page satisfies every functional requirement in the blocked section above, end-to-end through a real browser (list folders → open folder → move photo → counts update → reclassify a failed/duplicate photo → it re-resolves).

## Success signal

Tester Agent can: upload the committed fixtures and watch each land in the *correct auto-created folder* under a single "My Photos" collection (mapped category, Uncategorized for the unmappable fixture, Uncategorized for `FORCE_LOWCONF_` files); confirm folder reuse and accurate `photoCount`s; move a photo between folders via `PATCH` and see counts reconcile; take a `FORCE_FAIL_` photo from `failed` to `done` and a false-positive `duplicate` to `done` via the reclassify endpoint, watching the job's attempts/status/error through the status endpoint's new `job` object; re-run the exact flat-image experiment from the 2026-07-02 report and get the correct (non-duplicate) result, with `dedupMethod` proving which pass fired; verify EXIF through the API for the first time; and confirm via code review plus every live classification that no real Vision API is in play. The auth-suite improvement lands in two parts: Developer proves `npm test -w backend` passes twice back-to-back under `NODE_ENV=test`, and Tester's live proof is the bucket-independence AC — live runs should be designed to fit within 5 signups per 15-minute window (reuse accounts). Separately, Abhishek picks a reclassification-UI wireframe, and only then does the page get built and browser-verified.

## Open questions

Flagged assumptions / pending decisions — a reasonable default is stated for each so Developer can proceed immediately unless Abhishek overrides. (Not written to `agents/STATUS.md` by Planner this cycle — Master reconciles.)

1. **Default collection semantics.** Roadmap folders require a collection, but no collections UI/CRUD exists yet. **Default:** one per-user default collection, `name: "My Photos"`, `isDefault: true`, created lazily by the worker at first folder assignment (not at signup — no migration/backfill of existing users needed), enforced race-safe via `@@unique([ownerId, name])`. Side effect: user-created collections can't duplicate names later — acceptable for MVP, revisit at Collections CRUD.
2. **Mapping-table aliases for mock coverage.** The roadmap's § 13 table doesn't include the existing mock's `Landscape`/`Nature`/`Outdoor` labels. **Default:** add those three as Nature aliases and extend `MOCK_LABEL_SETS` for full category coverage (fixture-only change; provider interface untouched). Veto if the mapping table must stay roadmap-verbatim.
3. **"Secondary tags" scope.** Roadmap says multi-label photos get "primary folder + secondary tags." **Default:** primary folder only is materialized; secondary tags = the raw `aiLabels` array already stored. No tags table until a feature actually reads it.
4. **Reclassify on a `duplicate` photo clears the duplicate verdict.** **Default:** yes — it's the manual escape hatch for pHash false positives and the user is explicitly overriding the gate. Veto if duplicates should stay locked until a delete/merge flow exists.
5. **Reclassify rate limiter.** **Default:** own per-user bucket, 30/15min (mirrors upload's numbers), never shared with upload's or auth's buckets. Numbers open to veto.
6. **Auth rate-limit split (carry-over a) — explicit pending decision.** This changes shipped, Tester-verified behavior. **Default:** split into `signupRateLimiter` (5/15min/IP) and `loginRateLimiter` (10/15min/IP), both effectively disarmed (limit 1000) under `NODE_ENV=test`; live dev keeps production numbers, so live Tester runs budget ≤5 signups per window. Two consecutive Tester runs have had to work around the shared bucket; the default ends that. Veto options: different numbers, keep shared, test-env-only fix, or additionally bump the dev-env signup limit (e.g. 50/15min under `NODE_ENV=development`) if the live budget proves too tight for regression runs.
7. **pHash flat-image handling (carry-over b) — explicit pending decision.** **Default:** SHA-256 exact-hash first pass (new `file_sha256` column) + skip pHash near-dup comparison when either hash is the degenerate all-zeros dHash, so flat images dedup only on exact bytes. Residual accepted risk: near-identical-but-not-byte-identical flat photos (e.g. two shots of the same blank wall) will no longer dedup — judged the right trade versus silently swallowing legitimately new photos. Veto option: accept the false-positive rate instead and skip this change.
8. **EXIF exposure (carry-over c) — low-risk default, proceed.** Add the `exif` object to `GET /api/photos/:id` (owner-only endpoint; the photo's own metadata; no privacy boundary crossed). Flagged only for completeness.
9. **Manual folder creation pulled into this pass.** The Week 5–6 bullet list doesn't name it, but the reclassification UI is unusable without move targets, and `POST /api/collections/:id/folders` is already in the roadmap's § 11 API design. **Default:** ship create-only now; rename/merge/delete stay deferred. Veto if folders should remain strictly AI-created until Week 7–8.
10. **Low-confidence test hook placement.** The mock's deterministic confidence range (0.75–0.94) can never exercise the <60% path. **Default:** a worker-level `FORCE_LOWCONF_` filename hook (override confidence to 0.42 pre-mapping) applying to both `pipeline` and `reclassify` jobs, mirroring the established `FORCE_FAIL_` pattern, instead of widening the mock's confidence range (which would make ~a third of arbitrary real test images land in Uncategorized and confuse every other test). Veto if a different hook mechanism is preferred.
11. **Job/dedup observability fields on the status endpoint.** Added post-review for Tester verifiability: `GET /api/photos/:id/status` gains `job: { type, status, attempts, errorMessage } | null` (latest `processing_jobs` row) and `dedupMethod` (`"sha256" | "phash" | null`), plus a `dedup_method` column set by the worker. Owner-only endpoint, additive, no privacy boundary crossed — same rationale as the EXIF exposure (#8). **Default: proceed.** Veto if internal job bookkeeping should stay unexposed to clients.
