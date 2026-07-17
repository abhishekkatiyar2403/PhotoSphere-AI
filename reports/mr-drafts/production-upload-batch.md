# MR Draft — Presigned Multipart Batch Upload

**Branch:** `feature/ai-classification` (commit `e86f126`)
**Spec:** `specs/production-upload-batch.md` (READY → BUILT this pass)
**Base:** on top of `0f9a732` (real AWS integrations / audit fixes)

## Title
feat: presigned multipart batch upload (500-1000 photos/batch)

## Summary

Adds a new batch upload path alongside the existing, already-shipped,
already-tested single-file `POST /api/photos/upload` (`backend/src/routes/photos.ts`),
which is **completely untouched** — no line of it was modified, and its own
test file (`upload.smoke.test.ts`) passes unmodified.

The new path: the browser calls `POST /api/upload/initiate` once for an
entire selected batch (any file count, even 1), which does a whole-batch
quota check, a whole-batch `fileSha256` duplicate pre-check (excluding
trashed photos), and issues presigned multipart part-upload URLs for every
non-duplicate file. The browser then `PUT`s every part **directly to
MinIO/S3** — zero file bytes ever pass through the Node process. Once a
file's parts are all uploaded, the browser reports it (in chunks, per spec:
every 50 files or 30 seconds) to `POST /api/upload/complete`, which calls
`completeMultipartUpload`, content-sniffs the assembled object (the earliest
point the backend can see real bytes), and only then creates a `Photo` row —
the exact same shape/fields the single-file route already produces — and
enqueues the exact same `photoProcessingQueue.add("pipeline", {photoId})`
call. `DELETE /api/upload/abort` cancels a session's outstanding multipart
uploads. A new daily BullMQ repeatable job (mirroring `registerTrashPurgeJob`)
reconciles any `UploadSession` left `in_progress` past its `expiresAt`.

## Files touched

**New:**
- `specs/production-upload-batch.md` (spec, unchanged from Planner)
- `backend/prisma/migrations/20260713162659_add_upload_batch_sessions/`
- `backend/prisma/migrations/20260713162951_upload_session_file_original_filename/`
- `backend/src/routes/upload.ts` — the three new endpoints
- `backend/src/middleware/initiateUploadRateLimiter.ts` — shared 10/15min/user bucket across initiate/complete/abort (relaxed under `NODE_ENV=test`, same convention as `inviteRateLimiter`/`guestRateLimiter`)
- `backend/src/lib/uploadSessionCleanupJob.ts` — the daily stale-session sweep body
- `backend/src/__tests__/upload-batch.smoke.test.ts` — 9 new tests (see below)
- `frontend/src/lib/uploadBatch.ts` — Uppy wiring + the chunked-completion batcher

