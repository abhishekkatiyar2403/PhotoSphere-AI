# Spec — Dashboard Stats Endpoint + Upload Flow Polish (Week 7–8 Core UI, Slice 1)

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 7 (Phase 1 — MVP, Week 7–8: Core UI — "Dashboard: collection overview, storage usage" and "Upload flow: drag & drop with progress bar" bullets only)
**Status:** draft
**Written by:** Planner Agent, 2026-07-03

## Problem

Week 7–8's checklist is four screens: Dashboard, Folder browser, Photo viewer, Upload flow polish. Three of the four are new UI with real layout ambiguity, and one of them (folder browser) overlaps heavily with the still-undecided reclassification-UI wireframe pick (Pending Decision #0 in `agents/STATUS.md`) — both are "browse folders, see photos in a grid." Speccing a second, independently-designed folder browser right now risks locking in a visually inconsistent pattern the moment Abhishek does pick a reclassify-UI option, and wastes a wireframe round on a screen that's 80% "the reclassify UI's browsing half, minus the move/reclassify actions."

This spec deliberately does **not** try to scope all four bullets at once. It scopes only the parts of Week 7–8 that are genuinely gated on nothing except backend work or are low-ambiguity enough to not need the SVG-wireframe-options process at all, and explicitly defers the rest until the reclassification-UI pick lands. This keeps Developer unblocked without compounding the UI-decision backlog.

## Goals

