# MR: Folder rename / merge / delete (spec P4, backend only)

**Branch:** `feature/ai-classification`
**Spec:** `specs/folder-mgmt-download-search.md` — PART P4 (on the confirmed F1–F6 defaults)
**Scope:** backend + tests only. No UI (P4's `/organize` surface is wireframe-blocked). No schema change, no migration, no new dependency. **Includes a follow-up fix** broadening `GET /api/photos/unfiled` so folder-delete orphans stay reachable (the deviation this MR originally flagged — now resolved, see the bottom section).

## Summary

Adds the three folder-management endpoints the roadmap (§3, §11) called for but that never existed (`Day2.md`: "Create-only: no rename/merge/delete endpoints exist yet"), extending the already-mounted `routes/folders.ts` router. All three are `requireAuth` + `asyncHandler` + Zod, ownership resolved via `folder → collection → ownerId`, and return **404 (never 403)** on any ownership mismatch — the house rule.

## Endpoints

1. **`PATCH /api/folders/:id` (rename)**
   - Body `{ name }`, Zod `folderRenameSchema` (`.trim().min(1).max(255)`). Empty/whitespace or >255 → **400** before any DB write.
   - `prisma.folder.update` in a `try/catch`; a `@@unique([collectionId, name])` collision is caught as **P2002 → 409** "A folder with that name already exists" — enforced by the DB constraint, **not** an app pre-check (constraint 6).
   - Touches only `name`. Does **not** change `photoCount`, `categoryType`, photos, or permissions. **No audit** (F4: rename is cosmetic).
   - Returns 200 `{ id, name, categoryType, photoCount, collectionId }`.

2. **`POST /api/folders/:id/merge` (merge A→B)**
   - `:id` = source A; body `{ targetFolderId }` (uuid). Self-merge (`targetFolderId === :id`) → **400**.
   - BOTH A and B resolved via `folder → collection → ownerId`; either not owned → **404**.
   - **F3:** cross-collection → **400**.
   - **F1 guard runs FIRST** (see below) → **409** if A is live-shared, **no data moves**.
   - Move + reconcile in ONE `serializableTransaction()` (see below). Then A is deleted.
   - Returns 200 `{ merged: true, targetFolderId, photosMoved, targetPhotoCount }`.
   - **F4:** one `folder_merged` audit row, post-commit.

3. **`DELETE /api/folders/:id`**
   - Ownership → **404**. **F1 guard FIRST** → **409** if live-shared, nothing touched.
   - **F2:** inside `serializableTransaction()`, photos move to Unfiled (`updateMany … folderId: null`), then the folder row is deleted. Photo rows and MinIO originals are **not** touched (no cascade, no object deletion).
   - Returns 200 `{ deleted: true, photosOrphaned }`.
   - **F4:** one `folder_deleted` audit row, post-commit.

**F5:** all three ops work on both `ai_generated` and `custom` folders (no `categoryType` special-casing). **F6:** reorder is out of scope (PATCH = rename only).

## How the F1 guard works

`hasLivePermission(folderId)` (a private helper in `folders.ts`) runs **before any data move** in both merge and delete. It returns true if ANY `folder_permission` on the folder is live — `revokedAt = null` AND (`expiresAt = null` OR `expiresAt > now`) — mirroring the exact "live" definition `getPermittedFolderIds()` uses. If a live share exists, the operation is blocked with **409** ("This folder is shared with a guest — revoke the share first") and returns before touching any row. This is the recommended F1 default: it avoids silently migrating a grant to B (privilege escalation — B may hold private photos) or silently severing an active guest. The owner revokes the share (`DELETE /api/guests/:id`) then retries. An **expired** permission does not block (test-covered).

## How the serializableTransaction merge works

The move + counter reconciliation is all-or-nothing inside `serializableTransaction()` (Serializable isolation, retries on P2034 — the existing helper used by `PATCH /api/photos/:id`):

1. Re-read A and B inside the txn (guard against a between-check change; absence → 0 moved).
2. `photo.updateMany({ where: { folderId: A }, data: { folderId: B, collectionId: B.collectionId } })` — the returned `moved.count` is the authoritative moved count, **re-derived inside the txn**, never a stale read (constraint 5).
3. `B.photoCount += moved.count` (increment).
4. `folder.delete(A)` — A is now empty (photos reparented, so the `Folder→Photo` relation takes nothing with it).

Because the moved count is derived from the same serializable `updateMany` that does the move, `B.photoCount` is exact vs a live `COUNT(folderId = B)` — the test asserts this equality after the merge. Delete uses the same helper (orphan `updateMany` + folder delete) so it's equally all-or-nothing.

## Audit actions added

Two additive `AuditAction` string literals in `lib/audit.ts` — `folder_merged`, `folder_deleted`. No schema change (the `audit_log.action` column is a free string, `metadata` is `Json?`). Both are emitted via `logAudit(...)`: fire-and-forget, post-commit, success-path only, `.catch()`-swallowed — never awaited inside the transaction, so a failed audit write can never roll back a merge/delete.
- `folder_merged` — actorType `owner`, `resourceId` = target B, metadata `{ sourceFolderName, targetFolderName, photosMoved }`.
- `folder_deleted` — actorType `owner`, `resourceId` = the deleted folder, metadata `{ folderName, photosOrphaned }`.
Rename is **not** audited (F4).

## Files changed

- `backend/src/routes/folders.ts` — the three routes + `hasLivePermission` / `findOwnedFolder` helpers.
- `backend/src/lib/validation.ts` — `folderRenameSchema`, `folderMergeSchema` (+ inferred types).
- `backend/src/lib/audit.ts` — two new `AuditAction` literals.
- `backend/src/__tests__/folder-mgmt.smoke.test.ts` — new, 21 tests (17 P4 + 4 `/unfiled` orphan-reachability, see the follow-up fix below).
- `backend/src/routes/photos.ts` — **follow-up fix (see below):** broadened the `GET /api/photos/unfiled` WHERE to close the P4 delete reachability gap.

## Test coverage (17 P4 tests, all green)

Seeds folders/photos/permissions directly via Prisma (no worker dependency), skip-not-fake on infra.
- **Rename:** 200 + DB name update + counts untouched; **409 collision** (caught @@unique); **400** empty/whitespace + >255; **404** cross-owner (no change); **F5** rename an `ai_generated` folder; 401 no session.
- **Merge:** all photos move A→B + `photosMoved`/`targetPhotoCount` correct + A deleted + **`B.photoCount` == live COUNT (exactness)** + all A-photos now point at B + **`folder_merged` audit row** (shape asserted); **400** self-merge; **404** source-foreign and target-foreign (nothing moved); **400** cross-collection (F3, nothing moved); **F1** 409 on live-shared source with NO data moved, then revoke → success; expired-permission does NOT block; **400** non-uuid target.
- **Delete:** photos → Unfiled (`folderId = null`) + photo rows survive + originals intact (`GET /api/photos/:id` 200) + folder row gone + **`folder_deleted` audit row** (shape asserted); **404** cross-owner (no effect); **F1** 409 on live-shared, folder+photos untouched, then revoke → success; 401 no session.

## Verification

- `npm run typecheck -w backend` — clean.
- `npm run lint -w backend` — clean.
- `npm test -w backend` — **106/106** (was 85 pre-P4 → 102 after P4 → +4 `/unfiled` orphan tests). New file: 21/21.

## Deviation RESOLVED (follow-up fix, same branch)

The P4 delete AC said orphaned photos "subsequently appear under `GET /api/photos/unfiled`." When P4 landed (`057605c`) that route filtered `aiClassificationStatus IN ('failed','duplicate')`, so a `done` photo orphaned by a folder-delete (`folderId = null, status = 'done'`) was in NO folder AND NOT in that status filter — invisible/unreachable in the UI, silently breaking F2's "photos remain reachable" promise (recreating the 2026-07-03 "photos unreachable" bug class). The flagged decision resolved in favor of **broadening `/unfiled`**: "unfiled" means *not in any folder*, whatever the reason.

**The fix (`backend/src/routes/photos.ts`, the `/unfiled` handler):** anchor on `folderId: null` (the load-bearing condition — a photo with a folder can never appear) and admit any TERMINAL status by EXCLUDING the in-flight ones:

```
WHERE ownerId = req.user.id
  AND folderId IS NULL
  AND aiClassificationStatus NOT IN ('pending','processing')
```

Status enum (from `schema.prisma:133`, a free string documented `pending|processing|done|duplicate|failed`) — there is **no** distinct `uncategorized` *status* (Uncategorized is only a folder). Terminal set admitted today: `done | failed | duplicate`. We phrase it as `NOT IN (pending, processing)` rather than enumerating the terminals so any future terminal status surfaces by default; `pending`/`processing` photos are only transiently `folderId = null` mid-pipeline (worker not done) — surfacing them would be wrong/flickery, so they're excluded.

**No filed photo can leak:** because we anchor on `folderId IS NULL`, a normal `done` photo (which HAS a folder) is structurally excluded — the change ONLY adds `folderId`-null terminal orphans, never any filed photo (negative test asserts this). Everything else about the endpoint is identical: owner-scoped, newest-first, paginated, pre-signed 60s thumbnails via `PHOTO_CARD_SELECT`/`toPhotoCard`, duplicate-of-X labels, response shape — so `/organize`'s Unfiled bucket and the `/dashboard` Unfiled tile need no frontend change; the broader set just shows up.

**Tests (4 added to `folder-mgmt.smoke.test.ts`, dedicated owner for deterministic counts):**
- **New case:** seed a folder with a `done` photo → DELETE the folder (P4) → the `done` orphan now appears in `/unfiled` (it did NOT before this fix), with `status: "done"`; asserted absent before the delete.
- **Negative (leak guard):** a filed `done` photo (still in a folder) NEVER appears.
- **Negative (in-flight):** `pending` and `processing` `folderId`-null photos do NOT appear.
- **Preserved semantics:** a `failed` `folderId`-null photo still appears.

**No count-assertion changes elsewhere.** The two existing `/unfiled` assertions in `classification.smoke.test.ts` (fresh-user `total === 1` for a lone FORCE_FAIL photo; fresh-user `total === 1` for a lone duplicate; `total === 0` after reclassify-into-folder) are on fresh users who own exactly one unfiled photo each with no `done` orphans, so the broader filter leaves them unchanged — verified green. The order-independent leak test also unchanged.
