# Spec — Production Upload: Presigned Multipart Batch Upload

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 7 (Phase 1 — MVP, Week 3–4: Photo Upload Pipeline, extended); `PhotoSphere_AI_Future_Features.md` Feature 19 "Production Upload System — Presigned Multipart + Uppy + Priority Processing" (trimmed hard for this codebase's stage, per Master/Abhishek review — see Non-goals)
**Supersedes/extends:** `specs/upload-pipeline.md` (`POST /api/photos/upload`, single-file, multer memoryStorage, buffered in server RAM, one BullMQ job per file — already built, `backend/src/routes/photos.ts` lines ~52-153). This spec does NOT redesign the worker pipeline that spec built (thumbnails/EXIF/pHash/classification stays byte-for-byte the same); it only changes how bytes get from the browser into a `Photo` row + a queued job, and it adds a batch-shaped path alongside the existing one.
**Status:** draft
**Written by:** Planner Agent, 2026-07-13

## Problem

`POST /api/photos/upload` works and is tested clean, but it was built to prove the round-trip for ONE file at a time (the frontend's `/upload` page today just loops it, 3-wide, per file — see `frontend/src/lib/api.ts`'s `uploadFileWithProgress`). It does not scale to what Abhishek actually wants: uploading 500–1000 images in a single batch, reliably.

Two concrete failure modes at that scale, both structural to the current design, not fixable by tuning constants:

1. **Server-RAM buffering.** `multer.memoryStorage()` holds the entire file in the Node process's heap before `putObject` ever runs. One user uploading a 1000-photo batch of multi-MB originals concurrently with a handful of other users doing the same is a realistic OOM path on a single small backend process — the server's memory is the bottleneck for bytes it never actually needs to touch.
2. **No resumability across 500-1000 sequential requests.** Today's flow is one HTTP round-trip per file, no batch concept, no session to resume into. A dropped WiFi connection, a laptop sleep, or a tab close partway through a 1000-photo batch loses everything not yet confirmed — there's no session id to reconnect to and no way to skip files already durably stored.

Both are solved by the same architectural move: presigned multipart uploads, where the browser talks to MinIO/S3 directly and the backend's job shrinks to metadata + orchestration (0 bytes of file data ever pass through the Node process for a batch upload).

## Goals

- The browser uploads file bytes **directly to MinIO/S3** via presigned multipart URLs — the backend touches 0 bytes of any file's content for a batch upload.
- A batch of up to `MAX_BATCH_FILES` (see Open Questions) files is described in one `POST /api/upload/initiate` call, which does a single whole-batch quota check, a single whole-batch duplicate pre-check (reusing `Photo.fileSha256` — no new dedup logic), and returns presigned part URLs for every file that isn't already a known duplicate.
- `POST /api/upload/complete` finalizes each file's S3 multipart assembly, creates the exact same shape of `Photo` row `upload-pipeline.md` already established (reusing `originalKey`/`fileSha256`/`aiClassificationStatus: "pending"` etc.), atomically increments `storageUsedBytes`, and enqueues the SAME existing `photoProcessingQueue` job per photo — the worker pipeline (thumbnails/EXIF/pHash/classification) is completely unaware anything changed upstream of it.
- `DELETE /api/upload/abort` aborts any not-yet-completed multipart uploads in a session and marks it `aborted`.
- A resumable `UploadSession` row tracks batch-level progress (`totalFiles`/`completedFiles`/`failedFiles`/`totalBytes`/`uploadedBytes`/`status`) so the frontend can show real batch progress and a dropped connection can be resumed by re-fetching the session's outstanding parts rather than restarting the whole batch.
- The existing single-file `POST /api/photos/upload` endpoint is **kept, unchanged**, as the small-upload / low-friction path (see Scope §Routes below for exactly why).
- Frontend `/upload` moves from "loop the single-file endpoint N times" to "one batch initiate → N direct-to-storage part uploads → one batch complete."

## Non-goals (explicitly out of scope for this pass)

Master + Abhishek already reviewed Feature 19 in full and trimmed it hard for where this codebase actually is (local-first MVP, no billing, no Uppy/R2/Drive-import commitments yet). These are deliberate cuts, not oversights:

- **BullMQ job priority by plan tier.** Feature 19 proposes priority queues so paying users' photos process first. There is no billing in this app yet (`lib/plans.ts` only enforces a free-tier guest-count cap; `users.plan` is otherwise unread/unenforced) — a priority tier with nothing to be a "priority" over is meaningless. Every enqueued job from this spec uses the SAME default priority as today's single-file path. Revisit once billing exists.
- **Per-plan batch/storage limit tiers.** One flat batch-size cap and the existing flat `storageLimitBytes` check apply to every user regardless of plan — no "free users get batches of 50, paid get 1000" tiering this pass, for the same reason as above.
- **Google Drive import.** Unrelated feature, not touched.
- **Browser IndexedDB resume-after-tab-close (GoldenRetriever/Uppy plugin equivalent).** Resumability THIS pass means "the `UploadSession` on the server remembers what's done and what isn't, and the frontend can re-fetch it and continue" — it does NOT mean the browser tab itself can be closed and reopened and pick back up client-side without the user re-selecting files. Reconciling exactly which of the originally-selected `File` objects still need uploading after a page reload requires either re-picking the files (browser security model — a `File` handle from an `<input>` isn't restorable across a reload) or a resume UX that re-asks for the same folder. Deferred as a nice-to-have; flagged in Open Questions in case Abhishek wants the (larger) Uppy-based version of this instead.
- **Steganography/watermarking/screenshot protection.** Unrelated feature (exists elsewhere in the codebase per `lib/classification/screenshot.ts`), not touched by this spec.
- **Any change to the worker pipeline itself.** Thumbnails/EXIF/pHash/classification stay exactly as `upload-pipeline.md` built them. This spec only changes how a `Photo` row gets created and how the same job gets enqueued — the worker never knows the difference between a photo that arrived via the old single-file endpoint or the new batch flow.
- **Deleting or deprecating `POST /api/photos/upload`.** See Scope — kept as-is, for real reasons, not just backward-compat inertia.
- **Video, RAW/TIFF, or any MIME type beyond what `upload-pipeline.md` already allows** (JPEG/PNG/WebP/HEIC). This spec's file-descriptor validation reuses the identical allowlist + content-sniffing-on-complete, not a new one.
- **Stored-zip/download batch symmetry.** This spec is upload-only; `specs/folder-mgmt-download-search.md`'s P5 (bulk download-all) is a separate, already-built feature not touched here.

## Architecture note (why the backend touches 0 file bytes)

For a batch upload, the browser calls `createMultipartUpload` indirectly (via `/api/upload/initiate`, which does it server-side using AWS/MinIO credentials the browser never sees) to get an `UploadId`, then for each part of each file calls a presigned `UploadPartCommand` URL **directly against MinIO/S3** — no backend route exists for this step, no backend code runs during it, it's a plain browser `PUT` to a signed URL. Once every part of a file is uploaded (browser computes each part's ETag from the `PUT` response), the browser reports the completed parts to `/api/upload/complete`, which calls `completeMultipartUpload` server-side to assemble the object and only then creates the `Photo` row. This is the same pre-signed-URL discipline CLAUDE.md already requires for reads (`getPresignedGetUrl`, 60s TTL) — this spec is the write-side mirror of that pattern, and follows `lib/storage.ts`'s existing `usingRealS3` swap seam so the exact same code path works against local MinIO today and real S3/R2 later with zero code change.

## Scope for this sprint

### Backend — storage (`backend/src/lib/storage.ts`)

Additive functions only — nothing existing is touched or renamed. All follow the file's existing `usingRealS3` branch-free pattern (the same `s3` client instance already branches MinIO vs. real S3; multipart commands work identically against both, that's the whole point of using the SDK's abstractions rather than a raw HTTP client):

- `createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>` — wraps `CreateMultipartUploadCommand`.
- `getPresignedUploadPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds = 3600): Promise<string>` — wraps `UploadPartCommand` + `getSignedUrl`. A 1-hour TTL (not 60s like the read-side helpers) because a single part on a slow/mobile connection can legitimately take longer than a minute to upload; still short-lived enough that a leaked URL is not a standing risk. Confirm-or-veto the exact TTL number in Open Questions.
- `completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; eTag: string }[]): Promise<void>` — wraps `CompleteMultipartUploadCommand`. Throws (propagates) on any S3-side integrity failure (e.g. a missing/mismatched part) — the caller (`/api/upload/complete`) does not create a `Photo` row if this throws.
- `abortMultipartUpload(key: string, uploadId: string): Promise<void>` — wraps `AbortMultipartUploadCommand`. Idempotent-safe the same way `deleteObject` already is (a not-found/already-aborted upload is a no-op success, not an error) — needed because the abort endpoint and the stale-session cleanup path (see below) can both legitimately race to abort the same upload.

No change to `putObject`/`getPresignedGetUrl`/`getPresignedDownloadUrl`/`getObjectStream`/`deleteObject`/`ensureBucketExists` — all untouched, all still used exactly as before (including by the still-alive single-file endpoint).

**Part size.** S3/MinIO multipart requires every part except the last to be ≥5MB. Client computes part boundaries (Open Questions #2 — recommend a fixed 8MB part size, computed client-side, not server-negotiated, since the server never sees the bytes to renegotiate against).

### Backend — schema (`backend/prisma/schema.prisma`)

New additive model, new migration, same `snake_case` DB / `camelCase` Prisma convention as everything else in the file:

```prisma
model UploadSession {
  id             String    @id @default(uuid())
  ownerId        String    @map("owner_id")
  collectionId   String?   @map("collection_id") // same nullable/unused-until-Collections-CRUD posture as Photo.collectionId
  totalFiles     Int       @map("total_files")
  completedFiles Int       @default(0) @map("completed_files")
  failedFiles    Int       @default(0) @map("failed_files")
  totalBytes     BigInt    @map("total_bytes")
  uploadedBytes  BigInt    @default(0) @map("uploaded_bytes")
  status         String    @default("in_progress") @map("status") // in_progress | completed | aborted | expired
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")
  expiresAt      DateTime  @map("expires_at") // see Open Questions #4 (stale-session cleanup)

  owner User @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  @@index([ownerId, status])
  @@index([expiresAt]) // for the stale-session sweep, mirrors Folder/Photo's deletedAt index pattern
  @@map("upload_sessions")
}
```

Add the back-relation (`uploadSessions UploadSession[]`) to `User`. No change to `Photo`/`Folder`/anything else — a completed batch item is a completely normal `Photo` row, indistinguishable from one created via the single-file endpoint, with no new column linking it back to its `UploadSession` (see Open Questions #5 — flagging this as a real trade-off, not an oversight).

**DECIDED (Abhishek, 2026-07-13, resolves Open Questions #7):** a second additive model, the per-file companion table `/complete` and `/abort` use to look up `key`/`uploadId` server-side rather than trusting the client's payload:

```prisma
model UploadSessionFile {
  id        String   @id @default(uuid())
  sessionId String   @map("session_id")
  clientId  String   @map("client_id") // browser-generated correlation id, echoed from /initiate's response
  key       String   @map("key")       // S3/MinIO object key
  uploadId  String   @map("upload_id") // S3/MinIO multipart UploadId
  sizeBytes BigInt   @map("size_bytes")
  sha256    String   @map("sha256")
  mimeType  String   @map("mime_type")
  status    String   @default("pending") @map("status") // pending | completed | failed | aborted
  createdAt DateTime @default(now()) @map("created_at")

  session UploadSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([sessionId, clientId])
  @@index([sessionId, status])
  @@map("upload_session_files")
}
```

Add `files UploadSessionFile[]` to `UploadSession`. `/complete` and `/abort` receive only `sessionId` + `clientId`(s) from the client — the server looks up `key`/`uploadId` from this table (scoped to `sessionId`/`ownerId`) rather than accepting them directly in the request body, closing the ownership-check gap Open Questions #7 flagged.

### Backend — queue

No change to `backend/src/lib/queue.ts`'s `photoProcessingQueue`, job shape (`PipelineJobData = { photoId }`), retry/backoff config, or the worker (`backend/src/worker.ts`). `/api/upload/complete` calls `photoProcessingQueue.add("pipeline", { photoId }, { jobId })` — the literal same call the single-file route already makes — once per successfully-assembled photo. Per Non-goals, no priority option is passed.

### Backend — validation (`backend/src/lib/validation.ts`)

New Zod schemas, following the file's existing conventions:

- `initiateUploadSchema` — `{ files: FileDescriptor[], collectionId?: string }`, `FileDescriptor = { clientId: string, filename: string, sizeBytes: number, mimeType: string, sha256: string, exifTakenAt?: string }`. `clientId` is a caller-generated per-file correlation id (so the response can map back to the exact file the browser is holding — a filename alone isn't a safe key, two selected files can share a name) — the browser generates it (e.g. `crypto.randomUUID()`), the backend just echoes it back in `initiate`'s response and expects it again in `complete`'s payload. `files` capped at `MAX_BATCH_FILES` (Open Questions #1), each `sizeBytes` capped at the existing 50MB ceiling (`upload-pipeline.md`'s `MAX_UPLOAD_BYTES`, reused not re-litigated), `mimeType` checked against the existing allowlist (final content-sniff still happens server-side once the object exists — see below, since the client-declared `mimeType` is not trustworthy on its own, same posture as the single-file route already takes).
- `completeUploadSchema` — `{ sessionId: string, files: { clientId: string, key: string, uploadId: string, parts: { partNumber: number, eTag: string }[] }[] }`.
- `abortUploadSchema` — `{ sessionId: string }`.

### Backend — routes (new `backend/src/routes/upload.ts`, mounted at `/api/upload`, `requireAuth` on all three, its own rate limiter — see below)

**`POST /api/upload/initiate`:**
1. Validate body (400 on failure, per house rule).
2. Whole-batch quota check: `dbUser.storageUsedBytes + sum(files[].sizeBytes) > dbUser.storageLimitBytes` → 413, nothing created (mirrors the single-file route's existing pre-check, just summed).
3. Whole-batch duplicate pre-check: `SELECT id, fileSha256 FROM photos WHERE ownerId = :userId AND fileSha256 IN (:hashes) AND deletedAt IS NULL` (respects the trash system — a trashed photo's hash doesn't block a re-upload, matching how a normal re-upload of a permanently-deleted photo already behaves today). Every file whose `sha256` matches an existing live photo is marked `alreadyExists: true` in the response with that photo's id, and is **excluded** from the multipart-URL-issuing step below — the client skips uploading it (saves the bandwidth entirely, not just the classification call, which is a strictly better outcome than today's single-file flow where a dup still pays the full upload cost before the worker catches it).
4. For every remaining (non-duplicate) file: create the `Photo` row up front exactly as the single-file route does (`s3Key` patched after; `aiClassificationStatus: "pending"`; `fileSha256` from the client-declared hash — verified against actual content in step 5 below, not blindly trusted) NO — see Open Questions #6, this is a genuine design fork (create `Photo` rows at initiate-time like the single-file route's ordering, vs. defer photo-row creation until complete-time since a browser tab closing mid-batch would otherwise leave `pending` rows with no object behind them). **Recommended: defer `Photo` row creation to `/complete`** — initiate only creates the `UploadSession` row + calls `createMultipartUpload` per file, returning `{ sessionId, files: [{ clientId, key, uploadId, partUrls: [...], alreadyExists? }] }`. This avoids the single-file route's own historical failure mode (its try/catch rolling back an orphaned row on a failed `putObject`) ever needing to exist for batch uploads at all — there's simply no row until the object is confirmed assembled.
5. Create the `UploadSession` row (`totalFiles` = count of non-duplicate files, `totalBytes` = their summed size, `expiresAt` = now + `UPLOAD_SESSION_TTL_HOURS`).
6. Return `{ sessionId, files: [...], duplicates: [{ clientId, existingPhotoId }] }`.

**`POST /api/upload/complete`:**
1. Validate body; look up the `UploadSession` (404 if not found/not owned — house rule; 409 if already `completed`/`aborted`/`expired`).
2. For each file in the payload, in order, independently (one file's failure doesn't block the others — partial-success shape, same philosophy as the already-shipped `bulk-delete`/`bulk-move` endpoints):
   a. Content-sniff is NOT possible pre-assembly (the backend never held the bytes) — instead, immediately after `completeMultipartUpload` succeeds, do a `getObjectStream` HEAD/partial-read magic-byte sniff of the assembled object (reuse `sniffMimeType` from `lib/fileSniff.ts` against the first few KB of the stream) before creating the `Photo` row. If it fails the sniff, the object is deleted (`deleteObject`) and the file is reported `failed: "invalid_file_type"` in the response — this is the batch flow's equivalent of the single-file route's pre-upload 400, just necessarily moved to post-assembly since that's the earliest point the backend can see real bytes.
   b. On success: create the `Photo` row (identical shape/fields to the single-file route — `ownerId`, `s3Key`, `originalFilename`, `mimeType` from the sniff not the client claim, `sizeBytes`, `fileSha256` from the client-declared hash, `aiClassificationStatus: "pending"`, `collectionId` from the session if present), atomically increment `storageUsedBytes` by that file's actual size (same `$transaction` pattern as the single-file route), create the `ProcessingJob` row, enqueue the SAME `photoProcessingQueue.add("pipeline", { photoId }, { jobId })` call.
   c. Increment the session's `completedFiles`/`uploadedBytes` (success) or `failedFiles` (failure) — after all files in the request are processed, if `completedFiles + failedFiles === totalFiles`, flip `status` to `completed`.
3. Return `{ sessionId, results: [{ clientId, photoId, status: "queued" } | { clientId, failed: true, reason }] }`.

**`DELETE /api/upload/abort`:**
1. Validate body; look up the session (404/409 same as above).
2. For any file in the session not yet reported complete, call `abortMultipartUpload` (best-effort — log and continue on individual failures rather than aborting the whole abort). This requires the session (or a companion in-memory/DB record) to remember each file's `key`/`uploadId` between `initiate` and `abort` — see Open Questions #7 for exactly where that lives, since the `UploadSession` model above only tracks aggregate counts, not per-file `uploadId`s.
3. Mark the session `aborted`. Returns `{ sessionId, aborted: true }`.

### Backend — stale-session cleanup

No cron automation exists anywhere in this environment (per `agents/STATUS.md`'s standing note — Tester/Developer cycles are manual, not cron-scheduled). Three real options, differing in when a stale `in_progress` session (browser closed mid-batch, no abort ever called) gets reconciled:
- (a) A BullMQ repeatable job, same pattern as the trash system's daily purge (`registerTrashPurgeJob`/`lib/trashPurgeJob.ts`) — registered on the same `photoProcessingQueue`, runs daily, finds `UploadSession` rows past `expiresAt` still `in_progress`, calls `abortMultipartUpload` for any outstanding parts and flips them to `expired`.
- (b) Lazy check-on-next-request — the NEXT time this same user calls `/api/upload/initiate`, first expire any of their own stale sessions inline.
- (c) Defer entirely — MinIO/S3 has its own native incomplete-multipart-upload lifecycle expiration that can be configured at the bucket level (a standard S3 feature, zero app code) as the actual cleanup mechanism; the `UploadSession` row itself just sits at `in_progress` forever, cosmetically stale but harmless (no `Photo` row was ever created for its unfinished files, so nothing is user-visible or storage-quota-charged incorrectly).

**Recommended: (a)**, reusing the exact scheduling pattern the trash-purge job already established (this app now has that precedent, cron-equivalent for both), since it's the option that keeps `UploadSession.status` actually meaningful for a resume-UI to read, at the cost of one small additive job. (c) is the honest fallback if Abhishek would rather not add another scheduled job for this pass. Flagged as Open Questions #4.

### Backend — rate limiting

New `initiateUploadRateLimiter`, same shape as `uploadRateLimiter` (keyed by user id, not shared bucket) but a much lower ceiling since one call now represents an entire batch, not one file — recommend 10 initiate-calls / 15 min / user (a real 500-1000-file batch is one call; 10 gives headroom for retries/multiple albums without inviting abuse). `/complete` and `/abort` reuse the SAME limiter bucket as `/initiate` (all three are session-lifecycle calls on the same resource, not independent surfaces to throttle separately).

### Backend — the existing single-file endpoint: kept, not deleted

`POST /api/photos/upload` stays exactly as `upload-pipeline.md` built it, unmodified. Reasons, stated explicitly rather than left implicit:
- It's simpler and has lower latency for the common "add one or two more photos" case — no session bookkeeping, no multipart handshake overhead for a single small file.
- Multipart uploads have a **mandatory 5MB-per-part minimum** on S3/MinIO — a single-part multipart upload of, say, a 200KB photo is needlessly heavier than one plain `PUT`. The batch flow is the right tool specifically for large-N and/or large-total-bytes batches, not a universal replacement.
- Removing it would break nothing else in the shipped app (`/upload`'s existing per-file loop is the only caller, and this spec updates that caller — see Frontend below), but keeping it costs nothing and preserves a fallback path if the batch flow ever needs to be rolled back independently.

**Frontend behavior split (stated here, not left as a guess):** the `/upload` page's file-picker/drop-zone always builds the SAME batch (any number of files ≥1) and always calls `/api/upload/initiate` → parts → `/api/upload/complete`, even for a single file — one code path, no "if only 1 file, use the old endpoint" branching in the UI. The old single-file endpoint remains reachable (for API-direct callers, scripts, or a future mobile client that might prefer its simplicity) but the web `/upload` page itself is fully migrated to the batch flow, not dual-wired. Flagged as Open Questions #8 in case Abhishek wants the opposite (small batches keep using the old endpoint, only large batches go through the new flow) — recommend against that split since it doubles the frontend's upload logic for a marginal latency win on tiny batches.

### Frontend

`frontend/src/app/upload/page.tsx` and `frontend/src/lib/api.ts` rework, replacing the current "loop `uploadFileWithProgress` 3-wide" queue with:
1. On file selection/drop: compute each file's SHA-256 client-side (Web Crypto `crypto.subtle.digest("SHA-256", await file.arrayBuffer())`) and its `clientId`, build the `FileDescriptor[]`, call `uploadApi.initiate({ files })`.
2. For each non-duplicate file in the response, upload its parts directly to the returned presigned URLs via `fetch`/`XMLHttpRequest` `PUT` (XHR needed for the same per-part progress-event reason `uploadFileWithProgress` already uses XHR over fetch), capturing each part's response `ETag` header.
3. Once all parts for a file are done, that file's completion payload is ready; the frontend batches completion reporting (e.g. call `/complete` once every N finished files, or once at the very end for the whole batch — see Open Questions #9) rather than one `/complete` call per file, to keep the request count down for a 1000-file batch.
4. Per-file progress bars + a batch-level progress summary (X of N uploaded, Y duplicates skipped, Z failed) — same per-item state-modeling idea the current page already uses (`UploadItem[]`), extended with a `sessionId` and part-level progress instead of a single XHR's progress event.
5. Polling (`photosApi.status`) for classification progress is UNCHANGED — it still runs per returned `photoId`, exactly as today, once `/complete` hands back real photo ids.

**DECIDED (Abhishek, 2026-07-13): Uppy.** `@uppy/core` + `@uppy/aws-s3-multipart` (new dependency, flagged per CLAUDE.md's new-dependency rule, approved) handles presigned multipart part upload, per-part retry, concurrency capping, and progress aggregation — Developer wires its `createMultipartUpload`/`signPart`/`completeMultipartUpload`/`abortMultipartUpload` hooks to this spec's three backend endpoints (same shape as Feature 19's own Uppy config example in `PhotoSphere_AI_Future_Features.md`, adapted to this spec's actual request/response fields — `clientId` correlation, `duplicates` handling, chunked `/complete` calls). `@uppy/dashboard`/`@uppy/drag-drop`'s prebuilt UI is optional — `/upload` already has its own page UI, so use Uppy headless (`@uppy/core` + the S3 plugin only) unless Developer judges the prebuilt Dashboard component is a net simplification. GoldenRetriever (IndexedDB tab-close resume) stays deferred per Non-goals — not part of this decision, can be added later as a pure plugin addition with no backend change.

## Acceptance criteria

- [ ] `POST /api/upload/initiate` with no session cookie → 401.
- [ ] `POST /api/upload/initiate` with a batch whose summed `sizeBytes` would exceed the user's remaining quota → 413, no `UploadSession` row created, no `createMultipartUpload` calls made against MinIO.
- [ ] `POST /api/upload/initiate` with a batch containing a file whose `sha256` matches an existing LIVE (non-trashed) photo of the same owner → that file is returned under `duplicates` with the existing `photoId`, and NO presigned part URLs are issued for it; a file matching a TRASHED photo's hash is treated as new (not flagged as a duplicate).
- [ ] `POST /api/upload/initiate` with a batch over `MAX_BATCH_FILES` → 400, nothing created.
- [ ] For a real multi-file (e.g. 20-file) batch: every non-duplicate file's returned presigned part URL(s) accept a real `PUT` of that part's bytes directly against MinIO with no `Authorization`/session cookie needed (proving the browser talks to storage directly, not through the Node process) — verified by Tester with a plain `fetch`/`curl` PUT, not just trusting the shape of the response.
- [ ] The backend's own request-handling process's memory usage does not meaningfully grow proportional to total batch bytes during a full 20-file batch upload (spot-check via process RSS before/after, or by instrumenting; the qualitative claim to verify is "the Node process never holds file bytes for a batch upload," not a precise byte-for-byte memory ceiling).
- [ ] `POST /api/upload/complete` on a session whose files' parts were genuinely uploaded to MinIO → each file gets a `Photo` row with the SAME shape as one created via the single-file `POST /api/photos/upload` endpoint (same fields present, same `aiClassificationStatus: "pending"`), a `ProcessingJob` row, and a `photoProcessingQueue` job — and each of those photos completes classification the SAME way the existing worker pipeline already handles any other photo (thumbnails generated, EXIF extracted, dedup/classification run) — no worker-side special-casing needed or present.
- [ ] `POST /api/upload/complete` where one file's part-upload was tampered with (a bogus ETag, or a part deliberately never uploaded) → THAT file fails with a clear reason in the response and does NOT get a `Photo` row, while every OTHER file in the same batch still completes successfully (partial-success, not all-or-nothing).
- [ ] `POST /api/upload/complete` assembling an object whose actual bytes fail the magic-byte sniff (e.g. a renamed non-image file, uploaded byte-for-byte through the multipart flow despite an honest `mimeType` claim in `initiate`) → that file fails as `invalid_file_type`, the assembled MinIO object is deleted, no `Photo` row created — proving content-sniffing survives the move from pre-upload (single-file route) to post-assembly (batch route).
- [ ] `dbUser.storageUsedBytes` after a completed batch reflects exactly the sum of the successfully-completed files' real sizes — not the batch's originally-declared total (a partially-failed batch must not overcharge quota for files that never got a `Photo` row).
- [ ] `DELETE /api/upload/abort` on an in-progress session with outstanding multipart uploads → those uploads are genuinely aborted in MinIO (verify via `ListMultipartUploads` before/after, not just the DB flag) and the session is marked `aborted`; calling `/complete` afterward on the same session → 409.
- [ ] A `UploadSession` past its `expiresAt` still `in_progress` is reconciled per whichever cleanup approach Abhishek picks (Open Questions #4) — Tester's acceptance check here depends on that pick.
- [ ] The existing single-file `POST /api/photos/upload` endpoint's full existing test suite (from `upload-pipeline.md`) still passes unmodified — proving this spec is additive, not a regression on the shipped path.
- [ ] `/upload`'s frontend page, given 20 real image files dropped at once, completes the whole batch (all 20 land as `done`/`duplicate`/`failed` photos, matching upload-pipeline.md's existing per-photo terminal states) using ONLY the new batch endpoints — no call to `/api/photos/upload` from the page for a multi-file selection.
- [ ] No raw storage credential, MinIO/S3 secret key, or unsigned direct-storage URL is ever returned to the browser by any endpoint in this spec — every URL handed to the client is a time-limited presigned URL (part-upload URLs) or nothing at all (initiate/complete/abort return metadata only, never bytes or credentials).

## Success signal

Tester Agent can: select or drop 500+ real image files on `/upload` (or drive the three new endpoints directly over HTTP for a batch that size, if the browser UI makes that awkward to click through), watch the batch initiate (single call, fast, regardless of N), watch parts stream directly to MinIO (confirmed via network inspection that these `PUT`s target the MinIO endpoint directly, not `localhost:4000`), watch `/complete` turn each assembled file into a normally-processing `Photo` row indistinguishable from one uploaded via the old single-file endpoint, and confirm the backend API process's own memory stays flat throughout regardless of total batch size. Tester also confirms: a batch containing some already-uploaded (same-hash) files correctly skips re-uploading those bytes entirely; deliberately corrupting one file's parts fails only that file while the rest of a large batch still succeeds; aborting a session genuinely cleans up MinIO's incomplete multipart state, not just a DB flag; and the pre-existing single-file endpoint's own test suite still passes with zero changes.

## Open questions

Posted to `agents/STATUS.md` under Pending Decisions — recommended defaults stated below, per house rule (ambiguity flagged, not silently baked into code):

1. **`MAX_BATCH_FILES` — exact cap.** Abhishek's stated need is 500-1000 images in one batch. **Recommended: 1000** (a round number covering the stated upper bound; the 50MB-per-file ceiling already caps any single file's size, and the whole-batch quota check already caps total bytes regardless of count). Confirm the number, or whether it should instead be an effective-total-bytes cap (e.g. "however many files fit under 20GB") rather than a flat file count.
2. **Client-side part size.** **Recommended: fixed 8MB parts** (comfortably above S3's 5MB-minimum-except-last-part rule, small enough to keep individual part retries cheap on a flaky connection, large enough to keep the part-count-per-file reasonable — a 50MB file is ~7 parts). Confirm, or state a different fixed size / a size that scales with file size.
3. **Presigned part-URL TTL.** **Recommended: 3600 seconds (1 hour)**, longer than the read-side 60s helpers since a part can legitimately take a while on a slow connection and a whole 1000-file batch's issuance-to-completion window can span many minutes. Veto toward a shorter TTL if leaked-URL exposure window matters more than upload-speed tolerance here.
4. **Stale in-progress session cleanup mechanism. DECIDED (Abhishek, 2026-07-13): (a) a daily BullMQ repeatable job**, reusing the exact `upsertJobScheduler` pattern the trash-purge job already established (see Scope §Stale-session cleanup above).
5. **No `uploadSessionId` FK on `Photo`.** A completed batch item is created as a plain `Photo` row with no back-reference to the `UploadSession` it came from — meaning there's no way to later ask "which photos came from batch X" after the fact (only the session's own aggregate counts survive). **Recommended: accept this** — nothing in the current product needs per-batch photo grouping after upload completes (no "batch" concept exists anywhere else in the UI), and adding the column is trivial to do later (additive migration) if a real need for it surfaces. Veto if Abhishek wants that traceability from day one.
6. **When does the `Photo` row get created — at `/initiate` or at `/complete`?** **Recommended: at `/complete`, after successful assembly** (stated and reasoned in Scope §Routes above) — this avoids ever having a `pending` `Photo` row pointing at a MinIO object that doesn't exist yet, a failure mode the single-file route has to actively guard against (its try/catch rollback) that the batch flow can simply not have. Confirm this ordering, or state a reason to create rows earlier (e.g. if the frontend wants a `photoId` to poll before the upload finishes — not requested, not recommended).
7. **Where do per-file `key`/`uploadId` pairs live between `/initiate` and `/abort`/`/complete`?** The `UploadSession` model above only carries aggregate counts, not a per-file part-tracking table. Two options: (a) a new lightweight companion table (`UploadSessionFile`: `id, sessionId, clientId, key, uploadId, sizeBytes, sha256, mimeType, status`) that IS the per-file bookkeeping `/complete`/`/abort` need to look up `uploadId`s by `clientId`/`key` without trusting the client to echo them back accurately; or (b) trust the client's `/complete`/`/abort` payload to carry `key`/`uploadId` for each file itself (simpler schema, but means a compromised/buggy client could reference an arbitrary `key`/`uploadId` pair — needs a server-side ownership check that the `key` was actually issued under this session/user before acting on it, since S3 itself will happily complete/abort any valid uploadId+key it's given). **DECIDED (Abhishek, 2026-07-13): (a)**, a companion table — the safer default (never acts on a client-supplied `key`/`uploadId` without first confirming the row exists and belongs to this session/owner) and it's what actually lets `/abort` know what to abort without the client needing to have kept its own bookkeeping. Schema footprint of this spec is "two new tables" (`UploadSession` + `UploadSessionFile`), not one.
8. **Should tiny batches (e.g. 1-3 files) keep using the old single-file endpoint from the UI, or does `/upload` always use the batch flow regardless of count?** **Recommended: always batch flow from `/upload`**, even for 1 file (reasoned in Scope §"kept, not deleted" above) — one frontend code path, not two. Veto toward a size-based split if the multipart handshake overhead for single small files is judged not worth it.
9. **`/complete` call granularity — one call per file, one call per N-file chunk, or one call for the whole batch?** For 1000 files, one call per file is 1000 requests; one call for the whole batch is a single (large) request with a correspondingly large payload and blast radius if it times out mid-processing. **Recommended: chunked — e.g. every 50 completed files (or every 30 seconds, whichever comes first), plus a final call for the remainder** — bounds both the request count and the per-request payload/processing time, and keeps the partial-success semantics meaningful at a granularity Tester/Abhishek can actually observe mid-batch. Confirm the chunk size, or pick a different granularity entirely.
10. **Uppy (`@uppy/core` + `@uppy/aws-s3-multipart`) vs. hand-rolled chunking.** **Recommended: hand-roll** (reasoned in Scope §Frontend above). Genuinely a toss-up per the task's own framing — flagging for Abhishek's explicit call before Developer builds the frontend half of this spec, since picking Uppy after the hand-rolled version is built is a real rewrite, not a small change.
