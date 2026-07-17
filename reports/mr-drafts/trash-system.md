# MR Draft — Trash System (soft delete + 7-day retention + auto-purge)

**Branch:** `feature/ai-classification` (local only, not pushed)
**Spec:** `specs/trash-system.md` (FINAL, all decisions T1–T7 + folder-restore-collision + photo-restore-cascade explicitly confirmed by Abhishek). Also reuses PD3/PD4/PD5/PD7 analysis from `specs/photo-deletion.md` (SUPERSEDED on PD1/PD2, kept for that reasoning trail).
**Author:** Abhishek (no `Co-Authored-By: Claude` trailer, per standing rule)
**Commits (5, in order):**
1. `9b8da10` — schema migration + storage/audit/purge foundations
2. `c52a3f4` — soft-delete/restore endpoints for photos and folders
3. `7410271` — daily auto-purge job (BullMQ repeatable job)
4. `99296f1` — the 21-path listing-query trash-exclusion audit
5. `e9f9e81` — test coverage + retargeted P4 delete tests

## Summary

Deletion of a photo or folder is now **reversible for 7 days**, not immediate. `deletedAt` on both `Photo` and `Folder`; a Trash surface (`GET /api/trash`, restore, permanent-purge-one, empty-trash); a daily BullMQ repeatable job auto-purges anything past 7 days. This **breaks the already-shipped, already-pushed** `DELETE /api/folders/:id` (P4) — it no longer hard-deletes + orphans photos to Unfiled; it now soft-deletes the folder and leaves photos attached (hidden transitively). It also finally builds photo deletion (`specs/photo-deletion.md`), which had never shipped — as a soft-delete from day one.

No frontend/UI touched this pass (backend + tests only, per the task scope — the Trash page + multi-select UI need their own wireframe round first, per the spec's closing note).

## Migration details

`20260707201747_add_trash_system` — additive `deleted_at` columns on `photos`/`folders` (+ `photos_owner_id_deleted_at_idx`, `folders_deleted_at_idx`, `folders_collection_id_name_idx`), plus **T7's genuinely new constraint change**: the plain `folders_collection_id_name_key` unique constraint is dropped and replaced with a **Postgres partial unique index**:

```sql
CREATE UNIQUE INDEX "folder_active_name_unique" ON "folders"("collection_id", "name") WHERE "deleted_at" IS NULL;
```

This lives ONLY in the raw migration SQL — Prisma's schema DSL can't express a `WHERE` clause on `@@unique`. `schema.prisma`'s `Folder` model now has a plain, non-unique `@@index([collectionId, name])` (query-performance only) with a loud comment, and the migration file has a loud header comment, both explicitly warning against "fixing" this back to a plain `@@unique` later.

**Verified live** (direct SQL against the running Postgres, in a throwaway transaction, never committed):
- A folder trashed (`deleted_at` set) + a new live folder with the SAME `(collection_id, name)` → **both inserts succeed**, no 409.
- Two BOTH-live folders with the same name → **still correctly collides** (`duplicate key value violates unique constraint "folder_active_name_unique"`).

Migration applies cleanly (`prisma migrate dev`/`migrate status` confirms up-to-date); the worker's `findOrCreateFolder` (which used the old `collectionId_name` compound-unique Prisma input, now gone) was updated to `findFirst({ collectionId, name, deletedAt: null })` — a trashed folder is never silently "found" and reused by the AI-classification worker; only a live one is.

## Endpoint list

- `DELETE /api/photos/:id` — soft-delete. T2 (409 if folder live-shared). Returns `{ deleted, photoId, folderId, deletedAt, purgeAt }`.
- `POST /api/photos/bulk-delete` — partial-success, per-item T2 guard, `{ deleted: string[], failed: [{id, reason: "not_found"}] }`.
- `DELETE /api/folders/:id` — REVISED to soft-delete. F1 unchanged, runs first. Returns `{ deleted, deletedAt, purgeAt }` — **`photosOrphaned` field is GONE** (breaking response-shape change vs the shipped P4 UI, which read it for confirm copy — frontend NOT touched this pass, flagged below).
- `POST /api/photos/:id/restore` — auto-cascades into restoring an also-trashed folder first; surfaces the SAME 409 conflict shape on an unresolved collision.
- `POST /api/folders/:id/restore` — body `{ onConflict?: "merge" | "rename", newName? }`. 409 with `{ error: "conflict", conflictingFolderId, conflictingFolderName }` if unresolved.
- `GET /api/trash` — `{ photos, folders, photoTotal, folderTotal, limit, offset }`, each item carrying `deletedAt`/`purgeAt`/`daysRemaining` (all computed, T1 — never stored).
- `DELETE /api/trash/:type/:id` — `:type` = `photo|folder` (Zod enum, unknown → 400). Permanent purge, one item, now.
- `DELETE /api/trash` — empty trash. `{ emptied, photosDeleted, foldersDeleted }`, one `trash_emptied` audit row.

## Purge job mechanism

BullMQ's `Queue.upsertJobScheduler` (available in the installed `bullmq@5.79.2` — no fallback needed), registered once at worker startup (`worker.ts`'s `main()`), on the **existing** `photo-processing` queue (job name `trash-purge`, cron `0 3 * * *` — once daily). Confirmed idempotent live: calling `upsertJobScheduler` twice with the same key leaves exactly one scheduler registered (`getJobSchedulers()` returns length 1 both times). `PhotoProcessingJobData` widened to a union (`PipelineJobData | TrashPurgeJobData`) rather than standing up a second queue — the spec explicitly allowed either, this was the simpler diff. `worker.ts`'s job dispatch and `completed`/`failed` handlers branch on `job.name === TRASH_PURGE_JOB_NAME` before falling through to the existing photoId-keyed bookkeeping (the purge job has no `processing_jobs` row and no single photo target).

