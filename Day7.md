# Day 7

Covers everything built after `Day6.md` (which ended at the Trash system + multi-select UI, commit `37cfd14`, all pushed). This stretch was almost entirely **bug-fix-driven** — Abhishek dogfooding the Trash system and guest-sharing feature in real usage and reporting issues one at a time, each one logged with full before/after detail in `Bugs.md` (the new standing bug tracker created this stretch — see below). No new spec/roadmap item was planned this stretch; every change here traces back to a specific bug report or a direct question Abhishek asked.

## What Day 7 covered, in one sentence

`Bugs.md` was created as the permanent, cumulative bug log (backfilled with bugs #1–#4 from Day6-era fixes); six more bugs (#5–#10) were found, fixed, tested, and logged in it across three areas — the Trash system's folder-purge cascade, the `/organize` multi-select action bar, and guest sharing (permission changes, per-folder access, forced downloads, and a new link-forwarding detection feature) — plus one same-day regression on the Trash fix itself (#6 superseded #5's first attempt) and one honestly-disclosed self-inflicted incident (#8d, a diagnostic mistake, not a code bug).

## `Bugs.md` — new standing artifact this stretch

Root-level `Bugs.md`, created at Abhishek's explicit instruction: *"update this file everytime whenever i asked you to fix the bug"* — every future bug report + fix gets a new numbered entry here, permanently, without being asked again each time. Format per entry: what Abhishek reported (near-verbatim), what was actually wrong and why, the fix logic, what was delivered (with the reasoning), and verification status. Currently at **10 entries**. Read this file first when picking up any future bug-fix session — it's the authoritative history of every issue found in real usage, in order.

## Bug #5 — Permanently purging a folder from Trash also destroyed an already-independently-trashed photo

**The bug:** `purgeFolder()` (`backend/src/lib/purge.ts`) hard-deleted every photo still pointing at a folder being purged — including a photo the user had separately, deliberately soft-deleted *before* trashing the folder. That photo had its own independent 7-day clock, but got swept into the folder's destruction anyway.

**The fix:** split a purged folder's photos into live vs. already-trashed before acting. Live photos are still hard-deleted (unchanged T5 decision). An already-trashed photo is **decoupled** — `folderId` set to `null` — instead of destroyed, since the DB has no cascade on `Photo.folderId` (the app already had to delete children before the folder row to avoid an FK violation; this just changed *which* children get deleted vs. detached).

## Bug #6 — The fix for #5 needed its own follow-up: don't silently drop the survivor into Unfiled

**The bug:** #5's decoupled photo restored straight into Unfiled with no prompt — the user wanted to be asked, not have that decision made for them, mirroring how the app already handles "folder still trashed but conflicting" (bug #4's fix).

**The fix:** added `Photo.deletedFolderName` (new column, set by `purgeFolder()` when decoupling) so restore can detect "this photo's folder is permanently gone" and ask: `409 { error: "folder_deleted", originalFolderName, liveFolders }`, resolved via `onConflict: "existing" + targetFolderId` or `onConflict: "new" + optional newName`. New `FolderGonePanel` on the Trash page's photo-recover flow.

## Bug #7 — Multi-select could only Delete; no Move, no Download, no per-photo Download

**The bug:** the `/organize` selection bar (built for bug #3b) only ever had one action. No way to move a batch of selected photos to another folder, no way to download a batch, and no download button on an individual card at all.

**The fix:** `POST /api/photos/bulk-move` (partial-success, same shape as bulk-delete, reconciles `photoCount` both sides) and `POST /api/photos/download-many` (zips a caller-chosen id set, reusing the existing folder-zip streaming code). Selection bar gained "Move to…" and "Download selected"; every card gained its own "Download" button.

## Bug #8 — Four separate guest-sharing gaps in one report

- **8a — No way to change a guest's permission after sharing.** Only Revoke existed. Added `PATCH /api/guests/:id { permissionLevel }` — updates every live folder share for that guest at once, takes effect immediately on their already-open session (no re-approval). Guests page got a permission dropdown next to Revoke.
- **8b — Guest "Download" opened a new tab instead of saving the file.** A plain pre-signed MinIO URL has no `Content-Disposition`; `window.open` just navigated to the image. Added `getPresignedDownloadUrl()` (sets `response-content-disposition=attachment`), used only by Download buttons — never the viewer/lightbox URL, which stays a display URL.
- **8c — No multi-select download for a guest at plain `download` level.** The existing "Download all" zip is deliberately gated to the stricter `download_all` level. Added `POST /api/guest/photos/download-many`, working at `download` level, plus checkboxes + "Select all on page" + "Download selected" on the guest portal.
- **8d — Not a code bug.** The "stuck pending" guest Abhishek asked about turned out to be caused by me: fetching his OTP earlier that session, I polled `GET /api/invites/requests/:id/status` directly from a terminal `curl` to check on it — that endpoint's job is to mint the guest's one-time session onto whoever polls it first, and my diagnostic call claimed and discarded it. Logged transparently, with a process note to future-self: never poll that endpoint outside the real guest browser; use the read-only OTP-fetch and owner-side list endpoints instead, which have no claim side-effect.

## Bug #9 — No way to add/remove individual folders for an already-approved guest

**The bug:** once approved, a guest's folder set was frozen — the only lever was all-or-nothing Revoke.

**The fix:** `POST /api/guests/:id/folders` (share additional folders at the guest's current level; idempotent on already-shared, reactivates a previously-removed folder's row rather than erroring on the schema's one-row-per-pair unique constraint) and `DELETE /api/guests/:id/folders/:folderId` (remove just one folder, leaving the rest untouched). Guests page shows each shared folder as a removable chip plus a "+ Add folders" picker.

## #10 — Link-forwarding detection (a question that surfaced a real gap)

Abhishek asked how to detect a guest forwarding their invite link to someone else. Investigation found: the link is genuinely single-use (dead forever after one approval), and the owner already sees the first click's IP/device — but if a *second* person clicked the same link while the first request was still pending, that click was silently absorbed into the existing pending request (correctly, to avoid OTP-per-click spam) with **zero record of who that second click was**.

**Fix:** new `AccessRequestTouch` table — one row per click on a pending link (IP + user-agent), written for every click including the first. `GET /api/access-requests` now returns `touchCount` / `distinctDeviceCount` / `multipleDevicesDetected` per pending request. The Guests page shows an amber warning — *"⚠ This invite link was opened from N different devices/networks... possibly forwarded to someone else. Review before approving."* — framed explicitly to Abhishek as a signal to review, not proof (can't distinguish "forwarded" from "guest switched networks").

## Small copy fix (not logged in Bugs.md — cosmetic, not a bug report)

The three "can't delete/merge — shared with a guest" dialogs (photo delete, folder delete, folder merge) had a redundant "Server returned 409. Nothing was deleted." sub-line under the already-clear plain-language message. Removed from all three at Abhishek's request.

## Schema additions this stretch

Two small additive migrations, both applied and safe (no backfill needed, no destructive change):
- `20260708124522_add_deleted_folder_name` — `Photo.deletedFolderName String?` (bug #6).
- `20260708221809_add_access_request_touches` — new `access_request_touches` table (feature #10).

## Testing

Every fix in this stretch got new backend tests alongside it, run against the full suite each time (never just the new file in isolation, except to confirm a flake was pre-existing). Suite grew from **177 → 200** tests across this stretch. Two flakes were encountered and confirmed pre-existing/unrelated by re-running the affected file alone (both passed cleanly): the already-documented `classification.smoke.test.ts` worker-queue timeout under full-suite concurrent load, and a `auth.smoke.test.ts` rate-limit-bucket carryover. Neither reproduces in isolation; neither is new to this stretch.

No frontend browser-automation testing was done this stretch either (same known gap carried from Day6 — no Playwright installed in this environment); every UI change was typechecked and, where the affected flow could be exercised via direct API calls (e.g. the OTP flow, restore flows), verified that way.

## Where things stand after Day 7

Ten bugs total now logged in `Bugs.md`, all fixed and tested. Backend suite: 200/200 passing. Frontend and backend both typecheck clean. The app was restarted locally after every single fix this stretch (a standing habit from Day6, continued) — never left running stale code between fixes. Nothing has been pushed yet as of the start of this entry; this stretch's commits are about to be pushed to `feature/ai-classification` (never `master`, no PR — `master`/`main` still doesn't exist on the remote), per Abhishek's explicit go-ahead.

Carried-forward open items (unchanged from Day6, still optional, still awaiting a decision whenever): the browser-automation verification gap; the "spill to Unfiled instead of hard-delete on folder purge" future feature (still logged, still not built — bug #5/#6 only changed behavior for photos *already independently trashed*, not the live-photo cascade itself); the intermittent test-suite flakes (connection-pool tuning candidate); deferred dependency majors (Next.js, vitest); a dev-DB clean-slate wipe.
