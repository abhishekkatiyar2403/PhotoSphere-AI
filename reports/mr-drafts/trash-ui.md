# MR: Trash page + /organize multi-select delete UI

**Branch:** `feature/ai-classification` (local only, not pushed)
**Commit:** `861ff25`
**Author:** Abhishek (no Claude trailer)

## What this builds

Frontend against the already-tested trash-system backend
(`specs/trash-system.md`, 173/173 backend suite) and the two picked
wireframes:

- `design/wireframes/trash-page.svg` (Option A — dedicated `/trash` page)
- `design/wireframes/multi-select-delete.svg` (Option A — checkbox-on-hover +
  bottom action bar, `/organize` only)

No backend file touched.

## 1. `frontend/src/app/trash/page.tsx` (new)

Owner-gated dedicated page (same `authApi.me()` → `/login` pattern as every
other authed page). Photos/Folders tabs, each row showing:

- days-remaining badge, urgent red styling once `daysRemaining <= 2`
- **Recover** button (`POST /api/photos/:id/restore` or
  `POST /api/folders/:id/restore`)
- **Delete forever** button — opens a real in-app confirm dialog (not
  `window.confirm`), red, explicit "cannot be undone" copy, calls
  `DELETE /api/trash/:type/:id`

**Empty trash** button up top opens its own stronger, red-bordered confirm
dialog (`.trash-danger-modal`) — states exactly how many photos/folders will
be purged, calls `DELETE /api/trash`.

**Restore-collision handling** — when a folder-restore 409s with
`{ error: "conflict", conflictingFolderId, conflictingFolderName }`, an
inline `CollisionPanel` renders under that row exactly per the wireframe:
"Merge into existing '\<name\>'" or "Rename & restore as '\<name\> (2)'"
(editable free-text before confirming). The SAME panel is reused for a
**photo restore** that auto-cascades into a trashed folder and hits the same
conflict shape — resolved by calling `foldersApi.restore` on the photo's own
`folderId` with the chosen `onConflict`, then retrying `photosApi.restore`.

Loading / empty ("Trash is empty") / per-row error states covered.

**Nav:** "Trash" link added to the top-bar nav on all 8 authed pages
(`dashboard`, `organize`, `browse`, `upload`, `share`, `guests`, `activity`,
`search`), positioned after Activity, matching each page's existing
`dashboard-guests-link` pattern and unique `data-testid` prefix convention.
`/activity` needed a slightly different insertion point since it renders its
own nav link as "active" rather than reusing the shared block.

## 2. `frontend/src/app/organize/page.tsx` — multi-select + delete

**Selection interactions implemented** (all via one `handleCardSelectClick`
+ marquee handlers on the grid container):

- **Hover** a card → its checkbox (`.organize-card-checkbox`, top-left)
  fades in via CSS (`opacity` on `:hover`/`:focus-visible`); stays visible
  once selected.
- **Plain click** on the checkbox area → toggles that card, replacing any
  other selection (conventional single-click-selects-one behavior). Clicking
  the *thumbnail* still opens the PhotoViewer — the two are separate buttons
  so they never collide.
- **Shift+click** → selects the contiguous range between `lastClickedId`
  (the last plain/ctrl click) and the clicked card, in the current `photos`
  grid order. Does not move the anchor.
- **Ctrl/Cmd+click** → toggles just that one card without clearing the rest
  of the selection, and does move the anchor.
- **Click-and-drag from empty grid space** (checked via
  `e.target === e.currentTarget` on mousedown, so starting on a card never
  triggers it) draws a fixed-position marquee rectangle
  (`.organize-marquee`). On mouseup, any card whose `getBoundingClientRect()`
  intersects the rectangle is selected. **Convention implemented (the
  modifier-aware extension, not just the plain-replace minimum):** a plain
  drag REPLACES the selection with what's under the box; holding
  Shift/Ctrl/Cmd at drag-start (`marqueeAdditiveRef`) ADDS to the existing
  selection instead — matches Finder/Explorer. A negligible drag (<3px) is
  treated as "clicked empty space" and clears the selection instead of
  running the marquee-intersection logic.
- **Select all on page** — button in the grid header, selects every id in
  the current `photos` array (current page only).
- **Select all N in this folder** — a secondary link, shown only when
  `total > photos.length` (i.e. the folder is paginated). Fetches every
  page's ids via repeated `folderPhotosApi.list`/`unfiledPhotosApi.list`
  calls (100 per chunk) for the CURRENT folder, then selects the union. On a
  fetch error it leaves whatever was already selected untouched rather than
  claiming a bigger selection than what actually got fetched — no
  fabricated "selected everything" state.
