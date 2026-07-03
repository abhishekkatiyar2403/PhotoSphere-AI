# MR: Dashboard page (Option B — storage-meter hero + folder tiles)

**Branch:** `feature/ai-classification` → `main`
**Commit:** `064cc26`
**Spec:** `specs/week7-8-dashboard-browser-viewer.md` (Dashboard page section)
**Design record:** `design/wireframes/dashboard.svg` (Option B, picked by Abhishek)

## Summary

Replaces the Week 1–2 auth-proof placeholder at `/dashboard` ("Welcome, {name}" + logout) with the real Dashboard page, the last remaining Week 7–8 screen. Follows the picked Option B layout:

- **Storage hero:** `STORAGE` label, large "X of Y used" heading (bytes formatted human-readably client-side), a horizontal progress bar filled to `usedPercent`, and "N% used" / "N photos total" captions.
- **Jump to a folder:** a grid of folder shortcut tiles (thumbnail placeholder, folder name, photo count), a stand-out (pink) **Unfiled** tile shown only when unfiled items exist, and a dashed **View all folders →** tile linking to `/browse`.
- **At a glance:** "N folders · N collections · N photos total" recap.

The logout affordance from the old placeholder is folded into the shared top bar (no persistent nav shell exists yet — Option C was explicitly deferred).

## Data assembly — Option 1 (no backend change)

The Option B tiles are per-**folder**, but `GET /api/dashboard` only returns per-**collection** aggregates. Chose **Option 1** (assemble on the client from already-shipped endpoints) over a backend change:

- `GET /api/dashboard` → storage hero + totals recap.
- `GET /api/collections` → default collection id → `GET /api/collections/:id/folders` → the per-folder tiles.
- `GET /api/photos/unfiled` (`limit=1`, only `total` needed) → the Unfiled tile count.

This is the same multi-fetch-on-mount pattern `/organize` and `/browse` already use, reuses shipped endpoints unchanged, and keeps the backend untouched. No concrete reason Option 1 fails, so no additive backend change was made and the backend test suite was not run (backend not touched).

## Files touched

- `frontend/src/app/dashboard/page.tsx` — **replaces** the placeholder stub; new Option B page. `formatBytes` (binary units, parses string→number defensively, "0 B" for zero/NaN), `formatCount` (locale grouping), pluralization helpers, stale-response guard (`cancelled` flag) on the multi-fetch effect.
- `frontend/src/lib/api.ts` — adds `dashboardApi.get()` + `DashboardStats` type (following the `collectionsApi`/`foldersApi` pattern).
- `frontend/src/app/globals.css` — new `.dashboard-*` classes (reuse `.organize-topbar` and the existing `--color-*` tokens — no new palette); removed the now-orphaned `.dashboard-shell`/`.logout-button` the old stub used.
- `frontend/src/app/browse/page.tsx` — **enabling change:** minimal `?folder=<id>` support so dashboard tiles land on the right folder. Reads `useSearchParams` (page shell wrapped in `<Suspense>` per Next 14), honors the target once on initial load (real folder id in the loaded list, or the `__unfiled__` sentinel), otherwise falls back to the first folder as before. Never overrides a later user click.
- `design/wireframes/dashboard.svg` — the picked design record, committed unmodified so it's version-controlled alongside the implementation.

## Testing notes

- `npm run typecheck -w frontend` → clean. `npm run lint -w frontend` → "No ESLint warnings or errors". Backend untouched (no backend typecheck/lint/test run).
- **Live browser (Playwright, real backend + seeded data):**
  - *Populated* (`clsf.a.20260703`: 19 photos / 8 folders / 3 unfiled) — hero "106.2 KB of 5.0 GB used", 8 folder tiles with correct singular/plural counts, pink Unfiled tile "3 need attention", dashed View-all tile, glance "8 folders · 1 collection · 19 photos total". All tile `href`s correctly `encodeURIComponent`'d.
  - *Tile deep-link* — clicking the Food tile navigated to `/browse?folder=<Food-id>`; `/browse` selected the Food folder (active sidebar row + main heading = "Food") and loaded its 3 photos.
  - *Empty state* (fresh signup, zero data) — "0 B of 5.0 GB used", 0% meter (width `0%`, no NaN), "No photos yet — upload one to get started.", "0 folders · 0 collections · 0 photos total". No crash.

## Deviations from wireframe/spec

- **`?folder=` support added to `/browse`.** The build brief said "only build the Dashboard page," but the spec/AC require tiles to link "at the right folder," which `/browse` couldn't previously honor. Added the minimal enabling param support rather than dropping the requirement. Flagged for review — it's a small, additive change (the dashboard is its only caller), not a rebuild of `/browse`.
- **Storage meter fill reflects real data, not the wireframe's 62%.** Seeded users have tiny storage relative to the 5 GB limit, so the live meter renders near-empty. This is correct behavior against real `usedPercent`; the 62% in the SVG was illustrative.
- **Unfiled caption phrasing** matches the wireframe's "N need attention" (with "1 needs attention" for the singular case).

## Not done (out of scope, as instructed)

Rest of Week 7–8 (dashboard-stats endpoint, upload polish, `/browse`, PhotoViewer) already shipped/tested. This MR is the Dashboard page only.