- **A dashboard-stats endpoint** (`GET /api/dashboard`) that aggregates what nothing today exposes in one call: total photo count, total folder count, storage used vs. limit (bytes and a ready-to-render percentage), and a per-collection breakdown (name, folder count, photo count) for the requesting user. This is new backend work — no existing endpoint returns an aggregate view across collections/folders/photos in one shot (`GET /api/collections` lists collections with no counts; `GET /api/collections/:id/folders` lists one collection's folders with per-folder `photoCount` but no cross-collection rollup; nothing sums `Photo` rows or reads `User.storageUsedBytes`/`storageLimitBytes` for client consumption at all today).
- **Upload flow polish**: add drag-and-drop and a real per-file progress bar to the existing `/upload` page, in place, as a progressive enhancement — not a new screen. See "Upload flow polish" below for why this is scoped as a direct build rather than a wireframe-options round.
- Explicitly document, in this spec, why Dashboard-the-page, Folder browser, and Photo viewer are **not** scoped for direct build this pass, and what has to happen first.

## Non-goals (explicitly out of scope for this pass)

- **The Dashboard page itself** (the actual screen presenting the stats above with a real layout). The stats endpoint is buildable now with zero UI ambiguity; the page that renders it is a genuinely new layout question (first "home" screen of the app) and needs the SVG-wireframe-options process. Deferred — see "Blocked / deferred" below.
- **Folder browser** (grid view of photos per category). Deliberately not scoped this pass, wireframes or otherwise. Recommendation: this should inherit whatever visual/interaction pattern Abhishek picks for the reclassification UI (`design/wireframes/proposals/reclassify-ui-option-{a,b,c}.svg`) minus the move/reclassify actions, rather than get an independent wireframe round. See "Blocked / deferred."
- **Photo viewer** (fullscreen, EXIF info panel). Backend data is already fully covered — see "Buildable now: confirmed, nothing new needed" below — but the fullscreen viewer UI itself (lightbox layout, nav between photos, EXIF panel placement) is new layout surface and is deferred alongside the folder browser, since in most photo-product patterns the viewer is entered *from* the folder browser and shares its grid/thumbnail assumptions.
- **Duplicate-detection warning before upload** (client-side pre-check, a separate Week 7–8 bullet) — not addressed by this spec at all; a distinct, smaller piece of scope, not bundled in here.
- **Multi-file / bulk upload.** The existing `/upload` page and its polish target in this spec remain single-file-at-a-time (drag a file or a batch in, but each is queued and uploaded individually, one progress bar per file in a simple list) — a true bulk-upload manager (parallel upload throttling, cancel-in-flight, retry-per-file UI) is not scoped here. If Developer finds the existing page's data model doesn't cleanly extend to "a small list of files," multi-file becomes a single-item list of the same per-file UI, not a new bulk-manager component.
- **Any change to the reclassification UI** or `specs/ai-classification.md` — untouched by this spec, per instruction.
- **Collections CRUD, folder rename/merge/delete** — still deferred from the prior spec's Non-goals; unaffected by dashboard stats being read-only.

## Scope for this pass

### Buildable now (no new UI decision needed)

#### 1. `GET /api/dashboard` (new endpoint, new file `backend/src/routes/dashboard.ts`, mounted at `/api/dashboard` in `app.ts`)

Aggregates data that exists today but nothing rolls up into one response:

- `requireAuth` + `asyncHandler`, same conventions as every other route (Zod not needed — no input, `GET` with no params/query).
- Response shape:
  ```json
  {
    "storage": {
      "usedBytes": "1234567",
      "limitBytes": "5368709120",
      "usedPercent": 0.02
    },
    "totals": {
      "photoCount": 42,
      "folderCount": 7,
      "collectionCount": 1
    },
    "collections": [
      {
        "id": "uuid",
        "name": "My Photos",
        "isDefault": true,
        "folderCount": 7,
        "photoCount": 42
      }
    ]
  }
  ```
- `storage.usedBytes`/`limitBytes` are `BigInt` in Prisma — serialize as **strings** (matching how the codebase already has to handle BigInt in JSON; confirm the existing pattern in `routes/photos.ts`'s quota check and reuse it, don't invent a second convention). `usedPercent` is a plain float (`usedBytes / limitBytes`, capped at 1.0, computed server-side so the client never does BigInt-to-float math).
- `totals.photoCount` — **all photos owned by the user, every status** (`pending`, `processing`, `done`, `duplicate`, `failed`), not just `done`. Rationale: this is a library-size stat ("how many photos have I uploaded"), not an organization-health stat; duplicates and in-flight uploads are still real uploaded files consuming storage. Flagged as Open Question #1 in case Abhishek wants a narrower definition (e.g. exclude duplicates).
- `totals.folderCount` / `totals.collectionCount` — straightforward counts of the user's `Folder`/`Collection` rows.
- Per-collection `folderCount`/`photoCount` — folder count via `Folder` rows scoped to the collection; photo count via `Photo` rows scoped to the collection (not summed from folder `photoCount`, to stay correct even for photos with a `collectionId` but null `folderId`, which can't happen today per the worker's atomicity but is cheap to get right directly from `Photo` rather than trusting folder-level counters to always sum correctly).
- **Empty state**: a user who has never uploaded anything gets `totals: { photoCount: 0, folderCount: 0, collectionCount: 0 }` and `collections: []` — 200, not 404 or an error (matches `GET /api/collections`'s existing "empty array before first classification" convention).
- No pagination — collection/folder counts per user are small (MVP scale); a full photo listing is explicitly not this endpoint's job (that's `GET /api/folders/:id/photos`, already shipped).

#### 2. Upload flow polish (existing `frontend/src/app/upload/page.tsx` — in place, not a new page)

**Why this does not need the SVG-wireframe-options process:** CLAUDE.md's protocol trigger is "before building any new UI." This is not a new screen — it's the same page, same route, same information (file picker, upload button, status/result box), with two behavior additions: (a) the existing drop target also accepts a dragged-and-dropped file, and (b) the existing "Uploading..." button state gains a numeric/visual progress indicator during the upload request itself. There is no layout ambiguity to resolve — the page's structure (picker + button + result box) was already decided and shipped in the upload-pipeline spec; this is an interaction/feedback enhancement to it, the same category of change as "add validation error text" or "disable a button while loading," which nothing in this repo's history has treated as wireframe-gated. Building directly with a described interaction spec (below) rather than proposing options.

Interaction spec:
- The existing result box (`data-testid="upload-result"`) becomes a drop target in addition to staying a static box: dragging a file over it shows a visual state change (e.g. border/background change — Developer's implementation choice, no new layout element), dropping a file populates the same `file` state the `<input type="file">` already populates (same validation path, same `handleUpload` call — no parallel code path). The `<input type="file">` stays as-is for click-to-browse; drag-and-drop is additive, not a replacement.
- Progress bar: `photosApi.upload` currently uses a plain `fetch` with no upload-progress signal (the Fetch API doesn't expose upload progress natively). Swap the upload call's transport to `XMLHttpRequest` (or a fetch-with-progress polyfill already in the dependency tree if one exists — Developer's call, no new heavy dependency for this alone) so `upload.onprogress` can drive a `<progress>` element or an equivalent percentage readout, shown only while `uploading === true`. This is a transport-layer change scoped to `photosApi.upload` in `frontend/src/lib/api.ts`; it does not change the endpoint contract (`POST /api/photos/upload` is unchanged) or any other `apiFetch` caller.
- Progress reflects the **upload request only** (bytes sent to `POST /api/photos/upload`), not worker processing — the existing 2-second status poll loop (`pending → done/duplicate/failed`) is unchanged and stays a separate, sequential phase after the progress bar completes at 100%. Do not conflate "upload progress" with "processing progress" — there is no processing-percentage signal from the backend to show even if it were conflated.
- No visual redesign of the existing box, no new "polished" styling pass beyond what's needed to show a drag-over state and a progress bar — this page remains intentionally minimal per `specs/upload-pipeline.md`'s original framing ("proof of round-trip," not the finished UI). If Developer finds the drag-and-drop hit target or progress bar genuinely needs more visual design than "a border highlight and a `<progress>` bar" to look non-broken, stop and flag it rather than freelancing a design pass — but the expectation going in, stated explicitly, is that it does not.

### Blocked / deferred (needs the reclassification-UI pick first, or its own smaller wireframe round)

- **Dashboard (the page).** The stats endpoint above is ready; the screen that presents it is a genuinely new layout question (it's the app's de facto home/landing screen post-login) with no existing pattern to inherit — unlike the folder browser, this one **does** warrant its own small wireframe-options round, but only once Developer has bandwidth after (or in parallel with, if Abhishek wants to unblock both at once) the reclassify-UI pick. Recommend 2–3 lightweight options (e.g. stat cards + collection list; a single storage-meter hero with a collections table below; a sidebar nav shell with the stats as its default content pane) — deliberately smaller/faster than the reclassify-UI round since there's no photo grid or move/reclassify interaction to design here, just numbers and a list.
- **Folder browser.** Explicitly recommend against a second, independent wireframe round. Once Abhishek picks a reclassify-UI option (A/B/C), the folder browser should reuse that option's folder-list/photo-grid visual language verbatim, with the move-to-folder and reclassify actions simply omitted (browsing and opening a folder to see its photos is a strict subset of what all three reclassify-UI options already do). If Abhishek's pick turns out to be poorly suited to pure browsing (e.g. Option B's admin-table framing was explicitly called out in STATUS.md as "mostly throwaway once Week 7-8's real folder browser ships"), that's a reason to weigh the reclassify-UI pick against its Week 7-8 afterlife *now*, not a reason to design the folder browser twice.
- **Photo viewer.** Data is fully ready today (see below); UI is deferred alongside the folder browser since it's typically entered from it and inherits its thumbnail/navigation assumptions. No separate wireframe round recommended — fold it into whichever pass builds the folder browser, as a modal/route reachable from a grid thumbnail.

### Confirmed: no new backend work needed for Photo viewer / EXIF panel

Checked directly against `backend/src/routes/photos.ts` and `folders.ts` — `GET /api/photos/:id` already returns everything a fullscreen photo viewer + EXIF panel needs:
- Pre-signed original + all thumbnail-size URLs (`original`, `thumbnails`).
- Full `exif` object (`takenAt`, `gpsLat`, `gpsLng`, `cameraMake`, `cameraModel`), shipped and Tester-verified in the AI-classification cycle.
- `folder` (id + name) and `collectionId`, for a "which folder is this in" breadcrumb/label in the viewer.
- `status`, and (via `GET /api/photos/:id/status`) `aiLabels`/`aiConfidence`/`job`/`dedupMethod` if the viewer wants to surface classification info too.

Nothing new is speced here for the viewer's data needs — only its UI is deferred. If, once the folder browser/viewer UI is actually designed, a genuinely new field is needed (e.g. "next/previous photo in folder" ordering beyond what pagination already gives), that's a small follow-up spec at that time, not a gap today.

## Acceptance criteria

**Dashboard-stats endpoint:**
- [ ] `GET /api/dashboard` with no session cookie returns 401.
- [ ] A brand-new user (no uploads yet) gets 200 with `totals: {photoCount:0, folderCount:0, collectionCount:0}`, `collections: []`, and `storage.usedBytes: "0"` (or the actual pre-existing usage if any) — never a 404 or error for the empty case.
- [ ] After uploading N photos across multiple categories (reusing existing fixtures from `specs/ai-classification.md`'s committed set), `totals.photoCount` equals N (including any `duplicate`/`failed` photos in that N), `totals.folderCount` matches `GET /api/collections/:id/folders`'s count for the default collection, and each collection's `photoCount`/`folderCount` in the `collections` array matches.
- [ ] `storage.usedBytes` matches `storageUsedBytes` as tracked by the upload pipeline (cross-check: upload a known-size file, confirm `usedBytes` increases by exactly that many bytes), returned as a string (not a raw BigInt serialization error — confirm the endpoint doesn't 500 on JSON-stringifying a BigInt, the well-known Node/Express footgun).
- [ ] `storage.usedPercent` is a float between 0 and 1 (inclusive), computed correctly for both a near-empty and a near-full quota (near-full is a code-review/unit-level check — Non-goal to actually fill 5GB in a live test, same accepted constraint as the upload-pipeline spec's storage-quota 413 test).
- [ ] Cross-user isolation: user B's `GET /api/dashboard` never reflects user A's photos/folders/storage, and vice versa (standard per-owner scoping, same pattern as every other endpoint — no new ownership-check code path to get wrong here since there's no `:id` param, just `req.user!.id` scoping throughout).
- [ ] Response shape matches the JSON example above exactly (field names, nesting) — Tester should diff against this spec, not guess at reasonable-looking alternatives.

**Upload flow polish:**
- [ ] Dragging a valid image file onto the upload page's drop target and releasing it populates the file the same way choosing it via the `<input>` would (same subsequent Upload-button flow, same validation, same error handling for a rejected MIME type — confirm the content-sniff 400 path still fires identically for a dropped file as for a picked one, since it's server-side and file-source-agnostic anyway).
- [ ] During an upload request, a progress indicator visibly advances from 0 toward 100% before the existing "pending → done" status polling begins; for a small file this may complete near-instantly (acceptable — the acceptance criterion is "a progress mechanism exists and reaches 100% on completion," not "is visible for a minimum duration"). Tester should use a larger fixture file (e.g. near the upper end of the existing fixture set, not necessarily near 50MB) if a near-instant completion makes the bar hard to observe live.
- [ ] Existing upload-page behaviors are unchanged: file-type/size validation errors, the `done`/`duplicate`/`failed` result rendering, the thumbnail preview `<img>`, and the 2-second status poll loop all behave exactly as they do today (this is regression-sensitive — Tester should re-run the existing upload-page Playwright checks from `reports/2026-07-02_0450.md`/`reports/2026-07-03_0050.md`, not just the two new behaviors).
- [ ] No change to `POST /api/photos/upload`'s request/response contract — this is a frontend-only, transport-layer change (`fetch` → `XMLHttpRequest` or equivalent inside `photosApi.upload`); backend routes/tests are unaffected and need no re-spec.

## Success signal

Tester Agent can: call `GET /api/dashboard` fresh (empty state), then again after uploading a handful of fixtures across categories and letting the worker resolve them, and see `totals`/`storage`/`collections` accurately reflect that library — including a duplicate or failed photo still counting toward `totals.photoCount`. Separately, Tester can drag a fixture file onto the `/upload` page (not just click-to-browse), watch a progress bar move during the upload POST, and confirm every existing upload-page behavior (validation, polling, thumbnail render) still works exactly as before.

## Open questions

1. **`totals.photoCount` scope.** **Default:** count every photo regardless of status (`pending`/`processing`/`done`/`duplicate`/`failed`) — it's a "how much have I uploaded" stat, matching what consumes `storageUsedBytes`. Veto if Abhishek wants this to reflect only successfully organized photos (`done` only, or `done`+`duplicate` but not `failed`/in-flight) — easy one-line change to the `where` clause, flagging now so Tester knows which definition to check against rather than guessing.
2. **Dashboard-the-page's wireframe round timing.** **Default:** scope it as its own small SVG-options round, run whenever Developer has bandwidth after (or in parallel with) the still-pending reclassify-UI pick — it doesn't share the reclassify-UI's folder/grid visual language question, so it isn't blocked by that decision, just sequenced after it in this cycle's priority. Veto if Abhishek wants the dashboard-page wireframes presented immediately, in parallel with this spec's backend work, rather than waiting.
3. **Folder browser inheriting the reclassify-UI pattern.** **Default (recommendation, not yet a built decision):** once Abhishek picks Option A/B/C for reclassification, the Week 7-8 folder browser reuses that visual pattern (grid/list layout + folder navigation) minus move/reclassify actions, with no separate wireframe round. Flagging explicitly because Option B was already self-described in STATUS.md as "mostly throwaway once Week 7-8's real folder browser ships" — if that assessment holds, Option B being picked for reclassification would argue for *not* reusing it for the browser, undercutting this spec's recommendation to skip a second wireframe round. Worth weighing before the reclassify-UI pick, not after.
4. **XMLHttpRequest vs. a fetch-progress library for the upload progress bar.** **Default:** plain `XMLHttpRequest` (`upload.onprogress`), zero new dependencies, since this is the only place in the codebase that needs upload-progress and the native browser API covers it fully. Veto if Abhishek would rather standardize on a library-based approach for consistency with anticipated future multi-file upload work.
