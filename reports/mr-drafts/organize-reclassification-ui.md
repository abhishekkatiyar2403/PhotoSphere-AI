# MR Draft: Reclassification / Organize UI (Option A)

**Branch:** `feature/ai-classification` (continued)
**Status:** ready for review/merge once GitHub remote work resumes (not pushed)

## Title

feat: build the reclassification/organize UI (Option A) + close two backend gaps it exposed

## Summary

Builds the manual reclassification UI that was left blocked in the
AI-classification cycle (`specs/ai-classification.md`), per Abhishek's pick
of **Option A** (sidebar folder tree + thumbnail grid, per-card "Move to…"
dropdown, inline folder creation) — design record at
`design/wireframes/reclassify-ui.svg`.

While building against the already-shipped backend, found that `failed` and
`duplicate` photos are **structurally invisible** to `GET
/api/folders/:id/photos` (both always have `folderId: null` — the dedup gate
short-circuits before folder assignment for duplicates, and a failed
pipeline job never reaches folder assignment at all), yet the wireframe
requires them to be visible and actionable in the main grid. Closed this
with a minimal additive backend change (see "Backend changes" below) rather
than fake the requirement or drop it silently.

## Files touched

**New:**
- `frontend/src/app/organize/page.tsx` — the page itself.
- `design/wireframes/reclassify-ui.svg` — committed for the first time (was
  sitting untracked as the design record from the earlier cycle's pick).

**Frontend, modified:**
- `frontend/src/lib/api.ts` — added `collectionsApi`, `foldersApi`,
  `folderPhotosApi`, `unfiledPhotosApi`, and `photosApi.move`/`.reclassify`.
  Same `apiFetch`/`ApiError`/`credentials: "include"` conventions as the
  existing `authApi`/`photosApi`.
- `frontend/src/app/globals.css` — added `.organize-*` classes reusing the
  existing `--color-*` CSS variables (no new palette).

**Backend, modified (additive only — see rationale below):**
- `backend/src/routes/folders.ts` — extracted `PHOTO_CARD_SELECT`/
  `toPhotoCard` (now exported) so the photo-card list shape is shared with
  the new endpoint below; added `duplicateOfPhotoId`/`dedupMethod` to the
  card response (both null unless status is `duplicate`).
- `backend/src/routes/collections.ts` — new `GET
  /api/collections/:id/unfiled-photos` endpoint (paginated, same shape as
  `GET /api/folders/:id/photos`), scoped to `ownerId` + `folderId: null` +
  `status IN (failed, duplicate)`.
- `backend/src/routes/photos.ts` — `GET /api/photos/:id` now additionally
  returns `originalFilename` (was previously omitted from that endpoint
  entirely; needed so a duplicate card can show "duplicate of X.jpg" instead
  of a raw photo id).

## Why the backend change was needed (flagging per process — Master should know)

1. **The "Unfiled" gap.** `failed`/`duplicate` photos have `folderId: null`
   by design (confirmed by reading `worker.ts` directly — the dedup gate
   short-circuits *before* folder assignment for duplicates; a failed
   pipeline job never reaches the folder-assignment step at all). No
   existing endpoint lists a user's photos outside of a specific folder.
   The wireframe's grid shows failed/duplicate cards mixed into a folder's
   view; the real backend has no folder to put them in. Fixed with a new,
   additive-only endpoint (`GET /api/collections/:id/unfiled-photos`)
   surfaced in the UI as a virtual "Unfiled" sidebar row (rendered only when
   its count is > 0), sharing the exact same card shape, pagination
   contract, and ownership-check pattern (404-not-403) as every other
   endpoint in this codebase. Deliberately excludes `pending`/`processing`
   (no wireframe state for "still working," and they resolve into a real
   folder or this bucket within seconds on their own).
2. **Duplicate-of-original filename.** The list endpoints never carried
   `duplicateOfPhotoId`/`dedupMethod` (confirmed by reading the route code,
   per the build brief's explicit instruction not to assume). Added both,
   additively, to the shared `toPhotoCard` mapper so both
   `GET /api/folders/:id/photos` and the new unfiled-photos endpoint return
   them. Resolving the *original's filename* for the "duplicate of X.jpg"
   label still needs one extra per-card fetch (`GET /api/photos/:id`) — but
   that endpoint had never exposed `originalFilename` either (an
   accidental omission from the earlier EXIF-exposure pass, not a
   deliberate one), so it's now additive there too.

Both changes are pure additions (new fields, new route) — nothing existing
was renamed, removed, or had its behavior changed. `npm run test -w backend`
run twice back-to-back under `NODE_ENV=test`: **52/52 both times**, no
regressions, no flake.

## What the page does

- Auth-gated the same way as `/dashboard` and `/upload`: `authApi.me()` on
  mount, redirect to `/login` on any 401 (including mid-session, from any
  subsequent call — every handler checks `isAuthError` and redirects rather
  than surfacing a raw error).
- Sidebar: fetches the default collection (`GET /api/collections`, first
  `isDefault` or first entry), then its folders (`GET
  /api/collections/:id/folders`) plus the Unfiled count (`GET
  .../unfiled-photos?limit=1`, using only `.total`). Clicking a row loads
  that folder's (or Unfiled's) photos into the main grid, paginated
  (`limit=12`, matching the wireframe's "Showing X–Y of Z" language).
- Inline folder creation: text input + Add button per the wireframe. Handles
  409 (duplicate name) and 400 (invalid name) with an inline error under the
  input; success appends the new folder to the sidebar list (kept sorted).
- Photo cards, three states exactly per the wireframe:
  - **Normal (`done`):** thumbnail, filename, `labels · confidence`, a real
    `<select>` "Move to…" populated from every *other* folder in the
    sidebar. Selecting a target calls `PATCH /api/photos/:id`, removes the
    card from the current grid, and reconciles both folders' visible counts
    locally (server guarantees an exact ±1 pair on success, so this is safe
    without a full refetch).
  - **`failed` (red border, only reachable via Unfiled):** "classification
    failed" + a "Reclassify" button.
  - **`duplicate` (amber border, only reachable via Unfiled):** "duplicate
    of {original filename} ({method})" + a "Not a duplicate?" button (same
    handler as Reclassify — the backend's reclassify endpoint already clears
    the duplicate verdict).
  - Both buttons call `POST /api/photos/:id/reclassify`, then poll `GET
    /api/photos/:id/status` every 2s until a terminal status, same pattern
    `/upload` already uses — no full page reload.

## Race conditions considered (self-review, no separate review pass this cycle)

- **Move + reclassify-poll racing the same photo.** If a reclassify poll is
  in flight and the user moves that card (impossible via the UI today since
  Unfiled cards don't show a Move dropdown, but defended anyway): `handleMove`
  calls `stopPoll(photoId)` before removing the card, so a later poll tick
  can't resurrect a moved-away card into the wrong grid.
- **Reclassify poll resolving after the folder view changed.** The poll
  captures `folderAtPollStart` from a ref (not state, to avoid a stale
  closure) at the moment reclassify was triggered; every tick re-checks the
  *current* `selectedFolderIdRef` and silently stops if the user navigated
  away, instead of writing into unrelated grid state.
- **Double-enqueue on rapid double-click of Reclassify/"Not a duplicate?".**
  The button is `disabled` the instant the click handler sets
  `reclassifying: true` (before the network call resolves), and
  `stopPoll(photoId)` is called before starting a new interval, so a second
  click before the first poll starts can't create two overlapping intervals.
  The backend's own atomic-claim 409 (documented in Day2.md) is the final
  backstop regardless.
- **Stale grid-fetch responses.** `gridRequestIdRef` increments on every
  `loadFolderPhotos` call; any in-flight fetch (including the async
  duplicate-label resolution it kicks off) checks its captured request id
  against the current one before writing state, so rapidly clicking between
  folders can't have an old folder's response land after a newer one.
- **Unmount cleanup.** All in-flight poll intervals are cleared in a
  `useEffect` cleanup (capturing the `Map` in a local variable per the
  ESLint `react-hooks/exhaustive-deps` fix, not reading `.current` inside
  the returned cleanup closure).

## Deviations from the wireframe

- **Wireframe shows failed/duplicate cards inline within a normal folder's
  grid (e.g. mixed into "Food").** Built instead as a separate "Unfiled"
  sidebar row, for the structural reason above (those photos have no
  `folderId`, so they can't literally be "in" the Food folder's grid). This
  preserves every interaction the wireframe specifies (Reclassify /
  "Not a duplicate?", same card styling) — it just relocates *where* those
  cards live in the navigation, which the wireframe's functional
  requirements don't actually pin down (the spec's own functional
  requirements list doesn't say where failed/duplicate cards must appear,
  only that they must be reachable and actionable).
- Everything else (colors, card layout, sidebar counts, inline folder
  creation, pagination copy) follows the wireframe closely, using the app's
  existing `--color-*` CSS variables instead of the wireframe's raw hex
  values (they were already an exact or near-exact match:
  `--color-primary: #3057d5` = wireframe's top bar/accent color,
  `--color-border: #dfe3e8` ≈ wireframe's `#dde1e8`, etc.).

## Testing

- `npm run typecheck -w frontend` — clean.
- `npm run typecheck -w backend` — clean.
- `npm run lint -w frontend` — clean (0 warnings after fixing one
  `react-hooks/exhaustive-deps` ref-cleanup warning found during self-review).
- `NODE_ENV=test npm run test -w backend` — **52/52, run twice back-to-back**,
  no regressions from the additive route/field changes.
- Manual live-browser verification (Playwright driving the actual running
  dev stack, backend :4000 / frontend :3000 / worker running, MinIO/Postgres/
  Redis via Docker Compose) — screenshots captured, not just described:
  - Uploaded `fixture-food.jpg`, a byte-identical copy of it (→ `duplicate`
    via sha256), `fixture-animals.jpg`, and a `FORCE_FAIL_` copy of
    `fixture-nature.jpg`.
  - Sidebar rendered `Food (1)`, `Animals (1)`, `Unfiled (2)` correctly.
  - Opened Food, moved `fixture-food.jpg` to Animals via the dropdown:
    card disappeared from Food's grid, Animals' count went 1 → 2 live, no
    reload.
  - Created folder "Vacation 2026" inline — appeared in the sidebar
    immediately. Tried creating it again — inline "A folder with this name
    already exists" error shown, folder list unchanged (409 handled).
  - Opened Unfiled: saw the red-bordered failed card ("classification
    failed" + Reclassify) and the amber-bordered duplicate card ("duplicate
    of fixture-food.jpg (sha256)" + "Not a duplicate?"), matching the
    wireframe's visual language.
  - Clicked Reclassify on the failed card: button changed to
    "Reclassifying…" immediately, then within ~7s (worker's 3-attempt
    backoff before the hook was recognized as not applying to reclassify
    jobs, then classify) the card disappeared from Unfiled, Unfiled's count
    dropped 2 → 1, and a new "Nature" folder appeared in the sidebar with
    count 1 — confirmed via the status endpoint the photo actually reached
    `done` with a real folder assignment.
  - Clicked "Not a duplicate?" on the remaining duplicate card: resolved to
    `done` in "Food" with `duplicateOfPhotoId` cleared (confirmed via the
    status endpoint directly), card disappeared from Unfiled, Unfiled's row
    disappeared entirely from the sidebar (count reached 0).
  - Confirmed cross-user isolation and validation on the new endpoint via
    curl: no session → 401; another user's collection id → 404 (never 403);
    owner's own → 200; `limit=500` → 400 (Zod, same as the existing
    `folderPhotosQuerySchema`).

## Known gaps / follow-ups

- The "Unfiled" bucket is new UI surface not covered by
  `specs/ai-classification.md`'s original acceptance criteria (it predates
  this gap being discovered) — flagging so Tester knows to exercise it
  explicitly rather than only the originally-specced folder flows.
- No automated frontend test exists for this page yet (no Playwright/frontend
  test infra in this repo currently — same gap as `/upload` and `/dashboard`).
  Verified manually via Playwright driving the live dev stack instead,
  screenshots retained for this cycle's review.
- `resolveDuplicateLabel`'s per-card `GET /api/photos/:id` fetch for the
  original's filename is one request per duplicate card per page load —
  fine at the current `limit=12` scale, would want a batched lookup if
  duplicate volume grows significantly.