- Selection is cleared whenever the folder changes or the page changes
  (`useEffect` on `selectedFolderId`/`offset`) so Delete-selected can never
  silently target ids no longer on screen.

**Bottom action bar** (`.organize-selectbar`, fixed to the viewport bottom)
appears once `selectedIds.size > 0`: "N selected · Delete selected ·
Cancel".

**Delete selected confirm** — reversible copy: "Delete N photos? They'll
move to Trash and stay recoverable for 7 days." On confirm, calls
`POST /api/photos/bulk-delete`. **Partial-result handling (T2):** since the
backend reports every failure as a uniform `reason: "not_found"` (covering
not-owned/nonexistent/already-trashed/blocked-by-live-share — no way to
distinguish which), the UI shows: `"N deleted, M could not be deleted
(already gone or currently shared with a guest)"` when `failed.length > 0`,
or a plain "N photos moved to Trash." when everything succeeded. No
fabricated per-item reason. Successfully-deleted ids are removed from the
grid and the folder/Unfiled count is decremented; failed ids stay visible
untouched.

**New single-photo Delete action** — `/organize` cards had no per-photo
delete action before this pass (only Reclassify / "Not a duplicate?" / Move
existed). Added one (`onDeletePhoto`), same reversible "moved to Trash, 7
days" confirm copy, calling `DELETE /api/photos/:id`. On a 409 (T2 — the
photo's folder is live-shared) it shows a specific message: "This photo
can't be deleted — its folder is shared with a guest. Revoke the share
first." with a Go-to-Guests link, rather than a generic error — reusing the
existing `.organize-shared-block` styling from the folder-delete/merge F1
blocks.

**Stale `photosOrphaned` copy fix** — the existing single-folder "Delete
folder" confirm (P4) read a response field (`photosOrphaned`) that no
longer exists on the revised `DELETE /api/folders/:id`. Copy changed from
"N photos move to Unfiled — not deleted" to "This folder and its N photos
will move to Trash — they'll stay recoverable for 7 days" / "You can
recover the folder (and its photos) any time from Trash before then. After
7 days they're permanently deleted." Same reversible tone as the new
multi-select confirm, matching this task's explicit instruction (NOT
"moves to Unfiled" — that's no longer what happens).

## `api.ts` changes

- `ApiError` now carries the full parsed JSON error body (`.body`), not
  just `.message`/`.status` — needed to read the restore-collision 409's
  `conflictingFolderId`/`conflictingFolderName`. Purely additive; every
  existing call site only ever read `.message`/`.status`.
- Added `photosApi.remove`, `photosApi.bulkDelete`, `photosApi.restore`,
  `foldersApi.restore`, and a new `trashApi` (`list`/`purgeOne`/`emptyAll`).
- `DeleteFolderResponse` updated to `{ deleted, deletedAt, purgeAt }` (the
  `photosOrphaned` field is gone, matching the revised backend contract).
- Added `isRestoreConflict()` helper to detect the 409-conflict shape from a
  caught `ApiError`.

## Deviations / judgment calls (flagged, not buried)

- **"Select all across pages" fetch strategy**: implemented as a loop of
  100-per-page `folderPhotosApi`/`unfiledPhotosApi` calls rather than a
  dedicated backend "all ids" endpoint (none exists, and the task said not
  to touch the backend). For a very large folder this is N/100 sequential
  requests — acceptable for the current MVP scale, but flagged as a
  possible follow-up (a lightweight `GET .../ids`-only endpoint) if a real
  user hits a folder large enough to make this slow.
- **Bulk-delete partial-result UI granularity**: per the task's own
  instruction, the "shared vs. already-gone" distinction is NOT fabricated
  — the combined message is used since the backend genuinely can't tell
  which occurred.
- **Marquee drag threshold** (3px) is an arbitrary small constant to
  distinguish "clicked empty space" from "dragged a marquee" — not spec'd,
  a reasonable UX default.

## Verification

- `npm run typecheck -w frontend` — clean.
- `npm run lint -w frontend` — clean (0 warnings/errors).
- `npm run build -w frontend` — clean, built to an isolated `distDir`
  (`.next-verify`, via a temporarily-swapped `next.config.js`, reverted
  after) since `next dev` was live on the shared `.next`; `/trash` compiles
  and is listed in the route output alongside all other routes.
