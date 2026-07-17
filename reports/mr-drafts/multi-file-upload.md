# MR Draft: multi-file upload on /upload

**Branch:** `feature/ai-classification`
**Type:** Bug fix / gap fill (frontend-only)

## Summary

`/upload` only supported uploading one photo at a time: the frontend
(`frontend/src/app/upload/page.tsx`) tracked a single `file: File | null`
plus a single `photoId`/`status`/`labels`/etc., and the file input had no
`multiple` attribute (drag/drop also only took `e.dataTransfer.files[0]`).
The backend (`backend/src/routes/photos.ts`, `upload.single("file")`) is
one-file-per-request **by design** — that contract is unchanged. This was a
real product gap confirmed via manual testing and direct user feedback:
users expect to select or drop several photos at once.

Fixed entirely on the frontend by looping calls to the existing single-file
upload endpoint, once per selected file.

## Fix

`frontend/src/app/upload/page.tsx` — reworked from a single-file
proof-of-concept to a multi-file queue:

- **File input:** added the `multiple` attribute. **Drag/drop:**
  `handleDrop` now passes the full `e.dataTransfer.files` (already a
  multi-capable `FileList`) to the same `addFiles` helper the file-input
  `onChange` uses, instead of only grabbing index `[0]`.
- **State:** replaced the single `file`/`photoId`/`status`/`labels`/etc.
  fields with a list of per-file `UploadItem`s (`key`, `file`, `queueStatus`,
  `progress`, `photoId`, `pollStatus`, `labels`, `duplicateOfPhotoId`,
  `thumbnailUrl`, `error`) — one entry per selected file, each independently
  tracked. This mirrors the state-modeling idea already used per-card in
  `/organize`'s `PhotoCard` (id/status/labels/duplicate-of/thumbnail/error
  all together per photo), just applied as one list entry per upload instead
  of reusing that component.
- **Concurrency:** uploads run through a small **capped-parallel** queue
  (`UPLOAD_CONCURRENCY = 3`) rather than fully sequential or unbounded
  parallel. Chosen over sequential because uploads are I/O-bound (network +
  server-side multer buffering) — a few in flight at once noticeably speeds
  up a typical "select 5–20 photos" batch — and chosen over firing all
  selected files at once to stay gentle on the backend's rate limiter and
  its single-file-buffered route. Implementation: a small pool of `worker()`
  loops pulls the next queued item off a shared array until none remain, so
  at most 3 `photosApi.uploadWithProgress` calls are in flight regardless of
  batch size. That call itself is unchanged — same endpoint, same multipart
  `"file"` field, same response contract.
- **Per-file progress + poll + result:** each item gets its own upload
  progress bar (via the existing XHR-based `uploadWithProgress`'s
  per-call `onProgress`), its own `setInterval` poll loop (stored in a
  `Map<key, interval>` instead of one shared ref, cleared individually on
  terminal status or unmount), and its own rendered row showing photo ID,
  poll status, duplicate-of, labels, and thumbnail — reusing the same
  polling logic the single-file version had, just keyed per item. **One
  item failing (upload error, poll error, `failed` classification) only
  marks that item's row as `error`/`failed` and lets its worker/poll move
  on to or continue with the rest — it never blocks or hides other items.**
- Auth-gate (`authApi.me()` redirect-to-login) and overall simplicity kept
  as-is; this is a list of per-file rows with the same info the single-file
  version showed, not a redesign. Updated the stale header comment (no
  longer "Week 7-8 scope, deliberately unstyled" — multi-file is now a real
  need; kept deliberately simple/unstyled otherwise).

## Files touched

- `frontend/src/app/upload/page.tsx` (rewritten)

## Not touched

- No backend file touched — `backend/src/routes/photos.ts`'s
  `upload.single("file")` one-file-per-request contract is unchanged, per
  the bug report's instruction.
- `frontend/src/lib/api.ts` — `photosApi.uploadWithProgress` called
  unchanged, once per file.
- `Day5.md`, `dashboard/`, `specs/photo-deletion.md` (untracked, unrelated)
  left alone.

## Testing notes

- `npm run typecheck -w frontend` — clean (fixed a real type error along
  the way: a terminal `pollStatus` of `"done" | "duplicate" | "failed"`
  needed a narrowing cast before being written into the narrower
  `queueStatus` field).
- `npm run lint -w frontend` — clean (fixed a `react-hooks/exhaustive-deps`
  warning on the unmount-cleanup effect by capturing `pollRefs.current`
  into a local variable before the cleanup closure, since a ref's `.current`
  can change by the time cleanup runs).
- `npm run build -w frontend` — clean, all 14 routes compiled/prerendered
  (built via a temporary `distDir: ".next-verify"` in `next.config.js`,
  reverted after, since `next dev` was live on the shared `.next`; the
  build run also reformatted `tsconfig.json` as a side effect, which was
  reverted separately so the commit only contains the intended page change).
- Live-checked the underlying endpoint the page now loops: signed up a
  throwaway user, uploaded 3 distinct tiny PNGs sequentially via
  `POST /api/photos/upload` with the same session cookie — each call
  returned a **distinct `photoId`** (202 Accepted), confirming the
  single-file endpoint handles repeated independent calls correctly, which
  is exactly what the page's per-item queue relies on. Seed data (user,
  photos, folders/collections, session) cleaned up immediately after; no
  residual rows.
- Did not drive a full browser/CDP click-through this pass (multi-file
  drag/drop and the concurrency-cap interleaving are easiest to observe
  visually) — the component logic was re-read post-edit to confirm: the
  file input has `multiple`, `handleDrop` passes the whole `FileList`,
  `addFiles` fans out to independent `UploadItem`s, and each item's
  progress/poll/result is keyed and updated independently (no shared
  interval, no shared progress state). Recommend a browser pass (select/drop
  2–3 files, watch each reach its own terminal status) as a follow-up
  verification, consistent with recent Developer passes on this codebase
  that flagged the same honest gap.
