# Spec — Week 7–8 Remainder: Dashboard Page, Folder Browser (read-only), Photo Viewer

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 7 (Phase 1 — MVP, Week 7–8: Core UI — "Dashboard: collection overview, storage usage", "Folder browser: grid view of photos per category", "Photo viewer: fullscreen, EXIF info panel" bullets; "Upload flow: drag & drop with progress bar" already shipped in `specs/dashboard-stats-and-upload-polish.md`)
**Status:** draft
**Written by:** Planner Agent, 2026-07-03

## Problem

Week 7–8's checklist has four screens. Upload-flow polish is shipped. `GET /api/dashboard` (the stats aggregation) is shipped. What's left is entirely UI: a real Dashboard page (today's `/dashboard` is still the Week 1–2 placeholder — "Welcome, {name}" and a logout button, per `frontend/src/app/dashboard/page.tsx`), a Folder browser, and a Photo viewer.

Per Pending Decision 13 in `agents/STATUS.md`, the folder browser is meant to inherit Option A's sidebar+grid pattern (`design/wireframes/reclassify-ui.svg`) rather than get its own wireframe round — that inheritance is now buildable, since Option A shipped as `/organize` and proved out the pattern (including the "Unfiled" bucket concept a mid-cycle bug surfaced). The Dashboard page, by contrast, is a genuinely new layout question with no existing pattern to inherit — Pending Decision 0.5 flags it as needing a small wireframe round. The Photo viewer sits in between: new visual surface, but low layout ambiguity once judged against the same "is this a new screen with a real design question, or an interaction added to an already-decided surface" test CLAUDE.md applies.

This spec scopes all three, split cleanly by what's buildable now vs. blocked on Abhishek's wireframe pick, so Developer has an unambiguous next build the moment the pick lands (or immediately, for the two pieces judged not to need one).

## Goals

- **Folder browser**: a read-only variant of the `/organize` page's browsing half — sidebar of folders + Unfiled, thumbnail grid, pagination — with every move/reclassify/create-folder action removed. Buildable now, no new backend work, no new wireframe.
- **Photo viewer**: fullscreen image + EXIF panel, reachable from a grid thumbnail (in both the folder browser and, arguably, `/organize`). Buildable now as a direct interaction spec — judged low-ambiguity, not run through the SVG-wireframe-options process (see "Photo viewer: wireframe judgment" below for the reasoning).
- **Dashboard page**: explicitly deferred pending Abhishek's SVG-wireframe pick. This spec documents the functional requirements (so Developer can build immediately once a pick lands) and separately proposes 2–3 wireframe options for that pick — surfaced in Planner's handoff summary, not built into any file, per protocol (Master relays to Abhishek; the chosen option becomes the design record at `design/wireframes/dashboard.svg` once picked, the same pattern as `reclassify-ui.svg`).

## Non-goals (explicitly out of scope for this pass)

- **Dashboard page implementation.** Blocked on the wireframe pick — see "Blocked / deferred" below. This spec's Dashboard scope is limited to functional requirements + the wireframe options for Abhishek to choose from.
- **Any move/reclassify/create-folder actions in the folder browser.** Those already exist at `/organize` — this is deliberately the read-only subset. No "Move to…" dropdown, no Reclassify/"Not a duplicate?" buttons, no inline folder-creation input.
- **Deleting `/organize` or merging it with the folder browser.** `/organize` stays as the manage/reclassify surface (Week 5–6 tool); the folder browser is a separate, simpler browsing surface (Week 7–8 deliverable). See "Folder browser: route/mode decision" for why these stay two routes rather than one.
- **Photo viewer navigation across folders/collections** (e.g. "next photo" spanning a folder boundary). In-scope nav is next/previous *within the currently-loaded page of photos* only (see Acceptance Criteria) — spanning pagination boundaries or folders is a possible follow-up, not this pass.
- **Bulk actions, multi-select, download-all** — not part of any of the three screens this pass.
- **Any new backend endpoint or field.** Confirmed by reading `backend/src/routes/photos.ts`, `collections.ts`, `folders.ts`, and `dashboard.ts` directly (not assumed) — everything needed for all three screens already exists and ships unchanged. See "Confirmed: no new backend work needed" below.
- **Duplicate-detection warning before upload** — separate Week 7–8 bullet, not addressed here (unchanged from the prior spec's Non-goals).
- **Collections CRUD, folder rename/merge/delete** — still deferred (unchanged from prior specs).

## Confirmed: no new backend work needed

Read directly, not assumed:

- `GET /api/collections` → `{ collections: [{ id, name, isDefault, createdAt }] }` (`backend/src/routes/collections.ts`).
- `GET /api/collections/:id/folders` → `{ folders: [{ id, name, categoryType, photoCount, createdAt }] }`, sorted by name (same file).
- `GET /api/folders/:id/photos` → `{ photos: [{ id, originalFilename, status, aiLabels, aiConfidence, duplicateOfPhotoId, dedupMethod, thumbnailUrl }], total, limit, offset }`, paginated, newest-first, 404-not-403 ownership check (`backend/src/routes/folders.ts`, shared shape via `lib/photoCard.ts`'s `PHOTO_CARD_SELECT`/`toPhotoCard`).
- `GET /api/photos/unfiled` → same shape as above, **user-scoped, no collection dependency** — confirmed this is the endpoint the folder browser should use for its Unfiled row (not the older `GET /api/collections/:id/unfiled-photos`, which requires a collection id and was superseded in the frontend by this one for exactly the reason documented in `reports/mr-drafts/organize-reclassification-ui.md`'s addendum: a brand-new user's first-ever failed/duplicate photo can exist with zero collections ever created).
- `GET /api/photos/:id` → pre-signed `original.url` (60s TTL), `thumbnails` (keyed by size, 150/400/1200), full `exif` object (`takenAt`, `gpsLat`, `gpsLng`, `cameraMake`, `cameraModel`), `folder` (`{ id, name } | null`), `collectionId`, `status`, `originalFilename` (`backend/src/routes/photos.ts`). This is everything a fullscreen viewer + EXIF panel needs in one call — no new field required.
- `GET /api/photos/:id/status` → `aiLabels`, `aiConfidence`, `duplicateOfPhotoId`, `dedupMethod`, `job` — available if the viewer wants to surface classification detail too (optional, not required by this spec's acceptance criteria).
- `GET /api/dashboard` → `{ storage: { usedBytes, limitBytes, usedPercent }, totals: { photoCount, folderCount, collectionCount }, collections: [{ id, name, isDefault, folderCount, photoCount }] }` (`backend/src/routes/dashboard.ts`) — exact shape confirmed against the live route, matches `specs/dashboard-stats-and-upload-polish.md`'s spec verbatim.

All four screens (`/organize`, folder browser, photo viewer, dashboard) can be built entirely against what's shipped today.

## Scope for this pass

### Buildable now (no new UI decision needed)

#### 1. Folder browser

**Route/mode decision: a new route, `/browse`, not a mode within `/organize`.**

Reasoning (read `frontend/src/app/organize/page.tsx` in full before deciding):

- `/organize`'s state model is built around *editable* grid state — every `CardState` carries `moving`/`reclassifying`/`actionError`, every card render branches on those to show a dropdown or a button, and the move/reclassify handlers (`handleMove`, `handleReclassify`, `stopPoll`, the poll-timer `Map`, `refreshSidebarAfterReclassify`) are woven through the same component that would need a "read-only mode" flag threaded through every one of them. Retrofitting a boolean like `readOnly` into this component means every action branch (three separate places: move `<select>`, Reclassify button, "Not a duplicate?" button, plus the inline folder-creation form) needs a conditional, and every one of the race-condition defenses documented in the MR draft (stale-poll guards, stale-grid-fetch guards, unmount cleanup) stays live and untested code even when unused — more surface area for a bug to hide in the "read-only" path than a fresh component has.
- A `/browse` page is a strict *subset* of `/organize`'s data-fetching logic (sidebar + grid load, pagination, Unfiled row) with zero of the mutation logic — it can be a much smaller, simpler component (no poll timers, no request-id guards beyond the grid-fetch race which is still needed for pagination clicks, no action-error state per card). Simpler code for a simpler screen, rather than a feature-flagged superset.
- Two distinct routes also map cleanly onto two distinct product moments: `/organize` is "I have a failed/duplicate photo, or I want to reorganize something" (an active, occasional maintenance task); `/browse` is "show me my photos" (the everyday, likely more-visited, more casual entry point — e.g. clicked from the Dashboard's collection list, once that's built). Conflating them into one route with a mode toggle adds a UI decision of its own (where does the toggle live, what does it look like) that a second route avoids entirely.
- Cost of two routes: some duplicated fetch/pagination/card-rendering logic between `/organize` and `/browse`. Acceptable at this scale (two pages, one component each) — a shared hook/component extraction (e.g. `useFolderBrowser`, a shared `<PhotoGrid>`) is a reasonable future refactor once both exist and the actual duplication is visible, not a reason to block this pass on doing that extraction first.

**What `/browse` does:**
- Auth-gated identically to `/organize`/`/dashboard`/`/upload` (`authApi.me()` on mount, redirect to `/login` on 401).
- Sidebar: same data source and rendering as `/organize`'s sidebar (`GET /api/collections` → default collection → `GET /api/collections/:id/folders`, plus `GET /api/photos/unfiled` for the Unfiled row's count, rendered only when count > 0) — but no inline folder-creation form.
- Clicking a folder (or Unfiled) row loads its photos into the main grid, paginated identically to `/organize` (`limit=12`, `GET /api/folders/:id/photos` or `GET /api/photos/unfiled`, "Showing X–Y of Z" pagination controls).
- Photo cards: thumbnail, filename, labels/confidence (or "classification failed" / "duplicate of X (method)" for Unfiled cards) — **no action row** (no Move dropdown, no Reclassify/"Not a duplicate?" button). Clicking a card's thumbnail opens the Photo viewer (see below) rather than doing nothing.
- Reuses `/organize`'s existing CSS classes (`.organize-shell`, `.organize-sidebar`, `.organize-grid`, `.organize-card`, etc. from `frontend/src/app/globals.css`) rather than inventing a parallel set — this is a visual subset of the same design, not a new visual language, so it should look identical minus the removed controls. New classes only where structurally needed (e.g. a viewer-open state), not a fresh stylesheet.
- Same three card visual states as `/organize` (normal / failed-red-border / duplicate-amber-border), since Unfiled must remain visible and its cards must still communicate *why* a photo needs attention — just without a way to act on it from this screen (the affordance is "go fix this in Organize," implicitly; no explicit link required by this pass, but Developer may add one such as a small "Manage in Organize" link/button if trivial — not a required AC).

#### 2. Photo viewer

**Wireframe judgment: does NOT need a wireframe round. Building directly with a described interaction spec.**

Reasoning, applying the same test the upload-page polish used (CLAUDE.md's trigger is "before building any new UI" — genuinely new layout surface with real ambiguity, not any pixel that hasn't shipped yet):

- The component parts are all well-established, low-ambiguity UI patterns with no real design-space to explore: a fullscreen/modal image display, a close affordance, next/previous navigation, and a metadata side panel. This is one of the most standardized interaction patterns in photo-product UI (Google Photos, Apple Photos, every gallery lightbox) — there isn't a meaningful "Option A vs. B vs. C" layout question the way there was for `/organize` (sidebar-tree vs. admin-table vs. modal-based-move were genuinely different information architectures) or the way Dashboard is (home-screen layout has several defensible, very different shapes).
- It is entered *from* an existing, already-decided grid (the folder browser's or `/organize`'s), so its visual context (what thumbnail grid it launches from, what backdrop it sits over) is already fixed — it doesn't need to invent a new page shell, just a modal/overlay on an existing one.
- The data it displays is fixed and fully known (confirmed above) — `original.url`, `exif.*`, `folder`, `originalFilename` — so there's no ambiguity about *what* goes in the panel, only straightforward layout of a fixed field list (label: value pairs), which doesn't rise to wireframe-decision territory any more than "add validation error text" did for the upload page.
- Compare directly to the prior spec's Dashboard-vs-upload-polish split: Dashboard needed a wireframe round because it's the app's home screen with multiple genuinely different reasonable layouts and no antecedent; the photo viewer has an antecedent (the folder browser's grid) and an industry-standard interaction pattern with essentially one reasonable shape. It sits closer to "interaction polish on an existing surface" than "new screen," even though the pixels are new — a fullscreen lightbox is fundamentally an *elaboration* of a thumbnail click, not a new information architecture decision.

**Interaction spec (build directly against this, no options needed):**
- Entry point: clicking a photo card's thumbnail in `/browse` (and, separately, in `/organize` on non-Unfiled cards where clicking the thumbnail — not the Move `<select>` — opens the viewer; Unfiled cards' thumbnails also open the viewer, showing a `failed`/`duplicate` status badge in the panel rather than blocking the viewer from opening at all) opens the viewer as a fullscreen overlay (not a route navigation — no page reload, preserves the underlying grid's scroll/pagination state).
- Layout: image fills the majority of the viewport (`original.url`, not a thumbnail — full resolution), an EXIF/info panel docked to one side (right, ~280–320px, Developer's exact width judgment) or a bottom sheet on narrow viewports (Developer's call — a single reasonable responsive behavior, not a design decision requiring sign-off) showing: filename, folder name (or "Unfiled" + status if applicable), date taken (`exif.takenAt`, formatted, or "Unknown" if null), camera make/model (or omitted entirely if both null — don't show an empty "Camera: —" row), GPS coordinates if present (plain lat/lng text is sufficient; a map embed is explicitly out of scope — no new mapping dependency this pass).
- Close: an explicit close control (X button, top corner) AND the Escape key AND clicking the backdrop outside the image — all three, standard lightbox conventions, no ambiguity to flag.
- Navigation: previous/next arrow controls (and Left/Right arrow keys) move between photos in the **currently-loaded page** of the grid the viewer was opened from (i.e. the same `photos` array already in state — no new fetch needed for in-page navigation). Disabled/hidden at the first/last photo of the current page rather than wrapping around or silently fetching the next page (explicitly not in scope — see Non-goals).
- Loading state: while `GET /api/photos/:id` is in flight (only needed if the viewer fetches full detail rather than reusing already-loaded card data — see implementation note below), show a simple loading indicator in place of the image; don't block the overlay from opening.
- **Implementation note, not a hard requirement:** the grid already has `id`, `originalFilename`, `status`, `aiLabels`, `aiConfidence`, `duplicateOfPhotoId`, `dedupMethod`, and a 150px `thumbnailUrl` for every visible card — the viewer needs the full-resolution `original.url` and `exif` on top of that, both only available via `GET /api/photos/:id`. Developer's call whether to fetch that per-photo on open (simplest, one extra request per viewer-open, acceptable at this scale) or pre-fetch for the whole page eagerly (not necessary, would waste requests for photos the user never opens) — the per-open fetch is the expected default, flagged only so Developer doesn't over-build a prefetch scheme.
- No routing changes: the viewer does not need its own URL (e.g. no `/browse?photo=<id>` deep-linking) for this pass — closing the browser tab or navigating away simply loses the open-viewer state, same as any other modal in this codebase today (no modal pattern exists yet elsewhere to be consistent with, so plain component state, not a URL-driven modal, is the default). Flagged as Open Question #3 in case Abhishek wants deep-linkable photo URLs now.

#### 3. Shared component reuse note

Developer should check whether the photo-card rendering logic (thumbnail box, status-based styling, filename/meta text) can be lightly shared between `/organize`'s `PhotoCard` and `/browse`'s equivalent (e.g. extract a presentational-only sub-component if it's a clean, low-risk five-minute extraction) — not a hard requirement, since `/organize`'s `PhotoCard` is tightly coupled to its action props (`onMove`, `onReclassify`) which `/browse` doesn't have. If extraction adds more complexity than it saves, duplicate the ~40 lines of card markup instead; this is a code-quality judgment call, not an acceptance criterion.

### Blocked / deferred (needs Abhishek's wireframe pick)

#### Dashboard page

**Functional requirements** (whatever the layout, per CLAUDE.md's protocol — Developer builds against these once a wireframe is picked):
- Fetches `GET /api/dashboard` on mount (same auth-gate pattern as every other page).
- Displays: total photo count, total folder count, total collection count, storage used vs. limit (both a human-readable size — e.g. "1.2 GB of 5 GB used" — and the `usedPercent` as a visual meter/progress bar, not just raw bytes).
- Displays the per-collection breakdown (`collections[]`): name, `isDefault` badge/label for the default collection, folder count, photo count — at minimum as a list; a link from each collection (or from the page generally) into `/browse` is a reasonable and encouraged addition (this is meant to be the discoverability entry point into the folder browser) but not a hard requirement if the picked wireframe doesn't call for it.
- Empty state: a brand-new user with zero uploads sees the page render cleanly with all-zero stats (matches the endpoint's documented empty-state contract), not an error or blank page.
- Replaces the current placeholder content at `/dashboard` (`frontend/src/app/dashboard/page.tsx`) — the existing "Welcome, {name}" auth-proof text and logout button either get folded into the new layout (e.g. as a header) or moved elsewhere (e.g. logout into a persistent nav once one exists) — Developer's call once the wireframe dictates where a header/logout affordance lives.

**Wireframe options** (proposed here for Abhishek's pick; not built, not committed as SVG files — per protocol these are presented in chat/summary for Master to relay, and only the picked option becomes a real `design/wireframes/dashboard.svg` file):

1. **Option A — Stat cards + collection list.** A row of 3–4 large stat cards across the top (Photos, Folders, Storage Used — each a big number + small label, storage card includes a mini progress bar), with a simple list/table of collections below (name, isDefault badge, folder count, photo count, click-through to `/browse`). Closest in spirit to a typical SaaS "overview" dashboard.
   - *Pros:* Familiar pattern, easy to scan, cleanly extensible if more stat cards are added later (e.g. "shared folders" in Week 9–10). Low visual-design risk.
   - *Cons:* With only one collection in practice today (Open Question #1 from `specs/ai-classification.md`), the "collection list" is currently a list of exactly one row — a little sparse until multi-collection support exists.

2. **Option B — Storage-meter hero + folder shortcuts.** A large, prominent storage-usage meter/gauge as the page's visual centerpiece (the single most "at a glance" stat), with photo/folder counts as smaller secondary text near it, and below that a grid of folder shortcut tiles (one tile per folder across the default collection — reusing folder names/counts from `GET /api/collections/:id/folders`, not just the collection rollup) that click through directly into `/browse` pre-filtered to that folder.
   - *Pros:* Storage usage (the thing users most concretely care about running out of) gets the most visual weight; folder tiles give a more immediately useful "jump into your photos" affordance than a one-row collection list, better reflecting that there's effectively one collection but several folders today.
   - *Cons:* Slightly more backend calls to assemble (needs the default collection's folder list, not just the dashboard rollup) — still zero *new* backend work (both endpoints already exist), just two calls instead of one. Slightly more layout complexity than Option A.

3. **Option C — Sidebar nav shell with stats as the default pane.** Introduce a persistent left sidebar (Dashboard / Browse / Organize / Upload / Logout) as the app's first real navigation shell, with the dashboard stats as the default content pane to its right (stat cards or storage meter, Developer's pick, similar content to A or B).
   - *Pros:* Solves a real, currently-absent problem — today every page (`/dashboard`, `/upload`, `/organize`) is an island with no shared navigation; a user has to know URLs or use browser back/forward. This option starts building the "app shell" the product will eventually need anyway.
   - *Cons:* Meaningfully bigger scope than a single screen — every existing page would need to adopt the new shell for the nav to feel real (otherwise it's a sidebar on one page and nothing on the others, which is worse than no sidebar), which stretches this beyond "one screen" into "a mini redesign of the whole app," explicitly against this cycle's stated goal of keeping the Dashboard pass small. Recommend against picking this now — flagged for completeness, but the honest trade-off is that it should wait for a dedicated "app shell/navigation" pass rather than ride along with the dashboard stats screen.

**Recommendation:** Option A or B, not C, to keep this pass properly scoped to "one screen." Between A and B: B gives the storage meter (the one number users most concretely need — "how close am I to running out") the visual priority it likely deserves, and folder-tile shortcuts are a more useful click-through than a single-row collection list given today's one-collection-many-folders reality — but this is a genuine judgment call for Abhishek, not a strong recommendation either way.

## Acceptance criteria

**Folder browser (`/browse`):**
- [ ] Unauthenticated visit to `/browse` redirects to `/login` (same pattern as `/organize`/`/dashboard`/`/upload`).
- [ ] Sidebar lists the user's folders (name + live photo count) plus an "Unfiled" row when `GET /api/photos/unfiled`'s `total` > 0; a brand-new user with zero uploads sees an empty-state message, not an error.
- [ ] Clicking a folder row loads that folder's photos into the grid via `GET /api/folders/:id/photos`, paginated (`limit=12`, Prev/Next, "Showing X–Y of Z").
- [ ] Clicking Unfiled loads via `GET /api/photos/unfiled`, showing failed (red border, "classification failed") and duplicate (amber border, "duplicate of X (method)") cards exactly as `/organize` does — this must work for a brand-new user whose very first upload failed/deduped before any collection exists (the exact scenario Tester's 07:31 report found broken in `/organize`; `/browse` must not repeat that bug, since it's built against the same already-fixed `GET /api/photos/unfiled` endpoint from day one).
- [ ] No Move control, no Reclassify/"Not a duplicate?" button, no folder-creation input anywhere on the page — verify by DOM inspection, not just visual check (Tester should confirm no `PATCH /api/photos/:id` or `POST /api/photos/:id/reclassify` call is ever triggerable from this page).
- [ ] Clicking a photo card's thumbnail opens the Photo viewer (see below) for that photo.
- [ ] Cross-user isolation: unchanged, since this page calls only already-verified endpoints — no new isolation testing needed beyond confirming the page itself never leaks a foreign photo/folder (i.e. doesn't construct or guess ids client-side).

**Photo viewer:**
- [ ] Opening the viewer from a grid thumbnail shows the full-resolution image (`GET /api/photos/:id`'s `original.url`), not the 150px thumbnail.
- [ ] The info panel shows filename, folder name (or "Unfiled"/status for an unfiled photo), date taken (formatted, or an explicit "Unknown" when `exif.takenAt` is null), and camera make/model when present (omitted, not blanked, when both null); GPS lat/lng shown as plain text when present.
- [ ] Close works via the X button, the Escape key, and clicking the backdrop — all three independently verified.
- [ ] Previous/Next controls (and arrow keys) navigate within the currently-loaded page of photos, disabled/hidden at the first/last photo — no wraparound, no implicit next-page fetch.
- [ ] Opening the viewer, navigating next/previous a few times, and closing it does not lose or corrupt the underlying grid's state (scroll position/pagination offset unchanged on close).
- [ ] Works identically when opened from both `/browse` and `/organize` (on non-Unfiled cards' thumbnails) — same component, same behavior, confirming the "reachable from any grid" framing rather than being `/browse`-specific.

**Dashboard page:** blocked — acceptance criteria to be added once Abhishek's wireframe pick lands and Developer builds against it. Functional requirements above define the eventual bar.

## Success signal

Tester Agent can: log in, visit `/browse`, see the same folders/Unfiled bucket `/organize` shows (including the brand-new-user-first-upload-fails scenario that was previously a bug), confirm no move/reclassify/create-folder control exists anywhere on the page, click a thumbnail, see a fullscreen image with a populated (or correctly-empty) EXIF panel, navigate next/previous through the page's photos, and close it three different ways without anything breaking. Separately, once Abhishek's Dashboard wireframe pick lands and Developer builds it, Tester can visit `/dashboard` fresh (empty state, all zeros) and again after uploading across categories, and see it accurately reflect `GET /api/dashboard`'s numbers with a real storage meter.

## Open questions

1. **Dashboard wireframe pick.** See the three proposed options above (A/B/C) — not yet picked. Recommendation: A or B, not C (C's scope creeps into a full navigation-shell redesign, against this cycle's "keep it to one screen" goal). Blocking Dashboard-page acceptance criteria and implementation until Abhishek picks.
2. **Folder browser as a new route (`/browse`) vs. a mode within `/organize`.** **Default (this spec's call, not a veto-pending item, but flagging the reasoning for visibility):** new route, per the reasoning in "Folder browser: route/mode decision" above — cleaner separation of read-only vs. editable state, avoids threading a `readOnly` flag through `/organize`'s move/reclassify logic and race-condition guards. Veto if Abhishek would rather have one unified page with a toggle (e.g. an "Edit mode" switch) instead of two routes — buildable either way, just a larger refactor of `/organize` if reversed after the fact.
3. **Photo-viewer deep-linking.** **Default:** no URL/route for the open viewer state this pass — closing the tab or navigating away loses it, same as any other unrouted modal today. Veto if Abhishek wants `/browse?photo=<id>`-style shareable/refreshable viewer URLs now, which would be a modest but real scope add (route-driven modal state, likely the first instance of that pattern in this codebase).
4. **Photo-viewer EXIF panel placement (side panel vs. bottom sheet on narrow viewports).** **Default:** Developer's implementation judgment, no sign-off needed — flagged only because it's the one piece of the viewer spec left intentionally unpinned (per the "not wireframe-worthy" judgment, a single reasonable responsive default is fine here, unlike the Dashboard's genuinely divergent options).
5. **Whether `/browse` needs a nav link from anywhere yet.** Since Option C (nav shell) is not recommended for this pass, `/browse`, `/organize`, `/upload`, and `/dashboard` remain link-reachable only where an existing page happens to link to them (e.g. the Dashboard's collection-list-to-browse link, if the picked wireframe includes one). **Default:** acceptable for this pass — a proper nav shell is Non-goal territory, tracked as a future idea, not a blocking gap. Flagging so Tester doesn't treat "I had to type the URL to reach `/browse`" as a bug.