- **Live HTTP verification** (throwaway script, Prisma-seeded data + real
  signup/session cookie, deleted after the run, 0 residual rows):
  - Single photo delete → 200 with `deletedAt`/`purgeAt` → appeared in
    `GET /api/trash` → `POST /api/photos/:id/restore` → 200, restored.
  - Folder delete → 200. Created a new live folder with the SAME name to
    force a collision → `POST /api/folders/:id/restore` (no `onConflict`) →
    409 with the exact `{ error: "conflict", conflictingFolderId,
    conflictingFolderName }` shape the UI's `CollisionPanel` expects →
    resolved via `onConflict: "rename"` → 200, restored under the new name.
  - Bulk-delete with 2 valid ids + 1 nonexistent id → 200,
    `{ deleted: [...2 ids], failed: [{ id, reason: "not_found" }] }` — the
    exact partial-success shape the UI's "N deleted, M could not be
    deleted…" message is built on.
  - Permanent purge (`DELETE /api/trash/photo/:id`) → 200, removed from a
    follow-up `GET /api/trash`.
  - Empty trash (`DELETE /api/trash`) → 200,
    `{ emptied: true, photosDeleted, foldersDeleted }`.
- Did NOT run a browser/CDP click-through this pass (re-read the render
  logic post-edit as a substitute, consistent with recent Developer passes
  on this codebase given the harness's repeated stalls) — the underlying
  API contracts every interaction calls are now live-confirmed above, and
  the render code is build-clean. Flagged as the one honest gap, same
  category as several prior passes (P4/P5/P6, P7) — a belt-and-suspenders
  visual/interaction pass (marquee drag rendering, checkbox hover-fade,
  shift/ctrl-click in a real browser, the bottom bar's fixed positioning)
  remains outstanding.

## Files changed

- `frontend/src/app/trash/page.tsx` (new)
- `frontend/src/app/organize/page.tsx`
- `frontend/src/app/globals.css`
- `frontend/src/lib/api.ts`
- `frontend/src/app/{dashboard,browse,upload,share,guests,activity,search}/page.tsx`
  (nav link only)

---

## Addendum (commit `9aa2129`): photo-restore collision follow-up for backend commit `6443d87`

Backend revised `POST /api/photos/:id/restore` (specs/trash-system.md FINAL
DECISION 5, REVISED 2026-07-09) so restoring a single trashed photo whose
folder is also trashed **no longer cascades** into restoring that whole
folder — the original description above ("resolved by calling
`foldersApi.restore` on the photo's own `folderId`... then retrying
`photosApi.restore`") is now stale/wrong and is superseded by this
addendum. No backend file touched; 176/176 backend suite unaffected.

**`frontend/src/lib/api.ts`** — `photosApi.restore(photoId, opts?)` now
accepts `{ onConflict?: "existing" | "new", newName?: string }` and POSTs it
as the body. This is additive and distinct from `foldersApi.restore`'s
`"merge" | "rename"` vocabulary, which is untouched — the two endpoints
resolve genuinely different operations now.

**`frontend/src/app/trash/page.tsx`** — `resolvePhotoCollision()` now calls
`photosApi.restore(photoId, { onConflict, newName })` directly instead of
`foldersApi.restore(...)`. `PhotoCollisionState` was reshaped to
`{ conflictingFolderId, conflictingFolderName, customizingNewName,
newNameDraft, busy, error }` (no more `photoFolderId`/`renaming`/
`renameDraft` — those were the folder-restore vocabulary leaking into the
photo case). A new `PhotoCollisionPanel` component (forked from the shared
`CollisionPanel`, which remains unchanged and folder-restore-only) renders
different copy:

- **"Put it in the existing '\<name\>' folder"** → `onConflict: "existing"`
- **"Create a new folder for it"** → `onConflict: "new"`, no name (backend
  auto-generates `"<name> (recovered)"`-style)
- **"Name the new folder myself…"** → reveals a text input, still
  `onConflict: "new"` but with the caller's `newName`

Copy explicitly says the photo's original trashed folder "is still in the
trash and won't be restored" — the collision panel's title also dropped the
"Can't recover" framing (accurate for a folder-restore block, inaccurate
here since the photo restore isn't blocked, just needs a choice).

On success (either choice, or the plain no-conflict path), the photo is
removed from the Trash list as before, plus a small auto-dismissing toast
(`.trash-restore-toast`, 4s) shows which folder it landed in, using the
`folder.name` already returned by the restore response — no new backend
field needed.

**Verification:** `npm run typecheck -w frontend` clean, `npm run lint -w
frontend` clean, `npm run build -w frontend` clean (isolated `distDir` via a
temporary `next.config.js` swap since `next dev` was live on the shared
`.next` — restored the original config after, `git diff` on it is empty).
Did not live-check against a running backend API process this pass (only
the Docker infra containers — postgres/redis/minio — were up, no backend
process listening on :4000); relying on the backend's own 176/176 suite for
the endpoint contract and this addendum's build/typecheck/lint pass plus a
careful re-read of the new render/state code as the substitute, same
category of gap as prior passes' un-browser-verified UI work.
