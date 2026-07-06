# MR: Frontend UIs for the deferred P4 / P5 / P6 features

**Branch:** `feature/ai-classification` (local only — do NOT push without a fresh go-ahead)
**Author:** Abhishek Katiyar (no `Co-Authored-By: Claude` trailer)
**Spec:** `specs/folder-mgmt-download-search.md` (all three backends already built + Tester-verified, 208 assertions clean, `reports/2026-07-06_1810.md`)
**Design records:** `design/wireframes/folder-mgmt.svg` (P4, Option A), `design/wireframes/search.svg` (P6, Option A); P5 is a thin button (no wireframe).

## Scope

Frontend only. **No backend file was modified** — every call hits an already-built, Tester-verified endpoint. This MR wires the UI to the P4 (folder rename/merge/delete), P5 (bulk download-all), and P6 (basic search) backends.

## Files changed

- `frontend/src/lib/api.ts` — added `foldersApi.rename/merge/remove` (+ `RenamedFolder`/`MergeFolderResponse`/`DeleteFolderResponse` types), `downloadAllApi.ownerFolderUrl/guestFolderUrl` (P5 — returns the credentialed endpoint URL to navigate to, NOT a fetch), and `searchApi.search` (+ `SEARCH_CATEGORIES`, `SearchCategory`, `SearchParams`, `SearchResponse`).
- `frontend/src/app/organize/page.tsx` — P4 per-folder kebab menu (Rename / Merge into… / Download all / Delete folder), inline rename, merge dialog, delete confirm dialog; P5 owner "Download all" button on the folder header.
- `frontend/src/app/browse/page.tsx` — P5 owner "Download all" button on the folder header.
- `frontend/src/app/g/[token]/page.tsx` — P5 guest "Download all" button, gated on the selected folder's `permissionLevel === "download_all"`.
- `frontend/src/app/search/page.tsx` — **new** — the dedicated `/search` page (P6).
- `frontend/src/app/dashboard/page.tsx`, `frontend/src/app/activity/page.tsx` — added the "Search" top-bar nav link (beside Guests/Activity). The `/search` page itself also carries the full nav (Browse / Search-active / Guests / Activity).
- `frontend/src/app/globals.css` — new classes for the kebab menu, inline rename, merge/delete modals, the F1 shared-block, the download-all buttons, and the `/search` page (reusing the `.activity-*` filter-bar patterns + the `.organize-grid` cards).

## P4 — folder rename / merge / delete (`/organize`)

