# MR Draft: Folder Browser (`/browse`) + Shared Photo Viewer

**Branch:** `feature/ai-classification` (commit `243b338`, on top of `37c6e8e`)
**Spec:** `specs/week7-8-dashboard-browser-viewer.md`
**Status:** ready for Tester

## Title
feat: add read-only folder browser (`/browse`) and shared photo viewer

## Summary

Ships the two pieces of Week 7-8's remaining scope that were judged buildable now (no new wireframe needed): a read-only folder browser at a new `/browse` route, and a fullscreen photo viewer with an EXIF info panel, shared between `/browse` and `/organize`. The Dashboard page remains explicitly out of scope this pass - still blocked on Abhishek's wireframe pick (Pending Decision 0.5 in `agents/STATUS.md`).

## What changed

- **`frontend/src/app/browse/page.tsx` (new)** - the folder browser. Auth-gated identically to `/organize`/`/dashboard`/`/upload` (`authApi.me()` on mount, redirect to `/login` on 401). Sidebar (real folders + a virtual "Unfiled" row when its count > 0) using the same data sources as `/organize` (`GET /api/collections` → default collection → `GET /api/collections/:id/folders`, plus `GET /api/photos/unfiled` for the Unfiled count - the already-fixed user-scoped endpoint, so this page cannot repeat the brand-new-user-first-upload-unreachable bug `/organize` hit earlier this cycle). Clicking a folder/Unfiled row loads a paginated grid (`limit=12`) via `GET /api/folders/:id/photos` or `GET /api/photos/unfiled`. Every mutation surface from `/organize` is removed: no Move `<select>`, no Reclassify/"Not a duplicate?" button, no inline folder-creation input, no poll timers, no per-card action state (`moving`/`reclassifying`/`actionError`). Reuses `/organize`'s CSS classes wholesale (`.organize-shell`, `.organize-sidebar`, `.organize-grid`, `.organize-card`, etc.) - visually a subset of the same design, not a new visual language, per the spec.
- **`frontend/src/components/PhotoViewer.tsx` (new)** - the shared photo viewer. Fullscreen overlay: full-resolution image (`GET /api/photos/:id`'s `original.url`, fetched per-open, not the grid's 150px thumbnail) + an EXIF/info side panel (filename, folder name or Unfiled status, date taken formatted or "Unknown", camera make/model shown only when at least one is non-null, GPS lat/lng as plain text when present). Close via an X button, Escape, or clicking the backdrop - all three independently wired. Prev/Next (buttons + Left/Right arrow keys) navigate within the caller-supplied photo array only (the currently-loaded grid page) - disabled/hidden, not wrapped, at the first/last photo. Stale-fetch guard via a request-id ref, same pattern `/organize`'s grid fetch already uses, so rapid prev/next clicks can't let an older response clobber a newer one.
- **`frontend/src/app/organize/page.tsx`** - wired the same `PhotoViewer` in: clicking a card's thumbnail (not the Move `<select>` or Reclassify/"Not a duplicate?" button) opens it, on both real-folder and Unfiled cards. No existing `/organize` behavior removed or changed - purely additive (`viewerIndex` state + a `viewerPhotos` derived array + the thumbnail becoming a `<button>`).
- **`frontend/src/lib/api.ts`** - added an exported `PhotoDetail` type and typed `photosApi.get()`'s return as `Promise<PhotoDetail>` (previously untyped `apiFetch` passthrough). No new endpoint, no request/response shape change - purely a frontend type addition for the viewer to consume `original.url`/`exif`/`folder`/`originalFilename` with type safety.
- **`frontend/src/app/globals.css`** - new `.viewer-*` rules (backdrop, shell, close button, image area, nav buttons, info panel, a `max-width: 720px` responsive breakpoint that switches the info panel from a side panel to a bottom sheet).

**No backend changes.** Confirmed directly (not assumed) against `backend/src/routes/photos.ts`, `collections.ts`, and `folders.ts` that all consumed endpoints already return everything both screens need, exactly as the spec's "Confirmed: no new backend work needed" section states.

## Shared vs. duplicated code call

