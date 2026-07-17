# MR Draft: fix dead end for failed/duplicate photos in Unfiled

**Branch:** `feature/ai-classification`
**Type:** Bug fix (frontend-only)

## Summary

`PhotoCard` in the `/organize` grid rendered exactly one action per card based
on `photo.status`: a `failed` card got only "Reclassify", a `duplicate` card
got only "Not a duplicate?", and every other status got the "Move to…"
dropdown — mutually exclusive via if/else-if. A photo that keeps failing
classification, or that a user disagrees is a duplicate but doesn't want to
re-run detection on, had **no way to manually file it into a folder**. This
was a real dead end, most visible for photos sitting in Unfiled (their only
other actions are the status-specific button, and until now, an Unfiled
failed/duplicate card had no Move control at all).

The backend (`PATCH /api/photos/:id` in `backend/src/routes/photos.ts`)
already ignores `aiClassificationStatus` entirely and supports moving a
failed/duplicate photo into any owned folder — confirmed via live HTTP
verification below. This was purely a frontend gating bug.

## Fix

`frontend/src/app/organize/page.tsx`:

- `PhotoCard`: removed the `photo.status !== "failed" && photo.status !==
  "duplicate"` guard around the "Move to…" `<select>`. It now renders
  unconditionally for every card. The Reclassify / "Not a duplicate?" buttons
  keep their existing status-gating unchanged. Failed/duplicate cards now
  show both their status action and the Move dropdown, stacked vertically;
  every other card is unchanged (single Move dropdown).
- `handleMove`: the stale comment claiming "sourceFolderId is never
  UNFILED_FOLDER_ID here" is now wrong (an Unfiled failed/duplicate card can
  trigger a move) — updated. Added `sourceWasUnfiled` check.

**Second bug found and fixed in the same pass:** `handleMove` reconciled real
folders' `photoCount` on a successful move but never touched the sidebar's
`unfiledCount` when the source was Unfiled. The `setFolders` mapping is a
harmless no-op for `UNFILED_FOLDER_ID` (no real `Folder` row has that id, so
nothing decremented there), but nothing else decremented `unfiledCount`
either — moving a photo out of Unfiled left the sidebar's Unfiled badge
stale/inflated by 1. This bug already existed before this change (any
`done`-status orphan card, e.g. from a deleted folder, reachable in Unfiled
per `9664b6b`, would have hit the same gap) but was previously unreachable
for failed/duplicate cards since they had no Move control at all. Fixed by
adding `setUnfiledCount((prev) => Math.max(0, prev - 1))` when
`sourceFolderId === UNFILED_FOLDER_ID`, following the same "server confirms
success, do a targeted local update" pattern used for real-folder counts.

`frontend/src/app/globals.css`:

- Added `.organize-card-action { display: flex; flex-direction: column; gap:
  6px; }` so two stacked controls (status button + Move select) on
  failed/duplicate cards have breathing room. No other card styling touched.

## Files touched

- `frontend/src/app/organize/page.tsx`
- `frontend/src/app/globals.css`

## Testing notes

- `npm run typecheck -w frontend` — clean.
- `npm run lint -w frontend` — clean (`No ESLint warnings or errors`).
- `npm run build -w frontend` (via `next build` with `NEXT_DIST_DIR` pointed
  at an isolated scratch dir, since `next dev` was live on the shared
  `.next`) — clean, all 14 routes compiled/prerendered successfully.
- Live check against running Docker Compose stack (Postgres/Redis/MinIO) +
  backend on :4000: seeded a throwaway user/collection/folder/session plus a
  `failed`-status photo and a `duplicate`-status photo, both with
  `folderId: null` (Unfiled). Confirmed via `GET /api/photos/unfiled` both
  appeared in Unfiled. Called `PATCH /api/photos/:id` with a target
  `folderId` for each — both succeeded (200, correct `folderId`/`folderName`
  in response) and both disappeared from a follow-up `GET
  /api/photos/unfiled` call. This confirms the backend path this fix now
  exposes in the UI. All seed data cleaned up immediately after (throwaway
  scripts also deleted, not committed).
- Did not drive a full browser/CDP click-through this pass (backend-verified
  + component logic reviewed directly); the render logic was re-read after
  the edit and confirmed the `<select>` renders unconditionally alongside the
  status-gated button.

## Not touched

- No backend files touched (per the bug report, `PATCH /api/photos/:id`
  already had no status gating — confirmed, not modified).
- `Day5.md` and `dashboard/` (untracked, unrelated) left alone.
