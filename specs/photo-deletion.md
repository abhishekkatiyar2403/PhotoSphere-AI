> **SUPERSEDED 2026-07-08 by `specs/trash-system.md`.** Abhishek made an explicit product decision requiring soft-delete + a 7-day Trash with Recover/Delete-permanently/Empty-trash, overriding this spec's PD1 recommendation (hard delete). This spec's PD3 (duplicate-chain cascade-null), PD4 (photoCount reconciliation), PD5 (bulk-delete partial-success shape), and PD7 (confirm-copy discipline, now inverted — see the new spec) analysis is REUSED, not overridden, by `trash-system.md` — read that spec as the current build target for photo deletion. Kept here for the reasoning trail; do not build against PD1/PD2 as written below.

# Spec — Photo Deletion (single + bulk)

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 11 (photo management CRUD) — the roadmap's photo lifecycle never actually specified a delete path; this closes a real gap confirmed via direct user testing ("no option to select multiple photos so that user can delete a single photo").
**Status:** draft — awaiting Abhishek's look at PD1/PD2 before Developer builds
**Written by:** Planner Agent, 2026-07-08

## Problem

There is currently NO way to delete a photo in PhotoSphere AI, single or bulk. Confirmed via code search: no `DELETE /api/photos/:id`, no bulk-delete route, no "select multiple" UI mode on `/organize` or `/browse`. A photo that's a mistaken upload, a true duplicate the user wants gone rather than just reclassified, or something the user simply no longer wants has no removal path at all — the only "management" verbs today are move (`PATCH /api/photos/:id`) and reclassify (`POST /api/photos/:id/reclassify`). This was surfaced directly by Abhishek clicking through the app looking for a delete option and finding none.

## Hard constraints (carried from CLAUDE.md + established conventions)

- Local-first slice only — no new cloud service.
- `requireAuth` + `asyncHandler` + Zod on every new route, exactly like `backend/src/routes/photos.ts`'s existing endpoints.
- 404, not 403, on any ownership mismatch — never confirm a non-owned photo's existence.
- Owner-scoped throughout; opaque session tokens unaffected.
- `Folder.photoCount` reconciliation via `serializableTransaction()` wherever a delete removes a photo from a real folder (`Day2.md` house rule — same pattern as `PATCH /api/photos/:id`'s move logic and P4's merge/delete).
- Additive-only if any schema change is needed at all (see PD1 — the recommended default needs none).

## Goals

- Give the owner a way to permanently remove a photo they no longer want, for one photo and for many at once.
- Keep the duplicate-chain invariant (`lib/dedup.ts`) intact — deleting never creates a dangling reference that breaks a live invariant guarantee, and never silently resurrects cycle risk.
- Keep folder counts and the Unfiled surface correct after any delete.
- Make the guest-sharing interaction as safe as P4's F1 guard made folder deletion — a single photo delete must not be able to surprise or dispossess a guest mid-session without an explicit signal to the owner.
- Ship a backend that's fully buildable and Tester-verifiable over HTTP independent of the UI decision (PD6).

## Non-goals (explicitly out of scope for this pass)

- A "trash"/recycle-bin UI surface (list of soft-deleted items, restore button) — only in scope if PD1 picks soft-delete, and even then this pass only covers the flag + hiding, not a dedicated recovery UI.
- Bulk operations beyond delete (bulk move, bulk reclassify) — not requested, not scoped here.
- Deleting an entire folder's worth of photos as a side effect of anything other than an explicit multi-select (folder delete-to-Unfiled already exists via P4 and is untouched by this spec).
- Any change to the duplicate-detection algorithm itself (`lib/dedup.ts` phase 1/2 logic) — only what happens to *existing* rows referencing a deleted photo (PD3).

## Scope for this pass

Both the single-photo and bulk endpoints, backed by the same shared deletion logic; the multi-select UI (thin round or full round per PD6, but backend is buildable now regardless).

## Decisions to scope (each flagged, recommended default, none silently picked)

### PD1 (LOAD-BEARING) — Hard delete vs soft delete

**Options:**
- (a) **Hard delete** — remove the `Photo` row and its MinIO objects (original + all thumbnail sizes) irreversibly.
- (b) **Soft delete** — add a `deletedAt` (or `status = 'deleted'`) flag, hide the row from every listing surface, keep the row + MinIO objects, no recovery UI this pass (trash surface deferred).

