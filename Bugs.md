# Bug Tracker — PhotoSphere AI

Every bug Abhishek finds while testing the app, in the order he reported it. Updated every time he reports a new one. For each: what he saw, why it happened, the fix logic, and exactly what got delivered (with commit hashes).

---

## #1 — No way to reach Upload/Organize after logging in

**Reported:** 2026-07-07
**Abhishek's report:** *"i am not seeing on ui to upload photots... when i do login then how can user will [know] from here i can upload photos, how did he know the url"*

**The bug:** `/upload` worked fine as a page, but nothing on the site linked to it. After logging in, a user landed on `/dashboard` with no way to click their way to Upload or Organize — you'd have to already know the URL. Auditing every page's top bar showed this wasn't isolated: `/browse` and `/upload` had **no navigation at all**, and every other page linked to a different, inconsistent subset of the other pages.

**Fix logic:** Every authed page should carry the exact same set of navigation links, so no matter where you are, every other page is one click away. This needed a genuinely consistent pass across all 8 pages, not just patching the two obviously-broken ones.

**Fix delivered:** Every authed page (`/dashboard`, `/organize`, `/browse`, `/upload`, `/share`, `/guests`, `/activity`, `/search`) now shows the same top-bar link set — Upload · Organize · Browse · Search · Guests · Activity — plus the "PhotoSphere AI" title doubling as a Home link. `/upload` and `/browse` got a top bar for the first time.
**Commit:** `2588f67` (2026-07-07)
**Status:** Fixed, verified live (all 8 pages checked for the full link set).

---

## #2 — Photos in Unfiled had no usable action

**Reported:** 2026-07-08
**Abhishek's report:** *"the photos present in unfiled we can't do anything there no option available"*

**The bug:** A photo card showed exactly **one** action based on its status — a `failed` photo only got a "Reclassify" button, a `duplicate` photo only got a "Not a duplicate?" button, and every other photo only got a "Move to…" dropdown. Failed/duplicate photos **never** got the Move dropdown. So if reclassifying didn't fix a stuck photo (kept failing, or you disagreed with the duplicate call), there was no way to manually file it anywhere — a genuine dead end. The backend never actually cared about a photo's status when moving it; this was purely a frontend gap.

**Fix logic:** Show the Move dropdown on every card unconditionally, regardless of status — failed/duplicate cards keep their existing retry button *and* get the Move option, so there's always a manual way out.

**Fix delivered:** The Move `<select>` now renders on every photo card, no status guard. Along the way, a second bug was caught and fixed in the same pass: moving a photo *out* of Unfiled wasn't decrementing the Unfiled count shown in the sidebar, leaving it stale/inflated.
**Commit:** `4e33e25` (2026-07-08)
**Status:** Fixed, verified live against the backend (moved a failed and a duplicate photo into a real folder, confirmed both disappear from `/unfiled`).

---

## #3 — Only one photo could be uploaded at a time, and no way to delete photos

**Reported:** 2026-07-08
**Abhishek's report:** *"i also trying to upload multiple photos at the same time but i only upload one photo at a time and also didn't see option to select multiple photos so that user can delete or single photo"*

This was two separate problems reported together.

### 3a — Single-file-only upload

**The bug:** `/upload` had no `multiple` attribute on its file input, and drag-and-drop only ever grabbed the first dropped file. The backend's upload endpoint is genuinely one-file-per-request by design — that wasn't going to change — so the fix had to work entirely on the frontend.

**Fix logic:** Track a *list* of files instead of one, loop the existing single-file upload endpoint once per file, and give each file its own independent progress/status so one failure doesn't block or hide the others.

**Fix delivered:** `/upload` now accepts multiple files (drag or click), uploading up to 3 at a time in parallel, each with its own progress bar and result.
**Commit:** `8d5b74a` (2026-07-08)
**Status:** Fixed, verified against the live upload endpoint.

### 3b — No way to delete a photo at all (single or multiple)

**The bug:** There was no delete capability anywhere in the app — no delete-a-photo button, no select-multiple UI, and no backend endpoint for it either. Not a defect in existing code; a capability that had never been built.

**Fix logic → became a much bigger feature.** Building deletion properly raised a real design question: should deleting be instant and permanent? Abhishek made the call: **no — deleted photos and folders should sit in a recoverable Trash for 7 days, then auto-delete**, with Recover / Delete Forever / Empty Trash all available in the meantime. This became **the Trash System** — a full subsystem, not a quick patch:
- Soft-delete (a `deletedAt` flag) instead of removing data immediately, for both photos and folders.
- A rule that a folder's name can be reused once the old one is in the trash, without waiting for it to fully expire.
- A rule that you can't delete a single photo if its folder is currently shared with a guest (same protection folders already had).
- A daily background job that automatically empties anything older than 7 days.
- Every single place in the app that lists photos or folders (search, browse, guest views, dashboard totals) had to be checked so a trashed item can never quietly reappear anywhere.
- A new Trash page (Recover / Delete Forever / Empty Trash), and real desktop-style multi-select on Organize (click, Shift-click for a range, Ctrl/Cmd-click to add one, drag a selection box, Select All).