Per `folder-mgmt.svg` (Option A): each real sidebar folder row gets a hover/expand `⋯` kebab → a menu with **Rename / Merge into… / Download all / Delete folder**. The virtual "Unfiled" row has no kebab (it isn't a real folder). Kebabs appear on AI-generated folders too (F5).

- **Rename** — inline edit replaces the row (autofocus, Enter=save / Esc=cancel). Empty/whitespace disables Save (client) and the backend also 400s. A colliding name → **409 surfaced inline** as "A folder with that name already exists". On success the row is renamed and the list re-sorted.
- **Merge** — a modal: a destination `<select>` of the owner's **other** folders in the collection (all `folders` minus the source), the consequence copy ("All N photos move to the destination; '<src>' is then removed"), Merge/Cancel. **On 409 the modal flips to the shared-with-guest block** — "Can't merge — this folder is shared with a guest … Revoke the share first, then merge", "Server returned 409. Nothing was moved or deleted", and a **"Go to Guests →" link to `/guests`**. On success the modal closes and the tree + counts refresh from the server (`loadFolders`), and if the removed source was selected, selection falls back to the first remaining folder (or Unfiled).
- **Delete** — a confirm modal whose load-bearing reassurance is **"The N photos in this folder will move to Unfiled — they are not deleted"** + "You can re-file them any time from the Unfiled bucket. Only the folder is removed." **On 409 the same shared-with-guest block** appears (with the Guests link). On success the tree refreshes; the deleted folder's photos now appear in the Unfiled bucket (which already renders from `GET /api/photos/unfiled`).

**How the 409 shared-block is surfaced:** both the merge and delete dialogs hold a `mergeBlocked`/`deleteBlocked` flag set only on an `ApiError` with `status === 409`; the flag swaps the dialog body to the red-edged block with the copy above and the `/guests` link. Nothing is refreshed on a 409 (nothing changed server-side).

**How the Unfiled-confirm is surfaced:** the delete dialog always shows the "photos move to Unfiled — not deleted" callout before the destructive Delete button (the `photoCount` is interpolated into the copy).

## P5 — bulk "download all"

**How the zip download is triggered:** a **credentialed top-level browser navigation** to the streaming endpoint (`window.location.assign(url)`), NOT a `fetch`-into-memory. `downloadAllApi.ownerFolderUrl/guestFolderUrl` return the absolute endpoint URL; the browser issues a normal authenticated GET and, seeing `Content-Disposition: attachment`, saves the zip. The session cookie (owner) / guest-session cookie (guest) rides the same-origin navigation automatically — the same credential behavior `credentials:"include"` gives `apiFetch`, without pulling bytes into JS.

- **Owner** — "Download all" button on the folder header in both `/organize` and `/browse`, shown for **real folders only** (not the virtual Unfiled bucket) and **only when the folder has photos** (`photoCount > 0`), pre-guarding the obvious empty case (the backend still 400s an empty folder / 409s an over-cap one if reached). The `/organize` kebab menu also carries a "Download all" item (disabled at 0 photos).
- **Guest** — "Download all" button on the guest portal folder header, shown **only when the selected folder's `permissionLevel === "download_all"`** (Z1) AND it has photos. The `download_all` level is already exposed per-folder in the `GET /api/guest/folders` response (the `GuestFolder.permissionLevel` field), so no backend change was needed for the gate. A `download`- or `view`-only guest never sees the button, and the backend independently 403s the bulk endpoint for them.

**Guest per-folder permission level: EXPOSED** — no gap. `guestPortalApi.folders()` already returns `permissionLevel` per folder, so the P5 guest-button gate reads it directly.

## P6 — dedicated `/search` page

Per `search.svg` (Option A): owner-authed (same `authApi.me()` gate as `/activity`/`/dashboard`, `/login` on 401). A filter bar — filename text, from/to date, folder `<select>` (All folders / Unfiled / the owner's folders), category `<select>` (Any category + the 8 categories) — with **Search** and **Clear**. Draft/applied filter split (typing doesn't refetch until Search, matching `/activity`). Results render in the existing `.organize-grid` photo-card grid + the shared `PhotoViewer` on thumbnail click. Pagination ("Showing X–Y of total" + Prev/Next). Loading / no-results / error states, with the `cancelled` stale-guard on the fetch. An empty query returns the whole library newest-first (backend S6). Bad input (limit>100, from>to, bad category) → the backend 400 surfaces as the error state.

**Nav placement:** a "Search" link was added to the top bar on `/dashboard` and `/activity` (beside Guests/Activity). The `/search` page's own top bar carries the full nav set (Browse / Search[active] / Guests / Activity / user / Log out).

## Verification

- `npm run typecheck -w frontend` — clean.
- `npm run lint -w frontend` — clean (no warnings/errors).
- `npm run build -w frontend` — clean, `/search` route present (built to an isolated `.next-verify` dir via a temporary `NEXT_DIST_DIR` config hook so the live `next dev` `.next` manifest was never touched; the temp dir + config/tsconfig edits were reverted afterward).
- **Live drive (Prisma-seeded owner + folders + a `download_all` guest share on a folder, driven over HTTP with a minted session cookie):** rename collision→409 / empty→400 / ok→200(name updated); merge A(3)→B(2)→200 moved=3 targetCount=5; **merge & delete of the live-shared folder→409** with the exact shared-block message (nothing moved); after revoking the share, delete→200 orphaned=4 and those 4 photos surface in `GET /api/photos/unfiled` (total=4); search q=nature→3, limit=101→400, folderId=unfiled→4, empty→whole library 9; owner download-all empty→400, not-owned→404. All seed data cleaned up (0 residual `uidrv` rows confirmed).
- Unauthenticated: `/api/search`→401, both download-all endpoints→401, `/search` page serves 200 (client gate redirects to `/login` on the `me()` 401).

## Deviations

None. The guest per-folder permission level required for the P5 guest-button gate **is** exposed (`GuestFolder.permissionLevel`), so no flag was needed. The `next build` was run against an isolated dist dir to avoid corrupting the live `next dev` manifest (per the build brief); the temporary config hook was reverted.