**Recommended default: (a) hard delete.** Justification: this project's stated destructive-action precedent (P4's folder-delete) is itself *non-destructive to photos* (F2 moves them to Unfiled, doesn't touch bytes) — there is no existing "soft delete" pattern anywhere in the schema to extend, and introducing one now means a new column, a new hidden-everywhere filter threaded through every photo listing query (`/unfiled`, `/folders/:id/photos`, `/search`, guest routes), and an implicit promise of recoverability with no UI to fulfill it this pass — worse than not having the feature (a user thinks they can recover something that in practice they can't, since there's no restore surface). A confirm-before-destroy UX (PD7, hard constraint) is the correct mitigation for "irreversible," not a half-built trash can. Recommend hard delete now; a real trash/soft-delete surface is a clean, separately-scoped follow-up if Abhishek wants undo-safety later.

**If hard delete:** `lib/storage.ts` currently has NO delete capability (`putObject`, `getPresignedGetUrl`, `getObjectStream` only) — **new** `deleteObject(key: string)` (single `DeleteObjectCommand`) is required, and for the original + each present thumbnail size this is either one call per key or a `deleteObjects` batch call. Given the low key-count per photo (1 original + up to 3 thumbnails), sequential `deleteObject` calls are sufficient — no need for the batch `DeleteObjectsCommand` variant. MinIO delete failure handling: if the object never existed (already gone / never finished processing) treat as a no-op success, not an error (mirrors `getPresignedGetUrl`'s "omit rather than error" thumbnail philosophy in `GET /:id`); if a genuine MinIO error occurs, the DB row should NOT be left half-deleted — see ordering below.

**Delete ordering (to avoid orphans in either direction):** delete the DB row first inside the transaction (so a concurrent read never sees a row pointing at now-missing bytes), then best-effort delete the MinIO objects after commit. Rationale: an orphaned MinIO object with no DB row is inert dead storage (acceptable, cleanable later); an orphaned DB row pointing at deleted bytes would break `GET /:id`'s pre-signed URL generation and any zip/download path (P5) with a hard failure. This mirrors the "correctness of the DB state wins, storage cleanup is best-effort after" principle already implicit in the upload handler's rollback-on-MinIO-failure (which is the mirror-image case — there, the DB row is rolled back because storage failed; here, storage cleanup happens after DB success and its failure is merely logged, never rolled back into resurrecting the row).

### PD2 (LOAD-BEARING, mirrors P4's F1) — Deleting a photo currently reachable by a guest

A photo's *folder* may have a live `folder_permission` (checked via `hasLivePermission(folderId)`, the exact helper `routes/folders.ts` already has for F1 — reusable as-is, or promoted to a shared lib if Developer prefers, Developer's call, non-load-bearing).

**Options:**
- (a) **Block with 409** while the photo's folder is live-shared — same posture as F1 ("revoke the share first").
- (b) **Allow deletion regardless** — the guest simply gets a 404 on that photo next time they load it or its thumbnail, same as any other missing resource; no special guard.

**Recommended default: (b) allow deletion regardless — no F1-style block for single/bulk photo delete.** Justification, explicitly contrasted with F1: F1 exists because folder merge/delete acts on the **entire shared scope at once** — merging silently re-parents a guest's *entire granted view* into a different, possibly-more-sensitive folder (privilege escalation risk) or entire-folder-delete severs the *whole relationship* the owner explicitly set up, both surprising and irreversible-feeling for the owner who forgot the share existed. A single photo inside a shared folder is categorically lower blast-radius: the guest's grant is on the *folder*, not the photo — deleting one photo out of possibly many doesn't touch the grant itself, doesn't move anything into a scope the guest didn't already have, and behaves exactly like a guest hitting any other already-removed resource (a normal, already-handled 404 path, not a new failure mode). Blocking every single-photo delete because *a* folder happens to be shared would make photo management materially harder for any owner who shares folders at all, for a risk (a guest momentarily surprised by one missing photo) that's far smaller than F1's (an entire relationship silently changing). Veto toward option (a) if Abhishek judges "guest sees a photo disappear without the owner being warned" as unacceptable even at this scale — in that case, recommend the *guest-visible-but-not-live-shared-yet* nuance doesn't apply (an active session isn't a live-view lock, so even a block wouldn't prevent an already-open browser tab from having cached the image) so a block would need a corresponding decision on whether a bulk-delete inside a shared folder is where the line should actually be drawn instead (see PD5 note).

**Not audited by this path** unless PD2 differs from the above — since PD1 already establishes hard-delete-with-confirm is the primary safety net, and this isn't a "who accessed shared content" event (that's what `photo_viewed`/`photo_downloaded` already cover for guests). Delete itself IS audited (see hard requirement 4 below), just not specially flagged for the shared-folder case.

