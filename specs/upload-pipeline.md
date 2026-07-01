# Spec — Photo Upload Pipeline (S3/MinIO, BullMQ, Thumbnails, EXIF, pHash)

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 7 (Phase 1 — MVP, Week 3–4: Photo Upload Pipeline), § 6 (Database Schema — `photos`, `processing_jobs`), § 11 (API Design — `PHOTOS`), § 13 (AI/ML Pipeline steps 1–3, dedup gate)
**Status:** draft
**Written by:** Planner Agent, 2026-07-02

## Problem

Auth is shipped and tested clean (17/17, 0 bugs). Redis and MinIO have been running in Docker Compose since Week 1–2 but nothing has ever connected to them — no code creates a bucket, no code enqueues a job. Before any AI classification, folder auto-sort, or dashboard photo grid can exist, a user needs to be able to upload a photo and have it durably stored, thumbnailed, EXIF-tagged, and checked for duplicates — all without blocking the HTTP request, and all served back out only through permission-checked, time-limited URLs, never a raw storage path.

This is also the first spec where the pre-signed-URL access pattern (CLAUDE.md ground rule, roadmap §12 Layer 4) actually gets implemented — auth never needed it. It is also the first spec that introduces a background worker process and a queue, which changes how the app is run locally (two Node processes instead of one).

## Goals

- `POST /api/photos/upload` — authenticated, multipart file upload (reusing `requireAuth` as-is, no changes to the auth middleware).
- Original file written to MinIO (S3-compatible) under a private bucket — never a public ACL, never a browser-visible direct URL.
- A `photos` row created synchronously in the request (status `pending`), with the actual processing (thumbnails, EXIF, pHash, mock classification) done asynchronously via BullMQ — the HTTP response returns as soon as the original is durably stored and the job is enqueued, per the roadmap's "async-first" rule and CLAUDE.md's "never inline" rule.
- A separate long-running worker process (`backend/src/worker.ts` or similar, run via its own `npm run worker` script) consumes the queue — this is new; today there is only the API process.
- Worker pipeline, in this exact order, matching roadmap §13:
  1. Generate thumbnails at 150px, 400px, 1200px (Sharp) → upload to MinIO.
  2. Extract EXIF (date taken, GPS lat/lng, camera make/model) via `exifr`.
  3. Compute pHash; query existing photos for the same user with Hamming distance below a threshold. **If a duplicate is found, stop the pipeline here** — mark the photo `duplicate`, skip classification entirely (dedup is a gate, not a parallel branch, per CLAUDE.md).
  4. If not a duplicate: call the mocked classification interface (see below), store returned labels/confidence/folder mapping, mark `done`.