**Modified (additive only in each case):**
- `backend/prisma/schema.prisma` — `UploadSession` + `UploadSessionFile` models, `User.uploadSessions` back-relation
- `backend/src/lib/storage.ts` — `createMultipartUpload`/`getPresignedUploadPartUrl`/`completeMultipartUpload`/`abortMultipartUpload`, following the file's existing `usingRealS3` branch pattern. No existing function touched.
- `backend/src/lib/validation.ts` — `initiateUploadSchema`/`completeUploadSchema`/`abortUploadSchema`, `MAX_BATCH_FILES`
- `backend/src/lib/queue.ts` — `UPLOAD_SESSION_CLEANUP_JOB_NAME` + `registerUploadSessionCleanupJob()`
- `backend/src/app.ts` — mounts `uploadRouter` at `/api/upload`; raised the global JSON body limit to 10mb (a real 1000-file batch payload exceeds Express's 100kb default)
- `backend/src/worker.ts` — one added `registerUploadSessionCleanupJob()` call at startup + one added `if (job.name === UPLOAD_SESSION_CLEANUP_JOB_NAME)` branch in the job processor/completed/failed handlers, mirroring the existing trash-purge job's exact pattern. **No existing pipeline step (thumbnails/EXIF/pHash/classification) touched.**
- `frontend/src/app/upload/page.tsx` — reworked onto the batch flow (see Frontend below)
- `frontend/src/lib/api.ts` — additive `uploadApi.{initiate,complete,abort}` + types
- `frontend/package.json` / root `package-lock.json` — new deps `@uppy/core` + `@uppy/aws-s3` (see Deviation #1 below)

## Deviations from the spec (flagged, not silently baked in)

1. **Package substitution: `@uppy/aws-s3` instead of the spec's literal `@uppy/aws-s3-multipart`.** `npm view @uppy/aws-s3-multipart` reports it "no longer supported" by its own maintainers — Uppy folded multipart support into `@uppy/aws-s3` (its `shouldUseMultipart` option, default `true`) as of its current major version. `@uppy/aws-s3` exposes the identical `createMultipartUpload`/`signPart`/`listParts`/`abortMultipartUpload`/`completeMultipartUpload` hook contract the spec's own config example assumes — this is a package-name swap for the actively-maintained equivalent, not a design change. Used headless (no `@uppy/dashboard`), per the spec's own default recommendation.
2. **`UploadSessionFile.originalFilename` — added, not in the spec's literal Prisma block.** The spec's schema block for `UploadSessionFile` (id, sessionId, clientId, key, uploadId, sizeBytes, sha256, mimeType, status, createdAt) has no filename column, but `Photo.originalFilename` is non-nullable and Photo-row creation is deliberately deferred to `/complete` (spec's own recommendation, Open Question #6) — meaning the client's declared filename (only available at `/initiate` time) has nowhere else to live until `/complete` needs it. Added `originalFilename` to `UploadSessionFile` as the obvious, minimal fix; flagged here rather than silently added.
3. **Uppy-per-file vs. backend-per-batch reconciliation.** `@uppy/aws-s3`'s plugin model calls `createMultipartUpload`/`signPart` once per file and `completeMultipartUpload` once per file, but this backend's `/initiate` is deliberately batch-shaped (one call for the whole selection) and `/complete` is deliberately chunked (spec: every 50 files or 30s). Resolved by calling `/initiate` ONCE up front for the whole batch, stashing its per-file `key`/`uploadId`/`partUrls` on each Uppy file's `meta` so the plugin's hooks become pure synchronous lookups (no HTTP calls of their own), and adding a small `CompletionBatcher` (`frontend/src/lib/uploadBatch.ts`) that queues each file's finished-parts payload and flushes to the real `/complete` call on the spec's own 50-files-or-30s cadence, resolving each file's individual promise once its flush round-trip returns. Per-file `abortMultipartUpload` (Uppy's per-file cancel hook) is a deliberate no-op — this app's cancel affordance is whole-batch (`uploadApi.abort(sessionId)`, called directly, not through Uppy); an un-aborted, never-completed batch is reconciled by the daily cleanup job regardless.
4. **`UPLOAD_SESSION_TTL_HOURS` and the batch storage-key convention (`{ownerId}/batch/{sessionId}/{clientId}/original.{ext}`) — not literally specified in the spec, chosen defaults.** 24 hours for the session TTL (reasonable headroom for a genuinely large 1000-file batch on a slow connection, without leaving sessions "in_progress" indefinitely). The batch key convention is distinct from the single-file route's `originalKey(ownerId, photoId, ext)` (no `photoId` exists yet at `/initiate` time, by design) — the `Photo` row created at `/complete` simply keeps this key as its `s3Key`; nothing anywhere requires `s3Key` to be derived from the photo's own id.

No other open question (PUB1/2/3/5/6/8/9) needed a deviation — built against the spec's stated recommended defaults as instructed.

## Testing

**New: `backend/src/__tests__/upload-batch.smoke.test.ts` — 9 tests, all passing, against real local MinIO/Postgres/Redis (no mocking of storage):**
- 401 without a session cookie on `/initiate`.
- 413 with no `UploadSession` row created when the batch would exceed quota.
- Over `MAX_BATCH_FILES` (1000) → 400, nothing created.
- Duplicate pre-check: an existing LIVE photo's hash is excluded (no part URLs issued) and returned in `duplicates`; the SAME hash is treated as new once that photo is trashed.
- A real multi-file batch: every non-duplicate file's presigned part URL accepts a genuine unauthenticated `PUT` directly against MinIO (confirmed the URL targets MinIO's own port, not this API) — `/complete` then creates Photo rows shaped identically to the single-file route's (same fields, `aiClassificationStatus`, `mimeType`, `sizeBytes`, `fileSha256`), each with a real `ProcessingJob` row and a real BullMQ job.
- Partial success: a deliberately tampered ETag fails only that one file (`assembly_failed`) while its sibling in the same `/complete` call still succeeds — and `storageUsedBytes` increments by only the one real success's size, never the batch's declared total.
- Content-sniff failure on assembly: non-image bytes uploaded under an honest `image/jpeg` claim → `invalid_file_type`, no `Photo` row, the assembled MinIO object deleted.
- `DELETE /api/upload/abort` genuinely aborts the multipart upload in MinIO (verified via a direct `ListMultipartUploadsCommand` before/after, not just the DB flag); `/complete` on an aborted session → 409.
- The daily cleanup job (`runUploadSessionCleanupJob`, called directly, not via a live queue round-trip) reconciles a stale `in_progress` session past its `expiresAt`: aborts its outstanding MinIO upload and flips the session to `expired`.

**Full existing backend suite:** `npx vitest run` → **277/277 passing** (268 pre-existing + 9 new), confirming the single-file upload path and every other existing feature are unaffected. Reran twice; one transient flake in `upload.smoke.test.ts` (`Parse Error: Expected HTTP/...`) on one of the runs, reproduced as non-reproducible when run standalone (passes every time in isolation) — same class of pre-existing parallel-load flake already documented in `agents/STATUS.md`'s history (2026-07-08 02:45 report), not a regression from this change.

**Typecheck/lint/build:** `backend`: `tsc --noEmit` clean, `eslint` clean, `tsc -p tsconfig.json` (build) clean. `frontend`: `tsc --noEmit` clean, `next lint` clean (one `react-hooks/exhaustive-deps` warning silenced with the same `eslint-disable-next-line` convention the pre-existing `runQueue` callback already used), `next build` clean (25/25 routes, including the new `/upload` bundle at 25.8kB).

## Note on the working tree at session start

This branch's working tree already contained substantial uncommitted work
from an earlier session (touching ~70 files — the "real AWS integrations,
smarter AI classification, face grouping, mobile scaffolding" line of work
per `agents/STATUS.md`, apparently never committed even though its own
commit `0f9a732` exists — i.e. there was a second, later round of edits on
top of that commit still sitting uncommitted). This feature's changes
necessarily shared several files with that pre-existing uncommitted work
(`app.ts`, `worker.ts`, `queue.ts`, `storage.ts`, `validation.ts`,
`schema.prisma`, `upload/page.tsx`) — there was no safe way to cleanly
separate hunks at the git level without risking corruption, so this commit's
diff on those specific files includes both the pre-existing uncommitted
content and this feature's own additions. Every OTHER file that had
unrelated pre-existing uncommitted changes (the other ~60+ files) was left
completely untouched and unstaged — only files this feature actually needed
were added to this commit. Flagging this explicitly for Master/Abhishek:
the pre-existing uncommitted work on those 7 shared files is now part of
this commit's history, not a separate one.