### PD3 — The duplicate-chain reference problem

Two sub-cases, per `lib/dedup.ts`'s invariant (edges point strictly-older, non-duplicate):

**3a. Deleting photo A, where some photo B has `duplicateOfPhotoId = A.id` (B points at A as its original).**

**Options:**
- (i) Block A's deletion (409, "in use as a duplicate's original") until B is reassigned/deleted first.
- (ii) Cascade: on deleting A, find all B's pointing at A and null their `duplicateOfPhotoId` (B becomes an orphan `duplicate`-status photo with no original recorded).
- (iii) Leave dangling: delete A, do nothing to B; B's `duplicateOfPhotoId` becomes a stale string pointing at a no-longer-existent row (already possible today with zero enforcement, since — confirmed in `Day2.md`/schema — `duplicateOfPhotoId` is a plain `String?` column, NOT a Prisma/DB foreign-key relation; nothing currently enforces referential integrity on it).

**Recommended default: (ii) cascade-null.** Justification: (i) blocking is the worst UX outcome for the single most likely real scenario (a user deleting an old duplicate-original photo they no longer want, forgetting or not caring that a later upload was flagged as its duplicate) and adds a whole new "in use" concept nothing else in the schema has. (iii) leave-dangling is technically zero-cost (matches "no FK enforcement" reality) but leaves a photo's `GET /:id/status` `duplicateOfPhotoId` pointing at nothing — any UI reading it (the "duplicate of X" label mentioned in `GET /:id`'s own code comment) would either silently 404 the lookup or need a defensive null-check anyway; better to proactively null it at delete time (a single `updateMany({ where: { duplicateOfPhotoId: A.id }, data: { duplicateOfPhotoId: null } })` in the same transaction) than let every future reader carry that defensive burden. B keeps its `aiClassificationStatus = 'duplicate'` (that verdict itself is still true/informative — B *was* found to be a byte/near match of *something*), it just no longer names a specific original — equivalent in spirit to "the original this was flagged against is gone." This is a plain data-hygiene cascade, not a business-logic re-evaluation (B is NOT re-run through dedup, NOT promoted back to a folder — that would be reclassification, a separate, existing, user-triggered path via `POST /:id/reclassify` if the user wants B treated as an original now).

**3b. Can a `duplicate`-status photo (B) itself be deleted freely?**

**Recommended: yes, no special-case.** B has nothing pointing *at* it under the dedup invariant (the invariant only allows edges to point at non-duplicates), so deleting B can never orphan a third photo C's `duplicateOfPhotoId` — the invariant structurally guarantees B is always a leaf in the duplicate graph. Deleting B is exactly as safe as deleting any other terminal-status photo; no extra guard needed.

### PD4 (hard requirement, not a decision) — Folder `photoCount` reconciliation

Deleting a photo with a non-null `folderId` MUST decrement that folder's `photoCount` inside the same `serializableTransaction()` that deletes the row (same guarded-decrement pattern already used by `PATCH /api/photos/:id`'s move logic: `updateMany({ where: { id: folderId, photoCount: { gt: 0 } }, data: { photoCount: { decrement: 1 } } })` — never decrement below 0, never a live re-`COUNT`). For bulk delete, this means grouping the batch by `folderId` and applying one guarded decrement per affected folder for the count of photos actually deleted from it, all inside the same transaction as the row deletes (or the batch's per-item transactions — see PD5's atomicity choice, which determines whether this is one txn for the whole batch or one per item).

### PD5 (LOAD-BEARING) — Bulk delete: one endpoint, and its atomicity