- Mocked Vision API sits behind a swappable interface (`backend/src/lib/classification/index.ts` exporting a `classify(imagePath): Promise<ClassificationResult>` contract) so a real Google Vision client can be dropped in later without touching the worker or routes. The mock returns a label set deterministically derived from the file (see Open Questions #3 for exact behavior).
- `GET /api/photos/:id` — permission check (photo belongs to the requesting user; this pass has no guest/sharing model yet, so "permission check" = ownership check) → generates a MinIO pre-signed GET URL with a 60-second TTL → returns it (not a redirect, to keep the JSON contract simple for the frontend fetch/img-tag pattern — see Open Questions #4) for both the original and the requested thumbnail size.
- `GET /api/photos/:id/status` — lightweight polling endpoint returning `ai_classification_status` (`pending|processing|done|duplicate|failed`) plus folder/labels once done, per roadmap's "Upload progress tracking via polling endpoint."
- `processing_jobs` row per photo tracking `job_type`, `status`, `attempts`, `error_message`, timestamps — matches roadmap §6 schema, gives visibility into what the worker did without grepping logs.
- Retry with backoff on job failure (BullMQ's built-in exponential backoff), capped at 3 attempts, then `failed` status + `error_message` populated — no silent drops.
- Storage quota check: reject upload with 413 if `user.storageUsedBytes + file.size > user.storageLimitBytes`, and increment `storageUsedBytes` on successful original-file write (decrement on delete, out of scope this pass since no delete endpoint yet — see Non-goals).

## Non-goals (explicitly out of scope for this pass)

- Real Google Vision API integration — stays mocked behind the swappable interface until Abhishek supplies real credentials (CLAUDE.md ground rule). Week 5–6 roadmap scope, not this spec.
- Category-to-folder auto-creation and the full priority-mapping table (roadmap §13 step 5) — this spec's mock classifier returns labels and a suggested category string, but actually creating `folders` rows and assigning `folder_id` is Week 5–6 scope. This pass stores `ai_labels` and `ai_confidence` on the `photos` row and leaves `folder_id` null.
- `DELETE /api/photos/:id` — not in this spec's endpoint list; no delete/storage-decrement flow yet.
- Bulk/batch upload UI, drag-and-drop, upload progress bar UI — this spec is API + worker only. A minimal frontend upload form is included only far enough to prove the round-trip (see Scope) but the polished dashboard upload experience is Week 7–8 scope.
- Duplicate photo *notification* to the owner (roadmap §13 step 3 says "notify owner") — no notification system exists yet (no email/push wired in per CLAUDE.md). This pass marks the photo `duplicate` in the DB and surfaces it via the status endpoint; actually alerting the user is deferred.
- Collections/folders CRUD endpoints — `collection_id` on `photos` is nullable and unused this pass (every uploaded photo belongs directly to the user with no collection yet); Collections is implied by roadmap §6 but not asked for by Week 3–4's checklist.
- Video support — roadmap explicitly lists this as Phase 2 (§ "Video Support" under future scope). Images only this pass.
- CDN delivery of thumbnails — roadmap §12 mentions CloudFront/Cloudflare for thumbnails; local MVP serves everything through the same pre-signed-URL flow as originals for now, no separate CDN-fronted path.
- Client-side image compression/preview before upload (Sharp via API, per roadmap's frontend tools table) — server receives the original as-is; client-side preview is a UI nicety, not a pipeline requirement.

## Scope for this sprint

**Backend — schema:**
- Add `Photo` and `ProcessingJob` models to `backend/prisma/schema.prisma` matching roadmap §6 columns (image-relevant subset only — `collection_id`/`folder_id` present but nullable/unused this pass per Non-goals). Follow the existing `snake_case` DB / `camelCase` Prisma convention already established in `schema.prisma`.
- New migration via `prisma migrate dev` (not `db push` — this is a good point to start real migration history, addressing the process gap Tester flagged after the auth run, without making it a separate ticket).

**Backend — storage:**
- `backend/src/lib/storage.ts` — thin wrapper around the AWS S3 SDK v3 pointed at MinIO's endpoint (`MINIO_ENDPOINT`/`MINIO_PORT` already in `.env.example`), exposing `putObject`, `getPresignedGetUrl(key, expiresInSeconds)`, and a `ensureBucketExists()` bootstrap call run once at API/worker startup. Bucket stays private (no public-read policy set, ever).

**Backend — queue:**
- `backend/src/lib/queue.ts` — BullMQ `Queue` instance (`photo-processing`) backed by `REDIS_URL` (already in `.env.example`, unused until now).
- `backend/src/worker.ts` — new entrypoint, BullMQ `Worker` consuming `photo-processing`, running the 4-step pipeline in-order per Goals. Started via a new `npm run worker -w backend` script (`tsx watch src/worker.ts`), separate process from `npm run dev -w backend` (the API server). Both must run simultaneously for uploads to complete processing — documented in this spec's Success Signal and to be called out in README/STATUS notes by Developer.

**Backend — classification mock:**
- `backend/src/lib/classification/index.ts` — exports `classify()` per Goals. Mock implementation detailed in Open Questions #3.

**Backend — routes (`backend/src/routes/photos.ts`, mounted at `/api/photos`, `requireAuth` on all three):**
- `POST /api/photos/upload` — Multer memory storage (matches roadmap's Multer requirement), single file field, 50MB limit (roadmap-specified), Zod-validated MIME allowlist (see Open Questions #1). Flow: validate → quota check (413 if over) → pHash is NOT computed here (that's a worker step, since it requires reading the buffer after Sharp normalizes orientation — keeping the request handler thin and fast) → write original to MinIO → create `photos` row (`ai_classification_status = "pending"`) → create `processing_jobs` row (`job_type = "pipeline"`, `status = "queued"`) → enqueue BullMQ job with `{ photoId }` → respond 202 with `{ photoId, jobId, status: "pending" }`. (202, not 201, since the resource is accepted but not yet fully processed — thumbnails/EXIF/classification are still pending.)
- `GET /api/photos/:id` — ownership check (`photo.ownerId === req.user.id`, else 404 not 403, to avoid confirming existence to non-owners) → returns pre-signed URLs (60s TTL) for the original and each generated thumbnail size that already exists; sizes not yet generated are omitted from the response rather than erroring, since the worker may not have finished yet.
- `GET /api/photos/:id/status` — ownership check → returns `{ status, aiLabels, aiConfidence, folderId, duplicateOfPhotoId }` (last field populated only when `status === "duplicate"`).

**Backend — rate limiting decision (see also Open Questions #5):**
- Upload endpoint gets its **own** rate limiter, separate from `authRateLimiter` — not shared. This directly addresses the tradeoff Tester flagged after the auth run (shared bucket causing cross-contamination between unrelated endpoint groups) rather than repeating it. Limiter: 30 uploads / 15 min / user (keyed by session user id, not IP, since authenticated uploads should be limited per-account, not per-network — multiple household/office users sharing an IP shouldn't throttle each other).

**Frontend — minimal proof of round-trip only:**
- A bare-bones authenticated page or existing `/dashboard` addition with a single `<input type="file">` + submit button that calls `POST /api/photos/upload`, then polls `GET /api/photos/:id/status` every 2s until `done`/`duplicate`/`failed`, then displays the returned thumbnail via the pre-signed URL from `GET /api/photos/:id`. No styling pass, no drag-and-drop, no design-system work — exists purely so Tester can verify the full pipeline end-to-end through the UI, not just via curl/Postman. If Developer judges this needs actual layout decisions beyond "a file input and a result box," escalate per CLAUDE.md's SVG-wireframe process instead of guessing — expectation going in is that it does not, since Week 7–8 owns the real upload UI.

**Deferred to later passes:** everything under Non-goals above.

## Acceptance criteria

- [ ] `POST /api/photos/upload` with no session cookie returns 401 (reuses `requireAuth`, no bypass).
- [ ] `POST /api/photos/upload` with a valid JPEG/PNG under 50MB returns 202 with `photoId` and `jobId`; a `photos` row exists in Postgres with `ai_classification_status = 'pending'`, `s3_key` pointing at the MinIO object, and the original file is retrievable directly from MinIO by that key (verified via MinIO client/console, not just DB state).
- [ ] `POST /api/photos/upload` with a file over 50MB returns 413 before any MinIO write.
- [ ] `POST /api/photos/upload` with a disallowed MIME type (e.g. `.exe` renamed to `.jpg`, checked by content-sniffing not just extension) returns 400 before any MinIO write.
- [ ] `POST /api/photos/upload` when the user's `storageUsedBytes + file.size` would exceed `storageLimitBytes` returns 413 with a clear "storage quota exceeded" message, and no `photos` row or MinIO object is created.
- [ ] The HTTP response for a successful upload returns in well under 1 second regardless of file size (up to 50MB) — proving thumbnailing/EXIF/pHash/classification are genuinely async and not awaited inline. (Tester should time this explicitly, not just check for a 202.)
- [ ] Within a few seconds of upload (worker running), `GET /api/photos/:id/status` transitions `pending` → `done` (or `duplicate`/`failed`), and three thumbnail objects (150/400/1200px) exist in MinIO once `done`.
- [ ] EXIF fields (`exif_taken_at`, `exif_gps_lat/lng`, `exif_camera_make/model`) are populated in the `photos` row for a test image that has EXIF data, and are `null` (not an error/crash) for an image with no EXIF data.
- [ ] Uploading the same image twice (same user) results in the second upload's status resolving to `duplicate`, with **no** call made to the mock classifier for the second upload (verifiable via a call counter/spy on the mock in the worker's own logs, or by Developer instrumenting the mock module — Tester should confirm the pipeline actually short-circuits, not just that the field says "duplicate").
- [ ] A failing worker job (Developer should provide a way to force this for testing — e.g. a corrupt file, or a test-only forced-failure flag) retries up to 3 times with backoff, then lands in `failed` status with `error_message` populated and `processing_jobs.attempts = 3`.
- [ ] `GET /api/photos/:id` for a photo owned by a different user returns 404 (not 403, not the photo).
- [ ] `GET /api/photos/:id` returns pre-signed URLs that work when fetched directly (200, correct image bytes) and stop working after 60 seconds (fetch the same URL again after the TTL and confirm MinIO/S3 rejects it) — proving the TTL is real, not decorative.
- [ ] No raw/direct MinIO URL is ever returned by any endpoint — only pre-signed URLs with an expiry.
- [ ] Killing the worker process (but leaving the API up) still allows uploads to be accepted (202) and queued; restarting the worker afterward drains the backlog and completes processing — proving durability of the queue, not just of a single always-on worker.
- [ ] `npm run dev -w backend` (API) and `npm run worker -w backend` (worker) are independently startable/killable without crashing the other.
- [ ] Upload endpoint's rate limit is confirmed independent from `authRateLimiter` — hitting the upload limiter does not 429 an unrelated login/signup call and vice versa.
- [ ] No real AWS/GCP credentials, no real Google Vision API call (confirm via network inspection or by disconnecting network during a test upload and confirming classification still "succeeds" via the mock), appear anywhere in this pipeline.

## Success signal

Tester Agent can: start both `npm run dev -w backend` and the new `npm run worker -w backend` alongside the frontend, upload a real JPEG through the minimal upload UI (or directly via API), watch status go `pending` → `done` within a few seconds, fetch the resulting thumbnail via a pre-signed URL and see the correct image render, confirm the pre-signed URL expires after 60s, upload the exact same file again and see it resolve to `duplicate` without a second classification call, and confirm the `photos`/`processing_jobs` rows in Postgres plus the objects in the MinIO console match what the API reports. Tester also confirms the API stays responsive (sub-second) even while the worker is deliberately stopped, proving the queue — not a synchronous call — is what's actually decoupling upload from processing.

## Open questions

Posted to `agents/STATUS.md` under Pending Decisions — reasonable MVP-appropriate defaults assumed below so Developer isn't blocked, flagged rather than silently baked in:

1. **Allowed file types and exact size ceiling.** Roadmap only says "max 50MB per file," doesn't list a MIME allowlist. **Assumption:** JPEG, PNG, WebP, HEIC only (the realistic camera-roll/photo set implied by "photo organization platform" — no PDFs, no arbitrary files), content-sniffed via magic bytes (not trusted from the `Content-Type` header or file extension alone), 50MB hard ceiling per roadmap. Confirm if additional formats (e.g. RAW/TIFF for the "photographer" persona in the roadmap's Definition of Done) are actually expected in Phase 1 rather than Phase 2.
2. **Thumbnail storage layout / dedup of the "3 sizes" requirement.** Roadmap says "generate 3 sizes: 150px, 400px, 1200px" but roadmap's `photos` schema only has one `s3_thumbnail_key` column, not three. **Assumption:** store all three as separate MinIO objects under a predictable key pattern (`{userId}/{photoId}/thumb_150.jpg`, `_400`, `_1200`) and keep `s3_thumbnail_key` pointing at the 400px "default" size for any code that only needs one thumbnail reference (e.g. a future grid view), with the other two sizes derivable by convention rather than needing three separate DB columns. Flag if Abhishek wants all three sizes to be independently addressable columns instead of convention-based key derivation.
3. **What the mocked classification "categories" actually return.** Roadmap §13 step 5 lists real Vision-label-to-category mappings (Person→People, Tree→Nature, etc.) but that's Week 5–6 scope per Non-goals — this spec only needs the mock's *shape* to exist so the worker pipeline has something to call and store. **Assumption:** the mock deterministically hashes the uploaded file's bytes to pick one label set from a small fixed list (e.g. `["Person","Outdoor"]`, `["Food","Meal"]`, `["Document","Text"]`, `["Uncategorized"]`) with a fixed mock confidence score, so the same image always "classifies" the same way across runs (useful for Tester's duplicate/non-duplicate assertions) without needing real image content analysis. No actual category-to-folder mapping or folder creation happens this pass (per Non-goals) — the mock just needs to prove the swappable-interface contract and populate `ai_labels`/`ai_confidence` on the row. Confirm this minimal mock is acceptable, or if Abhishek wants the mock to already implement the real label-to-category table now so Week 5–6 is just a credential swap.
4. **Pre-signed URL delivery: JSON body vs. 302 redirect.** Roadmap §12's flow diagram explicitly says "Returns 302 redirect to pre-signed URL," but that pattern doesn't work cleanly for a JSON API driving a React frontend that needs the URL string to put into an `<img src>` (a redirect works for a direct `<img src="/api/photos/:id">` but not if the frontend wants metadata alongside it). **Assumption:** `GET /api/photos/:id` returns JSON containing the pre-signed URL(s) as strings, not a 302 — matching how most modern SPA-driven photo apps actually do it, and easier for Tester to assert against directly. Flag if Abhishek specifically wants the literal 302-redirect behavior (e.g. to allow a bare `<img src>` tag with no JS fetch step) preserved as written in the roadmap.
5. **Rate limit scope for upload endpoints, given the already-flagged shared-bucket issue from auth.** Tester's last report explicitly flagged that Week 3-4 upload endpoints "might want their own independent limiter design" rather than repeating auth's shared-IP-bucket tradeoff. **Decision made in this spec (not left open):** upload gets its own limiter, keyed by user id, not shared with `authRateLimiter`. Flagging here only so Abhishek can veto the specific numbers (30/15min/user) or the per-user-vs-per-IP keying choice if there's a reason to prefer one over the other before Developer builds it.
6. **Storage quota enforcement scope.** `users.storageLimitBytes` exists in the schema (5GB default) but nothing has ever read or written `storageUsedBytes` until now. **Assumption:** this spec enforces the quota on upload (413 if exceeded) and increments `storageUsedBytes` on successful write, but does *not* implement decrementing on delete (no delete endpoint exists yet) or a dashboard "storage used" display (Week 7–8 UI scope) — just the backend accounting needed so quota enforcement is real starting now rather than bolted on later. Confirm this partial scope (enforce + increment, no decrement yet) is acceptable, or if Abhishek wants delete/decrement pulled into this same ticket since they're closely related.
7. **Duplicate-detection scope: per-user or global.** Roadmap §13 step 3 says "Query DB for existing photos with hamming distance < 10" without specifying scope. **Assumption:** duplicate check is scoped to the uploading user's own photos only (`WHERE owner_id = :userId`), not a global cross-user check — matches the privacy-first principle (CLAUDE.md/roadmap) of not letting one user's upload behavior reveal anything about another user's library, and matches the practical use case (a user re-uploading their own photo, not deduping across unrelated accounts). Flag if global dedup was actually intended (unlikely, but the roadmap prose doesn't explicitly scope it).