**Fix delivered:** The full Trash System, backend and UI, built and adversarially tested across two complete rounds (208+ backend checks, then 27 UI checks) before being shipped.
**Key commits:** `9b8da10`, `c52a3f4`, `7410271`, `99296f1`, `e9f9e81` (backend), `861ff25` (UI) — 2026-07-08.
**Status:** Fixed and shipped. (This is also where bug #4 below was found, while dogfooding the new feature.)

---

## #4 — Recovering one photo brought back its entire trashed folder

**Reported:** 2026-07-08 / 2026-07-09
**Abhishek's report:** *"When i delete photo from a folder and then i delete folder also but when i recover photo only then the whole folder with all the photos recover..."* — followed by his own precise fix proposal: recovering a photo should only recover that photo, offering to put it in an already-existing folder of the same name or create a new one; recovering a whole folder should offer merge-into-existing or rename (which already worked correctly).

**The bug:** As originally built, restoring a single trashed photo whose folder was *also* trashed would automatically restore the entire folder first — bringing back every other photo in it too. This was the originally-designed, originally-tested behavior; Abhishek found it confusing in real use and asked for something more surgical.

**Fix logic:** A single-photo restore should never touch its old trashed folder at all. Instead: if a live folder with the same name already exists, ask whether to put the photo there or create a new one; if no such folder exists, just quietly create a fresh one with the original name and put the photo there. The old trashed folder — and anything else still in it — stays exactly as it was, untouched, on its own independent clock.

**Fix delivered:** `POST /api/photos/:id/restore` rewritten to never cascade into folder-restore. The Trash page's recovery screen updated to match — offering "Put it in the existing folder" / "Create a new folder for it" instead of the folder-restore language. Verified live by directly reproducing the exact reported scenario (delete photo → delete its folder → recover the photo) and confirming the original folder stayed trashed and untouched in every case.
**Commits:** `1b7f17e` (spec revision), `6443d87` (backend fix), `9aa2129` (frontend fix) — 2026-07-08/09.
**Status:** Fixed, personally re-verified end-to-end against the live database and API (not just automated tests).

---

## #5 — Permanently deleting a folder from Trash also destroyed a photo that was already, separately, in the Trash

**Reported:** 2026-07-08
**Abhishek's report:** *"when i delete a photo from the folder after that i delete the folder then also delete the folder from the trash then i try to recover that photo it says photo not found fix this issue if i delete the folder from the trash but that photo should not be deleted"*

**The bug:** Deleting a folder for good (either by clicking "Delete Forever" in Trash, or via the automatic 7-day purge) hard-deleted **every** photo still pointing at that folder — including a photo you'd already, separately, put in the Trash *before* you trashed the folder. That photo had its own independent 7-day countdown and its own pending recover/delete decision, but it got wiped out anyway just because it happened to still technically belong to a folder that was also being wiped out. This only affected photos that were already individually trashed; a live (never-deleted) photo in a purged folder was always correctly destroyed, and still is — that part hasn't changed.

**Fix logic:** A folder's own permanent-delete step should never reach into a photo's independent trash lifecycle. Live photos still under the folder get destroyed along with it, exactly as before. But a photo that already has its own trash date gets detached from the folder (instead of destroyed) right before the folder disappears — so it keeps existing, keeps its own countdown, and later restores normally straight into Unfiled (the app already knows how to restore a photo that has no folder).

**Fix delivered:** `purgeFolder()` in `backend/src/lib/purge.ts` (the one shared function used by both "Delete Forever" and the daily auto-purge job, so both paths are fixed at once) now splits a folder's photos into live vs. already-trashed before doing anything: live photos are hard-deleted as before, already-trashed photos are detached from the folder and left alone. New test added reproducing your exact scenario end-to-end (trash a photo → trash its folder → delete the folder forever → confirm the photo survives, is detached, and restores cleanly into Unfiled) — full backend suite re-run clean (177/177) with no regressions.
**Status:** Fixed, verified via automated test reproducing the exact reported sequence; full backend suite passing.

---

## #6 — After #5's fix, the preserved photo silently landed in Unfiled instead of asking where it should go

**Reported:** 2026-07-08
**Abhishek's report:** *"if a photo is deleted from the folder and the folder of that photo is also deleted and also deleted from the trash also when we try to recover the photo then instead of recovering that photo in unfiled folder just show a message that Folder of this photo is deleted and asked user to create a new folder or select the already present folders to recover in one of the folder"*

**The bug:** #5 fixed the data-loss part (the photo itself no longer gets destroyed), but the follow-on restore behavior it landed on — silently dropping the photo into Unfiled — wasn't what should happen. If a photo's original folder is permanently gone, restoring it should ask the user where it should go, not make that decision for them.

**Fix logic:** Match the same pattern already used elsewhere in the Trash system for "the exact original folder isn't available — you choose": when restoring a photo whose folder was permanently purged (not just trashed), stop before restoring and ask. Since the original folder doesn't exist at all anymore (unlike bug #4's case, where a live same-named folder might exist), the choice is broader — pick ANY of your existing folders, or create a brand-new one (defaulting to the old folder's name, or a name you type yourself).

**Fix delivered:**
- Backend: a photo decoupled by `purgeFolder()` now remembers its old folder's name (`Photo.deletedFolderName`, new column). `POST /api/photos/:id/restore` checks for this and, with no `onConflict` given, returns `409 { error: "folder_deleted", originalFolderName, liveFolders }` instead of restoring — `liveFolders` lists every live folder in the photo's collection. `onConflict: "existing"` + `targetFolderId` restores into the chosen folder; `onConflict: "new"` (+ optional `newName`) creates a fresh folder and restores into that. `deletedFolderName` is cleared the moment the photo actually restores.
- Frontend: the Trash page's photo-recover flow now catches this new 409 shape and shows a panel — "The folder '\<name>' this photo was in has been deleted" — with a dropdown of your existing folders ("Put it here") plus "Create a new '\<name>' folder" / "Name the new folder myself…", mirroring the existing collision-panel pattern used elsewhere on the page.
- Two new backend tests cover the exact sequence (delete photo → delete its folder → delete forever from Trash → restore) for both the "create new folder" and "pick an existing folder" paths. Full backend suite re-run clean (178/179 — one unrelated pre-existing flaky test, see below).
**Status:** Fixed, verified via automated tests reproducing the exact reported sequence; app restarted locally with the fix live.

*Unrelated, carried-forward note: one test in `classification.smoke.test.ts` (`GET /api/photos/unfiled` — the pipeline-worker end-to-end test) timed out when run as part of the full 13-file suite under concurrent DB/Redis load, but passed cleanly every time when run alone — this is the same pre-existing, already-documented flake pattern from earlier in the project, not something this fix introduced.*

---

## #7 — Selecting multiple photos only offered Delete; no way to Move or Download a selection (or a single photo)

**Reported:** 2026-07-09
**Abhishek's report:** *"when we click on select all then all the photots of that folder selected and after that we have a option to delete but we can also give otpion to move photos in between folders also after selected all the photos and also give option to download the selected photos as well as single photo also"*

**The bug:** Not a defect in existing code — a gap in what the multi-select feature (built for bug #3b) actually let you do. Once you selected photos (via Select All or manual multi-select), the bottom action bar only had "Delete selected". There was no way to move a batch of selected photos into a different folder in one action, no way to download a batch as a zip, and — separately — no download button on an individual photo card at all (single-photo download had never been built, even though the backend already had the plumbing for it via the existing photo-detail endpoint's presigned URL).

**Fix logic:** Give the multi-select action bar the same two actions Delete already had a pattern for — partial-success, per-id, reusing the existing guarded photoCount transaction and the existing zip-streaming code (already built for folder "Download all") rather than inventing new mechanics. For a single photo, reuse the presigned URL the detail endpoint already returns and just add a button — no new backend endpoint needed there.

**Fix delivered:**
- Backend: `POST /api/photos/bulk-move { photoIds, folderId }` — moves up to 100 selected photos into one target folder at once, same partial-success shape as bulk-delete (a bad id is reported, not fatal to the batch), reconciling `photoCount` on both the source and target folders. `POST /api/photos/download-many { photoIds }` — zips a caller-chosen set of photos by reusing the exact same streaming zip assembly as folder "Download all"; an id that isn't owned, is trashed, or has no stored original is silently skipped rather than failing the whole request, but an all-nothing-downloadable request still gets a clean 400 and an oversized one a 409, before any byte streams.
- Frontend (`/organize`): the selection bar (bottom of screen, shown once ≥1 photo is selected) now has "Move to…" (a folder picker, in-place, reversible — mirrors the per-card Move dropdown) and "Download selected" (triggers the zip via a normal browser download) alongside the existing Delete. Every photo card also now has its own "Download" button, opening the photo's original file in a new tab via its existing presigned URL — same pattern already used on the guest share view.
- New backend tests cover bulk-move's partial success + target-folder ownership/trash checks, and download-many's inclusion rules (skips another owner's photo, a trashed photo; 400 when nothing in the request is downloadable). Full backend suite re-run clean (185/185, no regressions).
**Status:** Fixed, verified via automated tests; app restarted locally with all three actions live.

---

## #8 — Guest sharing: no way to change a guest's permission after sharing, download button didn't actually download, and no batch download for guests

**Reported:** 2026-07-09
**Abhishek's report:**
1. *"when we share folders with guest then we have only revoke option but i want to change the permission like first i give the permission to view only then i want option to change permission like later i want to give him download permission... i can change the permission to that shared account"*
2. *"while i click on the download on the shared folder in guest login it shows the photo in another tab but not download the photo and also give option to select the photo and select all to download and also give permission to download the whole folder"*
3. *"i have share a photo with you what is pending"* — a shared guest was stuck showing status "pending" even after the OTP was approved.

This was three separate things.

### 8a — No way to change a guest's permission level after sharing

**The bug:** Once a folder was shared with a guest at some permission level (view/download/download_all), the *only* action available afterward was Revoke. Upgrading someone from view-only to download access meant tearing down the whole share and re-inviting from scratch.

**Fix delivered:** `PATCH /api/guests/:id { permissionLevel }` — updates every currently-live folder share for that guest to the new level in one call, audited as `guest_permission_changed`. Takes effect immediately on the guest's *already-open* session (permission is checked live on every request, no re-approval needed). The Guests page now shows a permission dropdown (view/download/download_all) next to Revoke for every active guest.
**Status:** Fixed, covered by 4 new backend tests (upgrade takes effect on a live session, 404 for another owner's/nonexistent/fully-revoked guest, 400 on a bad level).

### 8b — Guest "Download" opened the photo in a new tab instead of downloading it

**The bug:** A plain pre-signed MinIO URL has no `Content-Disposition` header, so `window.open()`-ing it just navigates the tab to the image instead of triggering a save — true for both the guest portal's download button and the owner's per-photo download button in `/organize` (added in bug #7, so it inherited the same gap).

**Fix logic:** S3/MinIO supports overriding the response's `Content-Disposition` per-request via `response-content-disposition` on the pre-signed URL itself — the correct, browser-agnostic fix, rather than fetching the file into memory client-side just to force a save.

**Fix delivered:** New `getPresignedDownloadUrl(key, filename)` in `lib/storage.ts`, set to `attachment; filename="..."`. Wired into the guest single-photo download endpoint, and added as a *separate* `download` field (alongside the existing `original` viewing URL) on the owner's photo-detail endpoint, so the lightbox/viewer's URL is untouched and only the dedicated Download buttons use the forced-download one.
**Status:** Fixed, verified by asserting the returned URL carries `response-content-disposition=attachment` in the existing end-to-end guest-flow test.

### 8c — No way for a guest to select multiple photos and download them, without the stricter "download whole folder" permission

**The bug:** A guest with `download` access (not the stricter `download_all`) could only download one photo at a time — there was no multi-select, and the existing "Download all" zip button is deliberately gated to the `download_all` level only, so it wasn't an option here.

**Fix delivered:** `POST /api/guest/photos/download-many { photoIds }` — zips a guest-chosen batch of photos, reusing the same streaming zip code as every other download-many endpoint. Works at plain `download` level (not just `download_all`); a requested photo the guest isn't actually permitted to download is silently excluded rather than failing the whole batch. The guest portal page now has checkboxes on each photo, a "Select all on page" button, and a "Download selected" button (shown whenever the guest has at least `download` access).
**Status:** Fixed, covered by 3 new backend tests (zips the permitted set while excluding a foreign photo, 400 when everything requested is unpermitted, empty/no-session guards).

### 8d — The "what is pending" guest turned out to be a self-inflicted diagnostic accident, not a product bug

**What happened:** While fetching an OTP for Abhishek earlier in this same session (to unblock testing), I called the guest's own status-poll endpoint directly from a terminal `curl` to check whether an approval had gone through. That endpoint's job is to mint the guest's one-time session and hand it back as a cookie on the *browser* that calls it — since my `curl` call was the very first poll to observe "approved," it claimed that one-time mint for itself and discarded the cookie, permanently starving the real browser of a working session. The guest's status has correctly stayed "pending" ever since, because a session was, in fact, never delivered anywhere usable.

**Not a code bug** — this is the OTP flow's single-use claim latch working exactly as designed (specs/guest-access-otp.md decision G7); it just doesn't tolerate a diagnostic poll from outside the real guest browser.

**Fix / recovery:** No code change. That specific guest is unrecoverable as-is — the remedy is to click **Revoke** on it in the Guests page, then **"+ Share new folders"** to re-invite the same email, which creates a fresh invite link, fresh OTP, and fresh session-claim opportunity.

**Process note for future sessions:** don't call `GET /api/invites/requests/:id/status` directly to "check" an approval outside of the real guest browser's own poll — use the read-only `GET /api/invites/requests/:id/otp` (fetching the code) and `GET /api/access-requests?status=...` (owner-side, via `guestsApi`/`accessRequestsApi`) instead, since neither of those has a claim side-effect.
**Status:** Explained; no fix needed; recovery path given above.

---

## #9 — No way to share more folders with an already-approved guest, or remove access to just one folder

**Reported:** 2026-07-09
**Abhishek's report:** *"i shared the folder with the guest approve the request and then the guest can see the shared folder only but now i want to share one or 2 more folders with that guest or remove the folder access of one folder"*

**The bug:** Not a defect — a gap. Once a guest was invited and approved, their set of shared folders was frozen: the only lever available afterward was "Revoke" (all-or-nothing, kills every folder and the whole invite). There was no way to add a folder to an existing guest's access, or take away just one folder while leaving the rest untouched.

**Fix logic:** A guest's folder access needed to become editable per-folder, not just per-guest. Since the schema already has one `folder_permission` row per (guest, folder) pair with its own `revokedAt`, this is naturally additive/subtractive at the row level — no redesign needed, just two new targeted endpoints that operate on individual rows instead of the whole guest.

**Fix delivered:**
- `POST /api/guests/:id/folders { folderIds }` — shares one or more additional folders with an existing guest at their current permission level, all-or-nothing on ownership (any unowned folder → 404, nothing added). An already-shared folder is silently skipped; a folder that was shared once and later removed gets its existing row reactivated rather than erroring on the database's one-row-per-pair constraint. Takes effect immediately on the guest's already-open session — no re-approval needed.
- `DELETE /api/guests/:id/folders/:folderId` — revokes access to just that one folder, leaving every other folder this guest has untouched. 404 if the guest never had that folder live.
- Both actions are audited (`guest_folder_added` / `guest_folder_removed`).
- Frontend (`/guests`): each guest's shared folders now show as removable chips (× revokes just that one) plus a "+ Add folders" button that opens a picker of the owner's folders not already shared with that guest.
- 6 new backend tests cover: adding a new folder + skipping an already-shared one, reactivating a previously-removed folder, ownership/session guards on both endpoints, and that removing one folder doesn't touch the guest's other folders.
**Status:** Fixed, verified via automated tests (25/25 in the guest-access suite, 198/198 full backend suite, no regressions). App restarted locally with the feature live.

---

## #10 — No way to tell if a guest forwarded their invite link to someone else

**Reported:** 2026-07-09
**Abhishek's asked:** *"how can we detect that the link share with the guest if he share with the other person that link"* — a question, not a bug report, but it surfaced a real gap once the mechanism was traced through.

**What already existed:** an invite link can only ever be used once — after the first click gets approved, the link is permanently dead for any future request. And the owner already sees the requester's IP/device before approving.

**The gap:** if a guest forwards the link to someone else *before* the owner approves, and that second person clicks it too, the code silently reused the same pending request (so the owner isn't spammed with duplicate OTP emails) — but it never recorded WHO that second click came from. Only the very first click's IP/device was ever stored. So today, forwarding during that pending window left literally no trace anywhere in the app.

**Fix logic:** Keep recording just one OTP per pending request (that part was correct — the OTP itself shouldn't multiply per click), but start recording every click that touches a pending request, not just the first. Then surface a warning to the owner if more than one distinct IP shows up before they approve — a signal to look twice, not proof of anything (the same person switching networks looks identical to two different people).

**Fix delivered:**
- New `AccessRequestTouch` table — one row per click on a pending invite link (IP + user-agent + timestamp), written on both the original request and every subsequent re-click while it's still pending.
- `GET /api/access-requests` now returns `touchCount`, `distinctDeviceCount`, and `multipleDevicesDetected` per pending request, computed from distinct IPs across all touches.
- The Guests page's pending-approval banner now shows an amber warning — *"⚠ This invite link was opened from N different devices/networks before this request was resolved — possibly forwarded to someone else. Review before approving."* — whenever `multipleDevicesDetected` is true.
- 3 new backend tests cover: a single click reporting no warning, a same-IP re-click NOT flagging (still one device), and the aggregation logic correctly flagging two distinct IPs while confirming only one OTP was ever issued for the whole sequence.
**Status:** Built and verified via automated tests (27/27 in the guest-access suite, 200/200 full backend suite, no regressions). App restarted locally with the feature live. Framed honestly to Abhishek as a *signal*, not a guarantee — it can't distinguish "guest forwarded the link" from "guest switched wifi/mobile data".

---

## #11 — iPhone HEIC (Live Photo) uploads failed with a "security limit exceeded" decode error

**Reported:** 2026-07-09/10
**Abhishek's report:** Screenshot of multiple uploads stuck on *"Status: failed"*, with the network trace showing *"Input buffer has corrupt header: heif: Invalid input: Security limit exceeded: Number of references in iref box (45) exceeds the security limits of 16 references."* — *"check and fix it immediately"*

**The bug:** The worker decodes every image with `sharp`, which bundles libheif — and libheif has a hardcoded anti-DoS cap of 16 item-references inside a HEIC container. iPhone **Live Photos** (the default camera mode) routinely carry 45+ references, so perfectly valid photos straight off the phone failed to decode at all: no thumbnails, no pHash, no classification. Confirmed by reproducing the exact error against the real failing file; not configurable through sharp — a genuine upstream limitation.

**Fix logic:** When sharp can't decode, fall back to macOS's built-in `sips` tool, which uses Apple's own native HEIC decoder (completely independent of libheif). Restructure the pipeline around a single decoded `pixelBuffer` (sharp first, sips fallback) shared by thumbnails, pHash, and classification — and since Rekognition only accepts JPEG/PNG anyway, HEIC always classifies via this converted buffer.

**Fix delivered:** `decodeHeicViaSips()` + `decodeToJpeg()` in `backend/src/worker.ts`; the whole pipeline (thumbnails, pHash, classify, reclassify) now runs off the decoded buffer. Verified directly against the real failing iPhone file. **Disclosed limitation:** the sips fallback is macOS-only — on Linux (Railway production) these specific over-the-limit Live Photos would still fail to decode; open gap, deferred until production deploy resumes.
**Status:** Fixed locally, verified against the exact reported file.

---

## #12 — Clicking a HEIC photo showed no preview, and "Date taken" was always Unknown

**Reported:** 2026-07-09/10
**Abhishek's report:** *"when i click on the photo to see but i can't see and also the date taken is also not present fix it"* (screenshot: broken viewer image + "Date Taken: Unknown")

**The bug (two parts):**
1. The photo viewer pointed its `<img>` at the **original file's** presigned URL — for a HEIC original, no browser except Safari can render that at all, so the viewer showed a broken image even though the pipeline had already generated perfectly good JPEG thumbnails.
2. EXIF extraction uses `exifr`, which (confirmed by inspecting its latest published build, 7.1.3) has **zero** HEIC container parsing support — so date/camera metadata for every iPhone photo silently came back null.

**Fix logic:** (1) The viewer should prefer the pipeline's own JPEG thumbnails (1200 → 400 → 150) and only fall back to the original URL when no thumbnail exists yet. (2) Add a sips-based EXIF fallback (`sips -g all`) for when exifr finds nothing — recovers date taken + camera make/model from HEIC.

**Fix delivered:** `viewerImageUrl()` in `frontend/src/components/PhotoViewer.tsx`; `extractExifViaSips()` in `backend/src/worker.ts`. **Disclosed limitations:** GPS coordinates aren't recoverable via sips (only date/make/model), and the fallback is macOS-only (same production gap as #11).
**Status:** Fixed locally, verified live with real iPhone photos.

---

## #13 — Real AI classification dumped temples, animals, and rivers all into one "Nature" folder

**Reported:** 2026-07-10
**Abhishek's report:** *"where there are only 2 folder and why not categorized... on what basis it mark the photos as duplicate fix all these things"* → then with Rekognition live: *"it classify building (temple), animals and nature (river) photo in one folder which is nature... fix this and classify according to the objects"*

**The bug:** The label→category table was built for the tiny mock vocabulary (a handful of words like `dog`, `landscape`, `outdoor`). Real Rekognition returns 10–15 labels per photo, mixing the actual subject (*Lion*, *Temple*, *Zebra*) with generic scenery labels (*Outdoors*, *Landscape*, *Scenery*) — the subject labels weren't in the table at all, the scenery ones were, and "Nature" also outranked "Animals" in the priority order. Net effect: nearly everything landed in Nature.

**Fix logic:** Teach the table the real Rekognition vocabulary, add a new **Architecture** category for buildings/temples/landmarks, and re-rank the priority order so specific-subject categories (People, Animals, Architecture…) beat the scenery catch-all (Nature, now last).

**Fix delivered:** Expanded `LABEL_TO_CATEGORY` + reordered `CATEGORY_PRIORITY` in `backend/src/lib/classification/categoryMapping.ts`; "Architecture" added to the search-category lists (backend + frontend). Verified live: lion/zebra/deer → Animals, temples → Architecture.
**Status:** Fixed, verified by Abhishek's own re-test ("now it is working fine") — with a precision follow-up filed as #15.

---

## #14 — Storage counter never went down after permanent delete, and a photo in Trash blocked re-uploading the same photo

**Reported:** 2026-07-10
**Abhishek's report:** *"if i deleted these photos permanently then why it showed 120 mb used. also i found out that if image is already present in the trash and again i upload the same photo then it considered it as a duplicate... also tell me the limit how many photos i can upload at a time"*

**The bug (two parts + one question):**
1. **Storage:** `User.storageUsedBytes` is a running counter incremented on every upload — but nothing anywhere ever decremented it. Permanent purge deleted the DB row and the stored file, yet the dashboard number stayed inflated forever.
2. **Trash-duplicate:** both dedup queries (exact SHA-256 and pHash near-dup, `backend/src/lib/dedup.ts`) matched against *any* prior photo — including one sitting in Trash. So re-uploading a photo whose only copy was trashed got flagged "duplicate" of a photo the user had deliberately thrown away.
3. **Upload limit (question, not a bug):** the endpoint is one-file-per-request by design; the frontend loops over selected files (3 in parallel). No count limit — only 50MB per individual file.

**Fix delivered:** `purgePhoto()` in `backend/src/lib/purge.ts` now decrements the owner's `storageUsedBytes` by the purged photo's size (clamped at 0, race-safe). Both dedup queries now filter `deletedAt: null`, so trashed photos can never be dedup "originals" — a re-upload of a trashed photo classifies as brand-new. Full backend suite re-run clean (200/200). Note: purges done *before* this fix aren't retroactively reconciled in the counter.
**Status:** Fixed, verified via automated tests; app restarted with both fixes live.

---

## #15 — Classification precision: incidental "Person" labels hijacked scene photos, one weak label ("Shark") hijacked a river photo — plus face-based People folders

**Reported:** 2026-07-10
**Abhishek's report:** *"still classification isn't working perfectly i still find some nature photos in people folder and one nature photo in animal folder... fix it immediately also fix the whole classification so it classify according to the photo i upload and also it create different people folders... if multiple people is present in one photo put those photos in group folder"*

**The bug (two mapping flaws left over from #13's first-match-wins design):**
1. Rekognition tags "Person" on almost any street/beach scene containing an incidental passer-by — and since People sat at priority #1, one generic "Person" label beat a dozen Architecture/Nature labels describing what the photo is actually OF.
2. All labels counted equally regardless of their own confidence — a hallucinated 50-something-% "Shark" on a river photo (its only Animals label) outranked thirteen high-confidence Nature labels because Animals > Nature in the priority order.

**Fix logic:** Replace first-match-wins with **confidence-weighted dominance scoring**: every mappable label above a 75% per-label confidence floor votes for its category with (its own confidence × its category's weight — scenery/Nature labels count half, since Rekognition attaches them to any outdoor photo). Highest total wins; the fixed priority order only breaks exact ties. A real portrait (Person + Adult + Male + Man = four People votes) still wins; a lone "Person" on a temple photo loses to the building's own labels. Per-label confidences now flow through from Rekognition (`labelConfidences` on `ClassificationResult`).

**Face-based People folders (new capability, same pass):** photos classified People are refined via Rekognition's face APIs (`backend/src/lib/classification/faces.ts`, one face collection per owner): 2+ clear faces → **"Group"** folder; exactly 1 face → matched against previously-seen faces → a stable **"Person N"** folder per real-world person (new people are enrolled automatically); no clear face (e.g. back-of-head) or any face-API failure → plain **"People"** (graceful fallback, never a pipeline failure). Requires 5 extra IAM actions (DetectFaces, CreateCollection, SearchFacesByImage, IndexFaces, ListFaces) — without them everything simply stays in "People".

**Fix delivered:** Rewritten `mapToCategory()` + expanded vocabulary in `categoryMapping.ts`; `labelConfidences` in `lib/classification/index.ts`; new `lib/classification/faces.ts`; worker passes the decoded image into folder assignment for face refinement. All 8 real label sets from Abhishek's screenshots verified mapping to the right category; full backend suite 200/200.
**Status:** Fixed and built; awaiting Abhishek's manual re-test + the IAM policy additions for the face features.

---

## #16 — A street photo with a tiny incidental person landed in "Person 1"

**Reported:** 2026-07-10
**Abhishek's report:** *"why this photo comes in people"* (a Marine Drive street scene — palm trees, buildings, lamp posts — filed into the "Person 1" face folder)

**The bug:** Rekognition tags one detected face with a whole cluster of near-synonymous labels (Face, Head, Portrait, Person, Adult, Male, Man) — six-plus People votes from ONE incidental passer-by, out-scoring the photo's actual subject (Building, Office Building, High Rise, ...) in #15's dominance scoring. Label counting fundamentally can't distinguish "a portrait" from "a person happens to be in frame" — but face geometry can.

**Fix logic:** The face refinement step already calls DetectFaces, which returns each face's bounding box — so use the face's SIZE. A face covering less than ~1.5% of the image area is an incidental passer-by, not the subject. In that case the photo isn't a People photo at all: reject the People verdict entirely and re-rank the photo's OTHER matched categories (new `rankCategories()` export returns the full scored list, not just the winner) so it lands where its remaining labels point (Architecture, for this photo).

**Fix delivered:** `MIN_FACE_AREA_RATIO` prominence gate in `backend/src/lib/classification/faces.ts` (returns null = "reject People"); worker falls through the category ranking on rejection; missing Architecture vocabulary added (office building, high rise, apartment building, condo, city, urban, skyscraper). Verified by reclassifying the exact reported photo: "Person 1" → "Architecture".
**Status:** Fixed, verified against the reported photo. Shipped in `0f9a732`.

---

## #17 — Phones, laptops, and headphones all dumped in Uncategorized

**Reported:** 2026-07-10
**Abhishek's report:** *"why these photos are in uncategorized did amazon api not recognize what these photos are and create a category and add these photos in that folder if category is not availabe also add that category when new catgory came"* (screenshot: 6 electronics product photos, all labeled perfectly by Rekognition at 1.00 — Electronics, Iphone, Laptop, Headphones — all in Uncategorized)

**The bug:** Rekognition recognized everything; OUR curated label→category table simply had no Electronics vocabulary, so rich correct labels matched nothing and fell through. More fundamentally: any photo whose subject wasn't in our hand-written table was doomed to Uncategorized, forever, no matter how well the AI understood it.

**Fix logic (two layers):**
1. **Electronics as a first-class curated category** with full vocabulary (phone, iphone, laptop, camera, headphones, monitor, ...).
2. **Dynamic category creation** — exactly what Abhishek asked for: Rekognition's DetectLabels response tags every label with its own ~40-entry top-level taxonomy ("Iphone" → "Technology and Computing"), which we had been throwing away at the provider boundary. Now passed through (`labelTaxonomies` on ClassificationResult); when no curated category matches, the dominant taxonomy category names the folder — mapped to friendly short names (`TAXONOMY_TO_CATEGORY`) where known, used verbatim otherwise — and `findOrCreateFolder` auto-creates it. A brand-new KIND of photo now mints a brand-new category instead of dying in Uncategorized. (Noise taxonomies like "Colors and Visual Compositions" are excluded from ever naming a folder.)

**Fix delivered:** `backend/src/lib/classification/index.ts` (taxonomy pass-through), `categoryMapping.ts` (Electronics vocab + taxonomy fallback in `rankCategories`), "Electronics" added to both search-category lists. Verified: all 6 reported photos → Electronics on reclassify; dynamic fallback observed live minting "Tools" and "Weapons and Military" folders for photos with no curated match.
**Status:** Fixed, verified live. Shipped in `0f9a732`.

---

## #18 — Utensils and furniture lumped into one folder

**Reported:** 2026-07-10
**Abhishek's report:** *"i have tested the application and find out that it put utensils and furniture in one folder fix this issue... so that this would never happen again"*

**The bug:** #17's new taxonomy fallback mapped THREE different Rekognition taxonomy branches — "furniture and furnishings", "kitchen and dining", AND "home and indoors" — to one shared "Home" folder. Couches and cutlery, same bucket. A granularity mistake in the mapping table, not a detection failure (labels were perfect: Furniture/Chair/Couch vs Cutlery/Spoon/Cookware).

**Fix logic:** Two layers again. (1) **Kitchen** and **Furniture** become first-class curated categories with full vocabulary, so these object families never even reach the fallback. (2) A standing **granularity rule** documented in the taxonomy map itself: one taxonomy branch = one folder, never merged — the coarse-shared-bucket pattern is exactly how unrelated object families end up mixed, so it's now structurally forbidden for future mappings.

**Fix delivered:** `categoryMapping.ts` (Kitchen + Furniture vocab, taxonomy map split, granularity rule comment), both search-category lists updated. Verified against all 6 misfiled photos' exact stored label sets, then live-reclassified: cookware + cutlery → Kitchen, armchair/coffee table/bench/couch → Furniture, "Home" folder emptied.
**Status:** Fixed, verified live via reclassify of every affected photo.

---

## Log format for future entries

Each new entry follows this shape:
- **#N — [short title]**
- **Reported:** date
- **Abhishek's report:** what he said, roughly verbatim
- **The bug:** what was actually wrong and why
- **Fix logic:** the reasoning behind the chosen fix
- **Fix delivered:** what got built/changed, with commit hash(es)
- **Status:** Fixed / verified how