**Options:**
- (a) **`POST /api/photos/bulk-delete { photoIds: string[] }`, all-or-nothing** — any single ownership-mismatch/not-found id fails the whole batch (409/404), nothing deleted.
- (b) **Same endpoint, partial-success-with-per-id-result-list** — `{ deleted: string[], failed: [{ id, reason }] }`, each id processed independently; a bad id doesn't block the good ones.
- (c) **No dedicated endpoint — client loops the single-delete endpoint N times.**

**Recommended default: (b) one endpoint, partial-success with a per-id result list.** Justification: (c) is rejected because a multi-select "delete N photos" is a single user intent and deserves a single request/response the UI can render as one outcome, not N round-trips the frontend has to reduce itself (and N separate rate-limiter hits — see below); it also means N separate DB transactions instead of one batched operation, worse for the exact `photoCount` reconciliation in PD4. (a) all-or-nothing is rejected because the most likely real failure mode — the user selected 8 photos, one of which was already deleted in another tab/request, or belongs to a folder mid-merge — shouldn't block the other 7 from going away; that's a worse UX than "7 deleted, 1 already gone" for a destructive-and-idempotent-in-intent operation. Recommend: process each id independently inside its own attempt (ownership check individually, so a foreign/bad id is silently reported `not_found` rather than 404ing the whole batch and leaking nothing about *why* — same "404 not 403" spirit, just per-item), batch the `photoCount` decrements per folder as one reconciliation pass at the end for efficiency, and return `{ deleted: string[], failed: [{ id: string, reason: "not_found" }] }` with a 200 (the batch itself "succeeded" as an operation even if some items were no-ops). Cap the batch size (recommend reusing the search endpoint's established `limit`-style cap philosophy: reject `photoIds.length > 100` with 400 — an arbitrary-but-generous bound, matching the project's existing "hard cap, not silent clamp" house rule from P6/P5). Rate-limiting: an owner bulk-deleting their own data isn't abuse-prone the way upload/reclassify are (no compute/storage cost being *incurred*, only freed) — recommend **no new rate limiter**, consistent with `PATCH /api/photos/:id` (move) having none either.

### PD6 — The multi-select UI