- **Shared:** the `PhotoViewer` component itself (used unmodified by both pages), the CSS classes (`organize-*`), and the overall page-shape (auth gate → sidebar fetch → grid fetch → pagination) pattern, though not extracted into a hook this pass.
- **Duplicated:** `/browse`'s photo-card markup (`ReadOnlyPhotoCard`, ~40 lines) is a separate component from `/organize`'s `PhotoCard`, not an extraction with a `readOnly` prop threaded through. `/organize`'s `PhotoCard` takes `onMove`/`onReclassify` and renders a Move `<select>` or a Reclassify/"Not a duplicate?" button depending on card status and per-card `moving`/`reclassifying` state - none of which `/browse` has. Threading a `readOnly` flag through that component's action-row branch would add a conditional to every action path for a screen that never uses any of them; duplicating the ~30 lines of thumb/filename/meta markup was judged cheaper and keeps `/browse`'s component genuinely simple (matches the spec's own framing of this as a judgment call, not a hard requirement).
- Also duplicated (deliberately, per the spec's route-vs-mode reasoning): the sidebar/grid-fetch data-loading logic itself, since `/browse` is `/organize`'s data-fetching code with all mutation logic removed - copying and trimming was simpler and lower-risk than parameterizing `/organize`'s already-complex component with a read-only mode.

## Verification

**Typecheck/lint (frontend):**
```
npm run typecheck -w frontend   -> clean, no output
npm run lint -w frontend        -> "No ESLint warnings or errors"
```

**Backend:** no files touched; ran the full suite anyway as a sanity check: `NODE_ENV=test npm run test -w backend` → 56/56 passed, unchanged from before this change.

**Manual verification (Playwright against the live stack, fresh test user with a real mix of done/failed/duplicate photos across 4 categories):**
- Unauthenticated `GET /browse` redirects to `/login`.
- Sidebar renders real folders (Animals/Food/Nature/People) with live counts plus an Unfiled row (count 2) - a duplicate and a `FORCE_FAIL_` photo.
- Zero move/reclassify/create-folder controls present anywhere on `/browse`, confirmed via DOM query (`data-testid` counts), not just visual inspection - and confirmed no `PATCH`/`POST` request to any `/api/photos/*` endpoint ever fires during a `/browse` session.
- Clicking a folder loads its grid; clicking Unfiled shows the amber "duplicate of fixture-food.jpg (sha256)" card and the red "classification failed" card with the same styling as `/organize`, no action row.
- Opening the viewer from a thumbnail: image `src` confirmed to be the pre-signed `original.jpg` URL (not a `thumb_150` URL); info panel showed "Unknown" for a null `takenAt` and correctly omitted the Camera row (both fields null on the test fixtures, which have no EXIF baked in).
- Prev/Next: on a 1-photo folder both nav buttons correctly absent; uploaded two more photos into Nature (now 2 photos) and confirmed Prev absent/Next present at index 0, both flip correctly at index 1 (last), and ArrowLeft/ArrowRight navigate correctly.
- All three close methods independently verified: X button, Escape key, backdrop click.
- Grid state (still showing the same folder's grid) confirmed intact after opening/navigating/closing the viewer.
- `/organize` regression: confirmed the viewer opens identically from both a real-folder card's thumbnail and an Unfiled card's thumbnail (showing the status badge instead of a folder name), and confirmed the existing Move `<select>` and Reclassify/"Not a duplicate?" buttons are still present and unaffected by the new thumbnail-click wiring.

**One real bug found and fixed during this verification pass (not shipped broken):** the viewer's backdrop-click-to-close never actually fired. Root cause: `.viewer-shell` is sized to 100% width/height of the fullscreen overlay, so there is no exposed backdrop margin for a click to land on - every click landed inside `.viewer-image-area`, and the outer backdrop's `onClick` guard (`e.target === e.currentTarget`) never matched. Fix: moved the "click outside the image counts as close" check onto `.viewer-image-area` itself (still guarded the same way, so clicks on the image/nav buttons don't trigger it). Re-verified live after the fix - all three close methods now work independently.

## Deviations from spec

None. Built exactly the buildable-now scope (folder browser + photo viewer), left the Dashboard page untouched and unimplemented, made no backend changes, and used the spec's stated defaults for both open judgment calls it explicitly delegated to Developer (EXIF panel responsive breakpoint: side panel ≥720px / bottom sheet below; per-photo-open fetch rather than eager prefetch for `GET /api/photos/:id`).

## Files touched
- `frontend/src/app/browse/page.tsx` (new)
- `frontend/src/components/PhotoViewer.tsx` (new)
- `frontend/src/app/organize/page.tsx` (modified - viewer wiring only)
- `frontend/src/lib/api.ts` (modified - added `PhotoDetail` type)
- `frontend/src/app/globals.css` (modified - added `.viewer-*` rules)

## Testing notes for Tester
- A brand-new user whose first photo fails/dedupes before any collection exists should reach it via `/browse`'s Unfiled row on the very first load - this is the exact regression `/organize` had (07:31 report) and `/browse` is built against the already-fixed endpoint from day one, but worth an explicit re-check on this new page specifically.
- Worth confirming cross-user isolation holds (no new endpoint was added, so this should be a formality, not new risk) and that `/browse` never constructs or guesses an id client-side.
- Worth testing the viewer's mobile/narrow-viewport bottom-sheet behavior (`max-width: 720px`) since it wasn't part of this session's Playwright pass (default desktop viewport only).