`lib/trashPurgeJob.ts`'s `runTrashPurgeJob()` is the actual body — queries `Photo`/`Folder` separately for `deletedAt < now - 7 days`, reuses `lib/purge.ts`'s `purgePhoto`/`purgeFolder` (the SAME functions `DELETE /api/trash/:type/:id` calls — no duplicated cascade code). Processes one item at a time; both purge functions tolerate an already-gone row (Prisma `P2025`) and an already-gone MinIO key as no-op success. Verified live via the test suite: running the job twice back-to-back produces no error and no double-effect, for both a standalone photo and a folder-with-photos cascade.

## Confirmation on all 21 listing-query rows

| # | Path | Fixed: how |
|---|---|---|
| 1 | `GET /api/photos/unfiled` | Added `deletedAt: null` to the where clause. |
| 2 | `GET /api/photos/:id` | 404 if `photo.deletedAt != null` OR `photo.folder?.deletedAt != null` (added `deletedAt: true` to the folder include). |
| 3 | `GET /api/photos/:id/status` | Same as #2. |
| 4 | `GET /api/folders/:id/photos` | 404 if the folder itself is trashed; photo query itself also filters `deletedAt: null`. |
| 5 | `PATCH /api/folders/:id` (rename) | 404 if `folder.deletedAt != null`. |
| 6 | `POST /api/folders/:id/merge` | 404 if EITHER source or target is trashed. |
| 7 | `DELETE /api/folders/:id` | 404 if already-trashed (guarded `updateMany` with `deletedAt: null` in the WHERE, count-checked). |
| 8 | `PATCH /api/photos/:id` (move) | 404 if the photo is trashed; 404 if the target folder is trashed. |
| 9 | `POST /api/photos/:id/reclassify` | 404 if the photo is trashed. |
| 10 | `GET /api/collections` | N/A — collections have no `deletedAt`, out of scope (confirmed, no change). |
| 11 | `GET /api/collections/:id/folders` | Added `deletedAt: null` to the folder query. |
| 12 | `POST /api/collections/:id/folders` (create) | N/A for the create logic itself — documented that its P2002 now comes off the PARTIAL unique index (T7), so the original friction (a trashed folder blocking a new same-named create) is resolved as a side effect, not a separate code change. |
| 13 | `GET /api/collections/:id/unfiled-photos` | Added `deletedAt: null`. |
| 14 | `GET /api/search` | **Highest-risk row — required an ADDITIONAL fix beyond the initial pass.** Base `where` needed BOTH `deletedAt: null` AND `OR: [{ folderId: null }, { folder: { deletedAt: null } }]` (a photo's own `deletedAt: null` alone does NOT catch the transitive "folder is trashed" case for the default/no-folder-filter query — caught only by the new test suite, not the initial code read). The `folderId`/`category` folder-lookup sub-queries also gained `deletedAt: null`/404. |
| 15 | `GET /api/guest/folders` | Fixed at the single choke point: `getPermittedFolderIds` (`middleware/requireGuest.ts`) now filters `folder: { deletedAt: null }` — every downstream guest route inherits this for free via set-membership checks. |
| 16 | `GET /api/guest/folders/:id/photos` | Inherits #15's exclusion via the permitted-set check (explicit comment added); photo query itself also filters `deletedAt: null`. |
| 17 | `GET /api/guest/photos/:id` | 404 if the photo's own `deletedAt` OR its folder's `deletedAt` is set, in addition to the permitted-set check (belt-and-suspenders alongside #15). |
| 18 | `GET /api/guest/photos/:id/download` | Same as #17, checked BEFORE the view/download permission-level branch. |
| 19 | `GET /api/guest/folders/:id/download-all` | Inherits #15's exclusion via the permitted-set check; the underlying photo-set is also covered transitively by #20's fix. |
| 20 | `GET /api/folders/:id/download-all` + `lib/folderDownload.ts` | **The flagged leak.** Owner route: 404 if the folder is trashed. `queryDownloadablePhotos` WHERE gained `deletedAt: null` — without this, a soft-deleted photo (still `status: done`, real `s3Key`) stayed zippable. Verified via a dedicated test (soft-deleted photo's filename absent from the zip bytes). |
| 21 | `GET /api/dashboard` | All three counts (`photoCount`, `folderCount`, per-collection `photoCount`) gained `deletedAt: null`. |

**19 of 21 rows required a code change; #10 confirmed N/A; #12 confirmed N/A for its own logic (resolved as a T7 side-effect).**

## Test coverage summary

New `backend/src/__tests__/trash-system.smoke.test.ts` — **35 tests**, covering: soft-delete (row/MinIO survive, `photoCount` decrement, audit row, PD3a cascade-null, T2 409 for single AND bulk delete), folder soft-delete (F1 still blocks; transitive hiding via 404s on `GET /:id`/`GET /:id/status` and absence from search, confirmed WITHOUT the photo's own `deletedAt` being touched), `GET /api/trash` shape + cross-owner leak-proofing, photo-restore + folder-restore including the auto-cascade, its 409-conflict passthrough, and both `merge`/`rename` collision resolutions, permanent single-item purge + empty-trash (including the T5 folder-cascade and cross-owner leak-proofing), the auto-purge job's age-gating (8-day-old purged, 6-day-old survives) + idempotency (run twice, no error/double-effect) for both a standalone photo and a folder cascade, the #20 zip-leak fix, and a sample of the remaining listing-query rows (#1, #14, #15, #21).

Retargeted 3 pre-existing `folder-mgmt.smoke.test.ts` assertions that depended on the OLD hard-delete-and-orphan-to-Unfiled `DELETE /api/folders/:id` behavior (now superseded) to the new soft-delete contract, and adapted the P4 reachability regression test to seed the `folderId`-null/`done` row shape directly via Prisma (since folder-delete can no longer produce that shape).

**Full backend suite: 137 → 173 (all green).**

## Verification results

1. `npm run typecheck -w backend` — clean.
2. `npm run lint -w backend` — clean.
3. Migration applies cleanly (`prisma migrate dev`/`migrate status`); partial-unique-index behavior verified live via direct SQL (see above).
4. `npm test -w backend` — **173/173 green**.
5. Worker boots cleanly with the job registered (`[worker] listening for jobs...`, no errors); `upsertJobScheduler` confirmed idempotent live (registering twice → exactly one scheduler in Redis).

## Deviations / things flagged, not buried

- **Response-shape break, deliberate per spec:** `DELETE /api/folders/:id` drops the old `photosOrphaned` field. The shipped P4 frontend (`/organize`'s delete-confirm modal) reads `photosOrphaned` for its "N photos move to Unfiled" copy — that copy is now **factually wrong** (nothing is orphaned; the confirm should say "moved to Trash, recoverable for 7 days" per the spec's own T6/PD7-inversion note). **Not fixed this pass** — frontend was explicitly out of scope for this task, and the Trash-page + delete-confirm copy is queued for its own combined wireframe round per the spec's closing section. Flagging so nobody is surprised the `/organize` delete button's copy is currently stale until that round ships.
- **`AUDIT_ACTIONS` (the `GET /api/audit` `?action=` filter enum) added the 6 new trash actions**, even though that list pre-existed WITHOUT `folder_merged`/`folder_deleted`/`folder_downloaded` (a pre-existing gap, not introduced or otherwise touched here) — added them since "I recovered/purged something" is exactly the kind of thing worth filtering an owner's trail by, non-load-bearing choice.
- **Merge is unchanged (non-goal, reconfirmed):** `POST /api/folders/:id/merge` still hard-deletes the merged-away source folder immediately — merging is "consolidating," not "deleting," per the spec.
- **T5's veto option (spill to Unfiled on folder-purge instead) is a future feature request**, not built — flagged in `agents/STATUS.md`'s backlog per the spec's own instruction.

## Files touched

`backend/prisma/schema.prisma`, `backend/prisma/migrations/20260707201747_add_trash_system/migration.sql` (new), `backend/src/lib/storage.ts`, `backend/src/lib/audit.ts`, `backend/src/lib/validation.ts`, `backend/src/lib/guestShareGuard.ts` (new), `backend/src/lib/purge.ts` (new), `backend/src/lib/trashPurgeJob.ts` (new), `backend/src/lib/queue.ts`, `backend/src/lib/photoCard.ts`, `backend/src/lib/folderDownload.ts`, `backend/src/worker.ts`, `backend/src/app.ts`, `backend/src/routes/trash.ts` (new), `backend/src/routes/photos.ts`, `backend/src/routes/folders.ts`, `backend/src/routes/guest.ts`, `backend/src/routes/search.ts`, `backend/src/routes/collections.ts`, `backend/src/routes/dashboard.ts`, `backend/src/middleware/requireGuest.ts`, `backend/src/__tests__/trash-system.smoke.test.ts` (new), `backend/src/__tests__/folder-mgmt.smoke.test.ts`.

---

## ADDENDUM (2026-07-09) — photo-restore no longer cascades into restoring its trashed folder

**Commit:** `6443d87` on `feature/ai-classification` (local only, not pushed, no `Co-Authored-By: Claude` trailer).
**Reason:** product-behavior revision, not a bug in the original build. Abhishek found in live testing that `POST /api/photos/:id/restore` on a photo whose folder was ALSO trashed auto-restored the ENTIRE folder (and every other photo in it) before restoring the requested photo — surprising, since "recover this one photo" shouldn't resurrect a whole folder. This addendum documents `specs/trash-system.md`'s FINAL DECISION 5, REVISED 2026-07-09, which supersedes the original "photo-restore cascades to folder-restore" design in the same section.

### What changed

`POST /api/photos/:id/restore` in `backend/src/routes/photos.ts`. The trashed folder a photo used to belong to is now **never** touched by this endpoint — no restoring it, no touching its `deletedAt`/`photoCount`/other photos. The requested photo always lands in a LIVE folder instead:

1. 404 if not owned / not currently trashed — unchanged.
2. `folderId` null (was Unfiled) — restore directly — unchanged.
3. Folder is LIVE — restore directly into it, guarded-increment `photoCount` in `serializableTransaction()` — unchanged, already correct.
4. **Folder is TRASHED (the fix):** read the trashed folder's `name`/`collectionId` only (never write to it), then:
   - Look for a LIVE folder in the same collection with that name.
   - Found + no `onConflict` in the body → **409** `{ error: "conflict", conflictingFolderId, conflictingFolderName }`, photo not yet restored.
   - Found + `onConflict: "existing"` → restore the photo into `conflictingFolderId`, guarded-increment its `photoCount`.
   - Found + `onConflict: "new"` → create a BRAND NEW folder (not the trashed one), named `newName` if given (Zod: trim/min1/max255) else auto-generated `"<original name> (recovered)"`, restore into it (`photoCount` starts at 1).
   - Not found at all → skip the conflict step entirely, auto-create a new folder with the ORIGINAL name and restore into it.
   - In every one of these branches the original trashed folder's `deletedAt`, `photoCount`, and every other photo under it are byte-for-byte untouched, and it can still be restored later, on its own clock, via its own unchanged `POST /api/folders/:id/restore` endpoint.

### Auto-naming collision retry

New `generateNonCollidingRecoveredName(collectionId, baseName)` in `backend/src/routes/folders.ts` (exported, reused by `photos.ts`): tries `"<base> (recovered)"`, then `"<base> (recovered 2)"`, `"(recovered 3)"`, etc., checking against LIVE folders only (`deletedAt: null`) each time, capped at 20 attempts — throws a clear error rather than looping forever if all 20 are somehow taken. `createFolderTolerantly()` in `photos.ts` attempts the desired name first and falls back to this generator on a rare `P2002` race (something else created the exact same live folder name between the check and the create).

New `photoRestoreSchema` in `backend/src/lib/validation.ts`: `{ onConflict?: "existing" | "new", newName?: string }` — deliberately a different enum (`"existing"`/`"new"`) from `folderRestoreSchema`'s `"merge"`/`"rename"`, since this is resolving "where does the ONE photo land," not "how does the folder itself get restored" — a different decision with different semantics, kept as a separate schema/type (`PhotoRestoreInput`) rather than overloading the folder one.

### Test coverage changed/added (`trash-system.smoke.test.ts`)

Removed the two tests that asserted the OLD cascade behavior ("auto-cascades restoring the photo's ALSO-trashed folder first" and "returns the SAME 409 conflict shape as folder-restore when the auto-cascade hits a collision"). Added five new tests under `POST /api/photos/:id/restore`:

- No live same-named folder exists → auto-creates a new folder with the original name, photo lands there, original trashed folder's `deletedAt`/`photoCount`/other photo fully untouched.
- A live same-named folder exists, no `onConflict` → 409 with the conflict shape, photo still trashed, original folder untouched.
- Same scenario + `onConflict: "existing"` → photo lands in the existing live folder, its `photoCount` increments by exactly 1, original trashed folder untouched.
- Same scenario + `onConflict: "new"` (no `newName`) → a genuinely NEW folder (distinct id from both the original trashed one and the existing live one) with the auto-generated `"(recovered)"` name, photo lands there, both other folders' counts untouched.
- Confirms the original trashed folder can STILL be independently restored afterward via `POST /api/folders/:id/restore` — including exercising the (expected, unrelated) T7 name-collision this creates against the auto-created recovered folder, resolved via that endpoint's own `onConflict: "rename"`.

**Full backend suite: 173 → 176, all green.**

### Verification results

1. `npm run typecheck -w backend` — clean.
2. `npm run lint -w backend` — clean.
3. `npm test -w backend` — **176/176 green** (13 test files, all passing).

### Known follow-up, not built this pass (out of explicit scope)

`frontend/src/app/trash/page.tsx`'s `resolvePhotoCollision()` still implements the OLD behavior: on a photo-restore 409, it calls `foldersApi.restore(collision.photoFolderId, onConflict, newName)` (i.e., it resolves the collision by restoring/merging/renaming the trashed FOLDER, then retries the photo restore) — that endpoint and its `merge`/`rename` vocabulary no longer apply to this flow at all. The frontend needs a follow-up change to call `photosApi.restore(photo.id, { onConflict: "existing" | "new", newName })` directly instead, and to update the inline collision-resolution copy/buttons to say "put this photo in the existing folder" / "create a new folder for it" rather than "merge into" / "rename" (which describe restoring the whole folder, not just relocating one photo). Flagging clearly rather than leaving the UI silently broken against the new backend contract — recommend this as the next Developer pass once picked up.