**Options:**
- (a) **Full propose→pick→build wireframe round**, same treatment P4's kebab menu got — select-mode toggle, checkboxes on `PhotoCard`, a "Delete selected (N)" action bar, a confirm dialog.
- (b) **Thin addition** — no wireframe round, Developer builds a minimal-but-functional select/delete affordance directly (e.g. reusing `PhotoCard`'s existing action-area convention from the 2026-07-08 Unfiled-manual-move fix) with only a one-line "where + how it looks" confirmation, similar to how P5's "Download all" button was treated as thin.

**Recommended default: (a) full wireframe round.** Justification, contrasted with P5's "thin" precedent: P5 was a single new *button* on an existing surface with no new interaction mode — clicking it either works or doesn't, there's no new mode to enter/exit. Multi-select is structurally closer to P4's kebab menu (explicitly called "a genuine interaction" needing its own round) — it introduces a **new mode** across the grid (individual cards change appearance/behavior once select-mode is on), a **new persistent action bar**, and a **destructive confirm dialog** whose copy matters a lot (see PD7). This is at least as significant a new interaction pattern as P4's kebab, arguably more so since it spans every card on the page simultaneously rather than one per-folder menu. Recommend the round; however, per the instructions, **the backend (PD1–PD5) is fully buildable and Tester-verifiable over HTTP without waiting for this decision** — Developer can ship `DELETE /api/photos/:id` + `POST /api/photos/bulk-delete` now, and the UI round happens independently whenever Abhishek is ready to look at wireframe options.

### PD7 (hard constraint, not a decision) — Confirm-before-destroy UX requirement

Any hard-delete UI path MUST require an explicit confirm step before firing the delete request(s). The confirm copy MUST be honest about irreversibility — this is the deliberate inverse of P4's delete-to-Unfiled confirm copy, which is correctly reassuring ("photos move to Unfiled, not deleted") because that operation is genuinely non-destructive. A photo-delete confirm must NOT reuse similarly soft/reassuring language (no "moved," no "can be restored," no ambiguous "removed") since PD1's recommended default makes this truly irreversible — copy should say plainly that the photo(s) will be permanently deleted and cannot be recovered. This applies however PD6 resolves; even a thin UI still needs a real confirm (e.g. a native `window.confirm` at minimum is NOT acceptable given PD1 = hard delete — it must be an in-app dialog that can carry the honest copy and, ideally, show what's about to be deleted).

## Endpoints (scoped, pending PD1/PD2/PD3/PD5 confirmation)

- **`DELETE /api/photos/:id`** — single photo. `requireAuth`. 404 on not-found/not-owned (existing convention). Runs PD3a's cascade-null + PD4's folder-count decrement inside one `serializableTransaction()`, deletes the DB row, then best-effort deletes MinIO objects (original + any present thumbnails) post-commit per PD1's ordering. Audited (`photo_deleted`, new additive `AuditAction` string in `lib/audit.ts`, actorType `owner`, success-path-only, fire-and-forget via `logAudit()` — mirrors `folder_deleted`'s pattern exactly). Returns `200 { deleted: true, photoId, folderId: string | null }` (folderId = the folder it was removed from, or null if it was already Unfiled) so the frontend can locally decrement a count without a re-fetch, matching the existing move-endpoint response shape convention.
- **`POST /api/photos/bulk-delete`** — body `{ photoIds: string[] }`, Zod-validated (non-empty array, max 100, each a string — UUID format check optional but recommended). `requireAuth`. Per-item processing per PD5; batched folder-count reconciliation; one `photo_deleted` audit row **per successfully deleted photo** (not one row for the whole batch — matches the audit log's existing one-row-per-resource-event granularity, e.g. `folder_merged`/`folder_deleted` are per-folder, not per-photo-moved). Returns `200 { deleted: string[], failed: [{ id: string, reason: "not_found" }] }`.

Both endpoints reuse `findOwnedFolder`-style patterns already in `routes/photos.ts`/`routes/folders.ts`; no new middleware needed (no guest-facing delete endpoint — deletion is owner-only, guests never delete anything, consistent with every existing guest route being read/download-only).

## Acceptance criteria

Legend: `[Tester-live]` = verified via a live HTTP/DB/MinIO check against the running stack; `[Developer-verified]` = confirmed via unit/integration test + code inspection, acceptable when a live check is impractical.

- [ ] [Tester-live] `DELETE /api/photos/:id` on an owned, real photo returns 200; the `Photo` row is gone from the DB; the original AND every present thumbnail object are gone from MinIO (checked via a direct MinIO read attempt failing, not just a DB assertion).
- [ ] [Tester-live] `DELETE /api/photos/:id` on a non-owned or nonexistent photo returns 404 (never 403), for both cases indistinguishably.
- [ ] [Tester-live] Deleting a photo that has a real `folderId` decrements that folder's `photoCount` by exactly 1, verified against a live re-`COUNT` of remaining photos in that folder (no drift), via `serializableTransaction()`.
- [ ] [Tester-live] Deleting a photo already `folderId = null` (Unfiled) succeeds and does not touch any folder's `photoCount`.
- [ ] [Tester-live] (PD3a) Deleting photo A that has a duplicate B (`B.duplicateOfPhotoId = A.id`) succeeds; after deletion, `GET /api/photos/:id` (or `/:id/status`) for B shows `duplicateOfPhotoId: null`, B's `aiClassificationStatus` remains `duplicate`, and B's own row/bytes are untouched.
- [ ] [Tester-live] (PD3b) Deleting a `duplicate`-status photo B (that has no photo pointing at it) succeeds with no side effects on any other photo.
- [ ] [Tester-live] (PD2 recommended default) Deleting a single photo inside a folder that has a live guest `folder_permission` succeeds (200, no 409 block) — the guest's OTHER photos in that folder remain reachable; a subsequent guest request for the deleted photo's detail/thumbnail returns 404 (same as any other missing resource), not a 500 or a leak.
- [ ] [Tester-live] `POST /api/photos/bulk-delete` with a mix of valid-owned, non-owned, and nonexistent ids returns 200 with the valid-owned ones in `deleted` and the rest in `failed` with `reason: "not_found"` — partial success, nothing all-or-nothing blocked.
- [ ] [Tester-live] Bulk-deleting photos spanning two different folders correctly decrements BOTH folders' `photoCount`s by the right amount each (no cross-folder drift), verified against live re-`COUNT`s.
- [ ] [Tester-live] `POST /api/photos/bulk-delete` with more than 100 ids returns 400 (cap, not silent truncation); empty array returns 400.
- [ ] [Tester-live] No session/unauthenticated request to either endpoint returns 401.
- [ ] [Tester-live] A successful single delete writes exactly one `photo_deleted` audit row (`actorType: owner`); a successful bulk delete writes exactly one `photo_deleted` row per photo actually deleted (none for `failed` entries); a failed/404/401 attempt writes zero rows.
- [ ] [Developer-verified] `lib/storage.ts`'s new `deleteObject` treats a not-found object as a no-op success, not a thrown error (unit-testable in isolation).
- [ ] [Developer-verified] MinIO cleanup failure after a successful DB delete is logged, never resurrects/rolls back the already-deleted DB row (matches the fire-and-forget "never break primary" philosophy, applied here to storage cleanup rather than audit).
- [ ] [Tester-live or Developer-verified, per PD6] Whatever UI ships (thin or full round): selecting one or more photos and confirming delete actually removes them from the visible grid without a full page reload being required, and the confirm dialog copy is unambiguous about permanence (manual/browser-DOM check once built).

## Success signal

Tester can, against the local stack: seed an owner with a real folder containing 3 photos (one of which — B — is `duplicate`-status pointing at another photo A in the same folder), delete A directly and confirm B's `duplicateOfPhotoId` goes null while B survives and the folder's `photoCount` drops correctly; then bulk-delete the two remaining real photos plus one bogus id in a single `bulk-delete` call and confirm the response correctly reports 2 deleted + 1 not_found, the folder count lands at 0, both photos' MinIO objects are gone, and exactly 2 `photo_deleted` audit rows exist. Separately, share a different folder to a guest, delete one (not all) of its photos as the owner, and confirm the guest's other photos in that folder remain fully reachable while the deleted one 404s cleanly for the guest.

## UI wireframe round note

Per PD6: recommend treating multi-select-and-delete as needing its own propose→pick→build round (like P4's kebab menu), not a thin add (unlike P5's button) — but this is explicitly NOT a blocker for building the backend. Developer should build and Tester should verify `DELETE /api/photos/:id` + `POST /api/photos/bulk-delete` now; the wireframe round for `/organize`/`/browse`'s select-mode + action bar + confirm dialog can happen on its own schedule whenever Abhishek is ready, exactly as P4/P6's rounds were queued independently of their backends.

## Open questions / Pending Decisions (to also post to agents/STATUS.md)

- **PD1 (LOAD-BEARING):** hard delete (row + MinIO objects, irreversible) vs. soft delete (`deletedAt` flag, hidden, no recovery UI this pass). **Recommended: hard delete.** **SUPERSEDED — Abhishek's explicit decision requires soft-delete + Trash; see `specs/trash-system.md`.**
- **PD2 (LOAD-BEARING, mirrors F1):** block (409) deleting a photo in a live-shared folder, vs. allow it (guest gets an ordinary 404 next time). **Recommended: allow — no F1-style block for single-photo scope.** Carried into `trash-system.md` as T2, now with stronger justification since it's reversible.
- **PD3:** on deleting an original A with a duplicate B pointing at it — block, cascade-null B's `duplicateOfPhotoId` (recommended), or leave dangling. Also confirms duplicate-status photos delete freely (no dissent expected there). Unchanged, reused by `trash-system.md`.
- **PD4:** hard requirement, not really a decision — `photoCount` reconciliation via `serializableTransaction()`, stated for completeness. Unchanged, reused by `trash-system.md`.
- **PD5 (LOAD-BEARING):** bulk endpoint shape — all-or-nothing vs. partial-success-with-result-list (recommended) vs. client-side looping. Includes the 100-item cap and no-new-rate-limiter calls. Unchanged, reused by `trash-system.md`.
- **PD6:** full wireframe round for the multi-select UI (recommended) vs. thin add — does not block backend build. Recommended by `trash-system.md` to be combined with the new Trash-page wireframe round.
- **PD7:** hard constraint, not a decision — irreversibility-honest confirm copy, stated for completeness. **INVERTED by `trash-system.md`** — copy must now say "moved to Trash, recoverable for 7 days," not "permanent."
