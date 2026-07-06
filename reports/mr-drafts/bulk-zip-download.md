# MR: Bulk "download all" — folder zip (P5 backend)

**Branch:** `feature/ai-classification`
**Commit:** `3e7683f`
**Spec:** `specs/folder-mgmt-download-search.md` PART P5 (built on confirmed Z1–Z7 defaults)
**Scope:** backend + tests only. No UI, no schema change, no migration, no new dep beyond `archiver`. Not pushed.

## Summary

Adds a shared streaming ZIP helper plus two endpoints that stream a ZIP assembled on-the-fly from authorized MinIO reads. The client receives **only zip bytes** — never a raw `s3Key` or a per-object pre-signed URL.

- `GET /api/folders/:id/download-all` — owner.
- `GET /api/guest/folders/:id/download-all` — guest (Z1 `download_all`-gated).

## Files

| File | Change |
|---|---|
| `backend/src/lib/folderZip.ts` | **new** — `streamFolderZip(res, { folderName, photos })`: header setup, `archiver('zip')` piped to `res`, per-object MinIO read-stream append, filename de-dup, Z5 abort+destroy. |
| `backend/src/lib/folderDownload.ts` | **new** — shared Z4 inclusion query + Z6/Z3 pre-flight (`preflightFolderDownload`, `queryDownloadablePhotos`, `DOWNLOAD_ALL_MAX_PHOTOS = 500`). |
| `backend/src/lib/storage.ts` | added `getObjectStream(key)` — authorized server-side read stream (distinct from the client-facing pre-signed-URL helper). |
| `backend/src/routes/folders.ts` | owner endpoint (imports `preflightFolderDownload` + `streamFolderZip`). |
| `backend/src/routes/guest.ts` | guest endpoint (imports the same two). |
| `backend/src/lib/audit.ts` | additive `folder_downloaded` action string. |
| `backend/package.json` + `package-lock.json` | `archiver ^7.0.1` (dep) + `@types/archiver ^6.0.2` (devDep). |
| `backend/src/__tests__/folder-zip.smoke.test.ts` | **new** — 11 tests. |

## Streaming design (no buffering, no raw keys)

- `archiver('zip')` is created and **piped straight to `res`**. Each photo is appended as a **read stream** (`getObjectStream(s3Key)`). Bytes flow object → archiver → HTTP response; the whole archive is **never held in memory or written to a temp file**. `archive.finalize()` resolves once the central directory has been flushed to the piped response.
- The `s3Key` is used **only** to open a server-side authorized read stream inside the backend. The archive entry names are the photos' **`originalFilename`** — never keys. Verified by a test that scans the entire response body and asserts it contains none of: the `ownerId/` key prefix, `original.jpg`, `X-Amz-Signature`, or `http://`.
- `Content-Type: application/zip` + `Content-Disposition: attachment; filename="<sanitized folderName>.zip"`. The folder name is sanitized (strips control chars, path/reserved chars → `_`, caps length, falls back to `photos`) so the header can't be broken or used to traverse.

## Decision handling

- **Z1 (guest permission gate):** guest endpoint requires the **live** `folder_permission.permissionLevel === "download_all"`. A `download`-only or `view`-only guest → **403** (a known-resource authorization limit is 403, matching the per-photo view→download house rule). Uses the existing `getFolderPermissionLevel` (live liveness filter). Folder not in `getPermittedFolderIds` → **404** (the choke point, before the level check).
- **Z2 (dep):** `archiver` — pure Node, stream-oriented, no cloud/native issues. `npm install` clean; typecheck sees `@types/archiver`. `npm audit` count unchanged (the same pre-existing 6 noted in STATUS; archiver added none).
- **Z3 (cap):** `> 500` downloadable photos → **409** "too large … narrow it down", enforced in the pre-flight **before any byte is written**. Async/BullMQ stored-zip remains deferred. Cap boundary is `> MAX` (exactly 500 is allowed). Unit-tested via `preflightFolderDownload` without uploading 501 objects (bulk `createMany` of counted-only rows).
- **Z4 (inclusion):** only photos with `aiClassificationStatus === "done"` **and** a non-empty `s3Key`. Skips `failed`, `duplicate`, `pending`, `processing`. Newest-first for a deterministic archive.
- **Z5 (mid-stream failure):** a per-object read failure (or any archiver error) **aborts the archive and destroys the response** (logged) — never a silently-incomplete 200. All pre-flight (auth, ownership/scope, level, count-cap, non-empty) runs **before** any byte, so ordinary failures stay clean 404/403/400/409.
- **Z6 (empty):** 0 downloadable photos → **400** "no downloadable photos" before streaming.
- **Z7 (audit):** guest success writes **one** `folder_downloaded` row (fire-and-forget, actorType `guest`, `ownerId` = folder's owner, metadata `{ folderId, folderName, photoCount }`). A 403/404/400/409 writes **none**. The owner's own zip is **not** audited (owner-on-own-data, AP1).

## Pre-flight ordering (owner / guest)

1. Owner: `requireAuth` → ownership via folder→collection→ownerId (404). Guest: `requireGuest` (401) → permitted-set (404) → Z1 level (403).
2. Z6/Z3 pre-flight (`preflightFolderDownload`) → 400 / 409.
3. (Guest only) fire-and-forget `folder_downloaded` audit.
4. `streamFolderZip` — bytes begin; only Z5 abort/destroy from here.

## Test coverage (11 tests, `folder-zip.smoke.test.ts`)

Zip validated at the **ZIP-format level without a third-party unzip dep**: local-file magic `PK\x03\x04` at start, EOCD `PK\x05\x06` at end, one central-dir header `PK\x01\x02` per entry (entry-count assertion), and entry filenames present as plain bytes.

- Owner: 401 no session; 200 `application/zip` + attachment CD + valid zip of exactly the 3 downloadable photos + **no raw key/URL in the body**; Z4 skip (failed/duplicate/pending/processing → only `done` zipped); same-filename → two distinct de-duped entries (`IMG_0001.jpg` + `IMG_0001 (2).jpg`); Z6 empty → 400 (JSON); cross-owner → 404.
- Z3 cap: `preflightFolderDownload` 409 over cap, `ok` at the boundary (exactly 500); HTTP endpoint 409 over cap.
- Guest: 401 no session; unpermitted → 404 (no row); `download`-only → 403 and `view`-only → 403 (no row); `download_all` → 200 zip (2 entries, no raw key) **and exactly one** `folder_downloaded` audit row (actorType guest, ownerId = folder owner, metadata `{ folderId, folderName, photoCount }`).

Photos are seeded with **real MinIO originals** (`putObject`) so the zip is assembled from genuine authorized reads (no worker needed). The audit assertion polls briefly since `logAudit` is fire-and-forget.

## Verification

- `npm run typecheck -w backend` — **clean**.
- `npm run lint -w backend` — **clean**.
- `npm test -w backend` — **117/117** (was 106; +11).

## Deviations

None. One implementation note: `lib/storage.ts` only exposed pre-signed-URL helpers, so a minimal authorized read-stream function (`getObjectStream`) was added there (as the spec allowed). The pre-flight/cap/inclusion logic was factored into `lib/folderDownload.ts` (shared by both routes) so Z3/Z4/Z6 are enforced identically and the cap is unit-testable without seeding 501 real objects.
