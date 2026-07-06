# Spec — Folder Management + Bulk Download + Basic Search (the deferred P4 / P5 / P6 backlog)

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 3 (Core Features — "Folder Management — auto-create, rename, merge, delete" + "Search — keyword search across categories and metadata"), § 11 (API Design — `PATCH /api/folders/:id`, `DELETE /api/folders/:id`; guest portal download), § 7 (Week 5–6 folder-management checkbox; Week 9–10 `download_all` permission level; Week 11–12 "Basic search (by folder, by date, by filename)")
**Status:** draft
**Written by:** Planner Agent, 2026-07-06

## Problem

Three features were deliberately deferred out of earlier passes and now form the tail of the Phase-1 local-first slice. All three are backend-buildable and Tester-verifiable over HTTP today; each is independent of the others, so the Developer can build them one at a time in any order.

- **P4 — Folder rename / merge / delete.** Roadmap § 3 lists folder management as auto-create + **rename + merge + delete**, and § 11 has `PATCH`/`DELETE /api/folders/:id`. Only auto-create (worker) and manual create (`POST /api/collections/:id/folders`) exist today — `Day2.md` explicitly notes "Create-only: no rename/merge/delete endpoints exist yet." This is the one with real correctness surface: `photoCount` reconciliation under concurrency, the `@@unique([collectionId, name])` collision, and — the load-bearing one — **what happens to a live guest share (`folder_permission`) pointed at a folder that is merged away or deleted.**
- **P5 — Bulk "download all" (folder zip).** The `download_all` permission level already exists in the guest-access data model and is currently treated as ≥ `download` with no distinct endpoint (guest-access spec Pending Decision #12 deferred the bulk endpoint). This pass gives owners (and appropriately-permissioned guests) a single call that streams a ZIP of a folder's photos, built on-the-fly from authorized MinIO reads — never exposing a raw key.
- **P6 — Basic search.** Roadmap Week 11 "Basic search (by folder, by date, by filename)". Owners can currently only navigate folder-by-folder. This adds an owner-scoped query endpoint to find photos across the whole library by filename, date range, folder, and (decision-gated) AI label.

**This spec is the buildable backend + data-model core of all three.** The UI surfaces each implies are called out per-part at the end for Master to queue wireframe rounds where needed; none of the three backends is UI-blocked.

## Hard constraints (baked in, non-negotiable — apply to all three parts)

1. **Local-first slice only.** Docker Compose (Postgres/Redis/MinIO), existing swappable mocks. No AWS/Terraform/EKS/Stripe, no real cloud, no new hosted service. The P5 zip is streamed **on-the-fly from MinIO reads inside the local backend** — no hosted zip/archive service, no S3 "create archive" API, nothing that implies cloud.
2. **Additive Prisma migration(s)** continuing from the last migration (`20260705154110_add_audit_log`). Nothing renamed or removed. P4 and P5 need **no schema change at all**; P6 needs none for the SQL-`ILIKE` scope (flag any index add explicitly).
3. **Existing conventions verbatim:** every route is `requireAuth` (owner) or `requireGuest` (guest) + `asyncHandler` + **Zod on every body AND query**; **404-not-403** on any ownership/scope mismatch; opaque session tokens; owner-scoped everywhere (`folder → collection → ownerId`, the pattern in `routes/folders.ts`).
4. **Pre-signed 60s URLs only for any image bytes.** No endpoint ever returns a raw `s3Key`. The P5 zip is assembled from **authorized reads of MinIO objects inside the backend** (the backend already holds MinIO credentials via `lib/storage.ts`); the client receives zip bytes over the response stream, never object keys or pre-signed URLs to enumerate. P6 result thumbnails are pre-signed 60s URLs, reusing `toPhotoCard`/`PHOTO_CARD_SELECT`.
5. **`photoCount` via increment/decrement + `serializableTransaction()`, never a live `COUNT`.** Any P4 operation that moves photos between folders re-reads inside a `serializableTransaction()` (`lib/serializableTransaction.ts`) and reconciles BOTH affected folders' counters, exactly as `PATCH /api/photos/:id` does today (`Day2.md` — "Any new code that reads-then-writes a counter shared across concurrent operations should use `serializableTransaction()`").
6. **Find-or-create races, unique-collision as 409-off-constraint (not app pre-check).** A rename that collides with an existing folder name in the same collection returns 409 from the caught `@@unique([collectionId, name])` violation (P2002), the same way `POST /api/collections/:id/folders` already does — never a `findFirst`-then-decide pre-check.
7. **Audit is fire-and-forget, post-commit, success-path-only.** Where this pass adds audit rows, it calls the existing `logAudit(...)` helper (`lib/audit.ts`) — never `await`-ed inside the primary transaction, wrapped in its own `.catch()`, called after commit / right before the response on the success path only. New action types are additive strings; no schema change (the `audit_log.action` column is a free string, `metadata` is `Json?`).

---

# PART P4 — Folder rename / merge / delete

**Endpoints:** `PATCH /api/folders/:id` (rename), `POST /api/folders/:id/merge` (merge), `DELETE /api/folders/:id` (delete).
**Schema change:** none.
**File:** `backend/src/routes/folders.ts` (extend the existing router — currently only `GET /:id/photos`).

## Goals

- **Rename:** owner renames one of their folders. Collision against `@@unique([collectionId, name])` → 409 (caught P2002, not a pre-check). Empty/whitespace name → 400 (Zod, trimmed). Success returns the updated folder. AI-generated vs custom folders: see F5.
- **Merge:** owner merges folder A into folder B (both owned, same collection — see F3). All of A's photos move to B; BOTH `photoCount`s reconciled inside one `serializableTransaction()`; A is then deleted (empty). Live guest shares on A: see F1 (the load-bearing decision).
- **Delete:** owner deletes folder A. Its photos are handled per F2 (recommended: moved to Unfiled / `folderId = null`, not cascade-deleted). Live guest shares on A: see F1.
- **Audit:** rename/merge/delete each emit an owner-actor audit row (see F4).

## Scope for this pass

### Rename — `PATCH /api/folders/:id`

- `requireAuth`; body `{ name: string }` (Zod: `.trim().min(1).max(255)`; empty/whitespace → 400 before any DB write).
- Ownership via `folder → collection → ownerId` (the `routes/folders.ts` pattern); not owned → **404**.
- `prisma.folder.update({ where: { id }, data: { name } })` inside a `try/catch` on `P2002` → **409 "A folder with that name already exists"** (the collision rule is enforced by the DB constraint, never an app-level pre-check — constraint 6).
- Does NOT touch `photoCount`, `categoryType` (but see F5 on whether AI-generated folders may be renamed), photos, or permissions.
- Returns 200 `{ id, name, categoryType, photoCount, collectionId }`.
- Roadmap § 11 also mentions "reorder" on this PATCH — **out of scope this pass** (no `sortOrder`/`position` column exists; adding one is a separate additive migration). Flagged F6.

### Merge — `POST /api/folders/:id/merge` (`:id` = source A; body `{ targetFolderId }` = destination B)

- `requireAuth`; body `{ targetFolderId: string (uuid) }` (Zod). `targetFolderId === :id` → 400 "cannot merge a folder into itself".
- Ownership: BOTH A and B resolved via `folder → collection → ownerId`; either not owned by caller → **404** (never confirm a foreign folder exists). Cross-collection merge gated by F3 (recommended: require same collection → 400 otherwise).
- **Live-guest-share guard (F1) runs FIRST** — before any data move. If A has any live `folder_permission` (`revokedAt = null` AND (`expiresAt` null OR future)) and the recommended default is chosen, the merge is **blocked with 409** and no data moves.
- **The move + counter reconciliation, all in ONE `serializableTransaction()`** (constraint 5): re-read A and B inside the txn; `updateMany({ where: { folderId: A.id }, data: { folderId: B.id } })`; set `B.photoCount = B.photoCount + (count moved)` and `A.photoCount = 0` by reconciling from the actual moved count (do not trust a stale read — re-derive inside the serializable txn, retrying on `P2034` exactly as the helper does). Then delete A (now empty). All-or-nothing.
  - **Duplicate-filename collision inside a folder is NOT a constraint** — photos have no per-folder unique name (only folders do), so moving A's photos into B never trips a unique violation. (The `/organize` UI's "duplicate filename" handling is a display concern, not a DB constraint — no special handling needed here.)
- **AI-generated vs custom (F5):** whether an `ai_generated` folder can be a merge source/target — see F5.
- Returns 200 `{ merged: true, targetFolderId, photosMoved, targetPhotoCount }`.
- Audit: one `folder_merged` row (F4).

### Delete — `DELETE /api/folders/:id`

- `requireAuth`; ownership via `folder → collection → ownerId`; not owned → **404**.
- **Live-guest-share guard (F1) runs FIRST.** If A has a live `folder_permission` and the recommended default is chosen → **409** (delete blocked while actively shared), no photos touched.
- **Photo disposition (F2) — recommended default: move to Unfiled** (`folderId = null`), NOT cascade-delete the photos or their MinIO objects. Inside a `serializableTransaction()`: `updateMany({ where: { folderId: A.id }, data: { folderId: null } })`, then delete A. (No counter reconciliation needed beyond zeroing A — Unfiled has no `Folder` row / `photoCount`; the dashboard's Unfiled tile derives its count live from `folderId = null`, per the existing `/api/photos/unfiled` surface.)
- Idempotent-ish: deleting an already-gone folder → 404.
- Returns 200 `{ deleted: true, photosOrphaned }`.
- Audit: one `folder_deleted` row (F4).

## P4 acceptance criteria

Verification legend (consistent with `specs/guest-access-otp.md` / `specs/ai-classification.md`):
- **[Tester-live]** — black-box verifiable against the running stack (HTTP + DB inspection allowed).
- **[Developer-verified]** — verified by Developer via code review / unit test where live exercise is impractical.

**Rename**
- [ ] [Tester-live] `PATCH /api/folders/:id { name }` on an owned folder returns 200 and the folder's name is updated in the DB.
- [ ] [Tester-live] Renaming to a name already used by another folder in the same collection returns **409** (verified to be the caught DB unique violation, not an app pre-check — e.g. a race where two renames target the same name still yields one 409).
- [ ] [Tester-live] Empty/whitespace-only `name` → 400 before any DB write; `name` > 255 chars → 400.
- [ ] [Tester-live] Renaming a folder owned by a different owner → **404**, no change.
- [ ] [Tester-live] Rename does not change `photoCount`, `categoryType`, or any photo's `folderId`.

**Merge**
- [ ] [Tester-live] Merging A (n photos) into B (m photos) moves all n photos to B, sets `B.photoCount = m + n`, deletes A, and returns `{ photosMoved: n, targetPhotoCount: m+n }`. Verified by DB inspection that no photo still points at A and A's row is gone.
- [ ] [Tester-live] After merge, both counters are exact (`B.photoCount` equals the live `COUNT` of `folderId = B` — the reconciliation didn't drift).
- [ ] [Developer-verified] The move+reconcile runs inside `serializableTransaction()` and retries on `P2034` (code review; concurrency race is impractical to force reliably black-box, same stance as the `PATCH /api/photos/:id` counter tests).
- [ ] [Tester-live] Merging into a target owned by a different owner (or a source not owned) → **404**. Merging a folder into itself → 400.
- [ ] [Tester-live] (Per F1 recommended default) Merging a source folder that has a live guest `folder_permission` → **409**, and NO photos move (verified: A still has its photos, B unchanged).
- [ ] [Tester-live] One `folder_merged` audit row is written with `actorType='owner'`, correct `ownerId`, and metadata `{ sourceFolderName, targetFolderName, photosMoved }`.

**Delete**
- [ ] [Tester-live] Deleting an owned folder with photos moves those photos to Unfiled (`folderId = null` — verified in DB) and deletes the folder row; they subsequently appear under `GET /api/photos/unfiled`.
- [ ] [Tester-live] The photos' MinIO objects still exist after delete (NOT cascade-deleted — verified the photo rows survive and their originals are still fetchable via `GET /api/photos/:id`).
- [ ] [Tester-live] Deleting a folder owned by a different owner → **404**, no effect.
- [ ] [Tester-live] (Per F1 recommended default) Deleting a folder with a live guest `folder_permission` → **409**, folder and photos untouched.
- [ ] [Tester-live] One `folder_deleted` audit row is written (`actorType='owner'`, correct `ownerId`, metadata `{ folderName, photosOrphaned }`).

## P4 success signal

Tester can, against the local stack: create two folders A and B with photos, rename A (200), attempt a colliding rename (409), merge A→B (all photos move, counts exact, A gone, `folder_merged` logged), then create folder C, share it to a guest, and confirm a delete/merge of C is blocked with 409 while the share is live — then revoke the share and confirm the delete now succeeds, moving C's photos to Unfiled with their MinIO originals intact and a `folder_deleted` row written.

---

# PART P5 — Bulk "download all" (folder zip)

**Endpoints:** `GET /api/folders/:id/download-all` (owner), `GET /api/guest/folders/:id/download-all` (guest).
**Schema change:** none.
**New dependency:** likely `archiver` (see Z2).
**Files:** `backend/src/routes/folders.ts` (owner) + `backend/src/routes/guest.ts` (guest); a shared helper `backend/src/lib/folderZip.ts` for the streaming assembly.

## Goals

- An owner can download all photos in one of their folders as a single ZIP.
- A guest holding a `download`/`download_all` permission on a folder (level gate per Z1) can download all photos in that shared folder as a ZIP.
- The ZIP is assembled **on-the-fly by streaming each object from MinIO through `archiver` into the HTTP response** — never buffering the whole zip in memory or on disk, never exposing raw keys or per-object pre-signed URLs to the client.

## Scope for this pass

### Owner — `GET /api/folders/:id/download-all`

- `requireAuth`; ownership via `folder → collection → ownerId`; not owned → **404**.
- Query the folder's photos (all of them — this is "download ALL", not paginated; but see Z3 on a size/count cap and the inline-vs-async threshold). Only include photos with a real stored original (`done`/present `s3Key`); skip `failed`/`duplicate`/`pending` photos that have no downloadable original (Z4).
- Set `Content-Type: application/zip` and `Content-Disposition: attachment; filename="<folderName>.zip"` (sanitize the folder name for the header). Stream: create an `archiver('zip')`, pipe it to `res`, and for each photo `archiver.append(minioReadStream(s3Key), { name: <original filename, de-duplicated> })`. Read each object via the existing MinIO client in `lib/storage.ts` (a `getObject`/read-stream call — the backend is authorized; the client never sees the key).
- Filename collisions inside the zip (two photos with the same `originalFilename`) → de-duplicate the entry name (e.g. suffix ` (2)`), so the archive is valid.
- Errors mid-stream: once headers/bytes are sent, a per-object read failure can't become a clean JSON error — log it, and (recommended Z5) `archiver.abort()`/destroy the response so the client gets a truncated/failed download rather than a silently-incomplete-but-200 zip. Pre-flight validation (folder exists, owned, non-empty) happens BEFORE any byte is written so the common failures are still clean 404/400/409.
- Empty folder (0 downloadable photos) → **400** "folder has no downloadable photos" (before streaming), rather than a valid-but-empty zip (Z6).

### Guest — `GET /api/guest/folders/:id/download-all`

- `requireGuest`; `:id` must be in `getPermittedFolderIds(guestUserId)` else **404** (the single choke point, `middleware/requireGuest.ts`).
- **Permission-level gate (Z1):** requires the folder's live `folder_permission.permissionLevel` to be **`download_all`** (recommended default — this is the level's literal intent and the reason it exists distinct from `download`); a `download`-only guest gets **403** (matching the guest-access house rule that a known-resource authorization limit is 403, not 404 — same as the per-photo `view`→download 403). A `view`-only guest → 403. See Z1 for the veto (allow plain `download` to zip too).
- Same streaming assembly as the owner endpoint (shared `lib/folderZip.ts`), scoped to the permitted folder's photos.
- Audit: one `folder_downloaded` row on the success path (Z7).

### Shared helper — `backend/src/lib/folderZip.ts`

- `streamFolderZip(res, { folderId, folderName, photos })` — encapsulates the `archiver` setup, per-photo MinIO read-stream append, filename de-duplication, header setting, and error/abort handling. Both routes call it after doing their own auth/scope check and photo query, so the streaming logic lives in exactly one reviewed place.
- **No BullMQ** for the recommended inline-stream default (Z3) — the zip is streamed as the response, not produced as a stored artifact. If Abhishek picks the async variant, that's a follow-up (see Z3).

## P5 acceptance criteria

- [ ] [Tester-live] `GET /api/folders/:id/download-all` on an owned non-empty folder returns `200` with `Content-Type: application/zip` and a `Content-Disposition: attachment` filename; the downloaded bytes are a valid zip containing exactly the folder's downloadable photos, each openable as its original image.
- [ ] [Tester-live] The response never contains a raw `s3Key` or a MinIO/pre-signed URL — only zip bytes (verified by inspecting the response body/headers; the archive entries are filenames, not keys).
- [ ] [Tester-live] Owner endpoint on a folder owned by a different owner → **404**; on an empty/no-downloadable folder → **400**.
- [ ] [Tester-live] Two photos with the same original filename produce two distinct, valid entries in the zip (de-dup suffix), not one clobbered entry.
- [ ] [Tester-live] `GET /api/guest/folders/:id/download-all` succeeds (200 zip) for a guest whose permission on that folder is `download_all`; a guest with only `download` → **403** (per Z1 default); a guest with only `view` → **403**; a folder not in the guest's permitted set → **404**; no/invalid guest session → **401**.
- [ ] [Developer-verified] The zip is streamed (archiver piped to `res`) — the whole archive is never buffered fully in memory or written to a temp file on disk (code review of `lib/folderZip.ts`).
- [ ] [Tester-live] One `folder_downloaded` audit row is written on a successful guest zip (`actorType='guest'`, correct `ownerId`, metadata `{ folderId, folderName, photoCount }`); a 403/404 produces NO row (success-path-only).

## P5 success signal

Tester can: as an owner, `GET /api/folders/:id/download-all` and unzip the result to find every downloadable photo from that folder as its original image; then, as a `download_all`-permissioned guest, do the same on a shared folder and get exactly the shared folder's photos, while a `download`-only guest gets 403 and an unshared folder gets 404 — and confirm a `folder_downloaded` audit row appears in the owner's `GET /api/audit` trail for the guest's download but never for the refused ones. Verify (code + response inspection) that no raw key ever leaves the backend.

---

# PART P6 — Basic search

**Endpoint:** `GET /api/search` (owner-scoped).
**Schema change:** none for the SQL-`ILIKE` scope (flag any optional index — S5).
**File:** `backend/src/routes/search.ts` (new), mounted `/api/search`.

## Goals

- An owner searches their own photos by **filename** (substring), **date range**, **folder**, and **AI label/category** (axis in-scope per S1). Results are paginated, Zod-validated, and each result is a photo card with a pre-signed 60s thumbnail URL (reuse `toPhotoCard`/`PHOTO_CARD_SELECT`).
- Plain SQL filtering against the local Postgres (`ILIKE` for filename, range predicates for date, equality for folder/category) — **no full-text search infra, no external search service** this pass (S4).

## Scope for this pass

### `GET /api/search` (owner)

- `requireAuth`; all filters via a Zod-validated **query** schema (`searchQuerySchema`, added to `lib/validation.ts`):
  - `q?: string` — substring match on `originalFilename` via `ILIKE '%q%'` (Prisma `contains`, `mode: 'insensitive'`). Trimmed; empty → treated as absent.
  - `from?: string` (ISO date), `to?: string` (ISO date) — range on the photo date. **Which date (S2):** recommended `takenAt` (EXIF capture date) when present, else `createdAt` (upload time) — but a single column is simpler; see S2 for the recommended default (filter on `createdAt` this pass, note EXIF-date filtering as a follow-up). Invalid date / `from > to` → 400.
  - `folderId?: string` — restrict to one folder (must be owned → 404 if not; or treated as empty result — see S3). `folderId=unfiled` (or a `unfiled=true` flag) → `folderId = null` photos (S3).
  - `category?: string` — one of the known categories (People/Nature/Animals/Food/Vehicles/Documents/Screenshots/Uncategorized). **In-scope per S1.** Matched against the photo's folder name (categories ARE the AI-generated folder names) OR a stored classification field — see S1 for exactly which column this reads.
  - `limit`/`offset` — reuse the existing pagination shape (`limit > 100` → 400, not clamp — the house rule).
- **Owner scoping is non-negotiable:** every query is `WHERE photo.ownerId = req.user.id` first; filters narrow within that. A search never returns another owner's photos, and `folderId`/`category` filters can't widen past the owner's own data.
- At least one filter or a bare "recent photos" behavior: an empty query (no `q`/date/folder/category) → recommended returns the owner's photos newest-first, paginated (S6) — i.e. search with no filter is a whole-library browse. Veto → require ≥1 filter (400 otherwise).
- Results: `{ photos: PhotoCard[], total, limit, offset }` — same shape as `GET /api/folders/:id/photos`, thumbnails pre-signed 60s.
- **No audit row** for search (a read of the owner's own data; not a shared-surface access — consistent with the audit spec's AP1 "owner-on-own-data actions excluded"). Flagged S7.

## P6 acceptance criteria

- [ ] [Tester-live] `GET /api/search?q=<substring>` returns only the owner's photos whose `originalFilename` matches (case-insensitive), paginated, each with a pre-signed 60s thumbnail URL (never a raw key).
- [ ] [Tester-live] `?from`/`?to` bound results to the date range; an invalid date or `from > to` → 400.
- [ ] [Tester-live] `?folderId=<owned>` restricts to that folder; `?folderId=<not owned>` → 404 (or empty per S3 default); `?folderId=unfiled` returns `folderId = null` photos.
- [ ] [Tester-live] `?category=<known category>` returns only photos in that category (per the S1-defined column); an unknown category value → 400 (Zod enum).
- [ ] [Tester-live] Combining filters (`q` + date + folder/category) ANDs them correctly.
- [ ] [Tester-live] `limit > 100` → 400; a garbage `limit`/`offset` → 400.
- [ ] [Tester-live] Search NEVER returns another owner's photo (seed two owners with overlapping filenames; each `GET /api/search?q=` returns only their own — leak-proof both directions).
- [ ] [Tester-live] `401` with no session.

## P6 success signal

Tester can, against the local stack with two owners each holding photos in several categories: search owner A's library by a filename substring (only A's matching photos, pre-signed thumbnails), by a date range (only in-range), by folder (only that folder), and by category (only that category), combine two filters and see the AND, confirm `limit=101` → 400, and confirm owner B's identically-named photos never appear in A's results (and vice-versa).

---

## Pending Decisions (recommended defaults — do NOT silently bake in; confirm or veto)

### P4 — Folder management (namespace F)

1. **F1 — A live guest share on a folder being merged-away or deleted. THE load-bearing correctness/security decision.** A guest was granted `folder_permission` on folder A (they can currently list/view/download A's photos). If A is merged into B, A's photos now live in B — which the guest was NOT granted. If A is deleted, its photos move to Unfiled — also not granted. Three options: (a) **migrate the permission to B / follow the photos**, (b) **silently revoke the share**, (c) **block the operation with 409 while a live share exists.**
   *Recommended default: **(c) block with 409** for BOTH merge and delete while any live (`revokedAt = null`, non-expired) `folder_permission` points at the folder.* Rationale: silently migrating (a) grants a guest access to photos the owner never chose to share (a real privilege-escalation — B may contain private photos); silently revoking (b) is a surprising side effect that severs an active client's access without the owner realizing. Blocking with a clear 409 ("This folder is shared with a guest — revoke the share first") makes the owner make the access decision explicitly. The owner already has one-tap revoke (`DELETE /api/guests/:id`). **This is the safe default; flag loudly.** Veto toward (b) if you'd rather the operation always succeed and just cut off the guest (and we surface a warning in the UI).

2. **F2 — Delete: what happens to the folder's photos?** Options: (a) **move to Unfiled** (`folderId = null`), (b) **refuse if non-empty** (409), (c) **cascade-delete the photos + their MinIO objects.**
   *Recommended default: **(a) move to Unfiled.*** Deleting an organizing folder should not destroy the photos inside it — they remain in the library, unfiled, reachable via `GET /api/photos/unfiled` and re-organizable. Cascade-delete (c) is destructive and irreversible (and would need MinIO object deletion, a new code path — currently nothing deletes objects); refuse-if-non-empty (b) is annoying and pushes the user to manually empty a folder first. Veto toward (c) only if "delete folder = delete its photos" is the intended product semantic (then we also spec MinIO object cleanup + a confirmation guard).

3. **F3 — Merge across collections?** Today there is effectively one default collection per user ("My Photos"), so cross-collection merge is currently moot — but the endpoint should decide. *Recommended default: **require A and B in the SAME collection**; a cross-collection merge → 400.* Keeps `@@unique([collectionId, name])` semantics clean and matches the single-collection reality. Veto to allow cross-collection merges (then define whose collection the merged folder lands in — B's).

4. **F4 — Audit rename/merge/delete?** The `audit_log` + `logAudit()` helper now exist. The audit spec (AP1) deliberately scoped the log to the *sharing/access* surface and excluded owner-on-own-data content actions (upload, move, folder_created). Rename/merge/delete are also owner-on-own-data. *Recommended default: **DO audit merge and delete** (new action types `folder_merged`, `folder_deleted`) because they are destructive/consequential and interact with sharing (F1) — an owner benefits from a record that a shared-then-merged folder's access changed; **do NOT audit plain rename** (`folder_renamed`) — it's cosmetic and high-frequency, matching the AP1 exclusion of cosmetic owner actions.* These are additive `action` strings + `metadata` only (no schema change). Veto to (a) audit all three, or (b) audit none (keep AP1's owner-actions-excluded rule strict).

5. **F5 — Can AI-generated folders be renamed / merged / deleted, or only `custom` ones?** `Folder.categoryType` is `ai_generated | custom`. An AI-generated folder is where the worker files newly-classified photos of that category; renaming/deleting it has a subtle interaction — the worker's find-or-create keys on the category *name*, so a renamed/deleted "Nature" folder would just be re-created on the next Nature upload (a rename effectively forks: old renamed folder + a fresh "Nature" reappears). *Recommended default: **allow all three operations on BOTH types** (the simplest, most user-expected behavior — folders are folders), and accept that the worker may re-create an AI folder by its category name on the next matching upload (this is benign — the user's rename/merge intent for the existing photos is honored; new photos of that category just get a fresh home). Do NOT special-case `categoryType`.* Veto to restrict rename/merge/delete to `custom` folders only (then AI folders are immutable, and we return 409/403 on an attempt) — cleaner worker semantics but a more surprising UX.

6. **F6 — Folder "reorder" (roadmap § 11's `PATCH` also says "reorder").** *Recommended default: **out of scope this pass.*** No `sortOrder`/`position` column exists; folders are currently returned in a deterministic order (name/createdAt). Reorder needs an additive column + drag-reorder UI — a separate small pass. `PATCH /api/folders/:id` handles rename only. Veto to include a `sortOrder` column now (additive migration) even without the UI.

### P5 — Bulk download-all / zip (namespace Z)

1. **Z1 — Does plain `download` permission allow the folder zip, or only `download_all`?** The three-level model exists precisely so `download_all` can mean "bulk". *Recommended default: **the guest zip endpoint requires `download_all`**; a `download`-only guest (per-photo download allowed) gets 403 on the bulk endpoint.* This gives the level its literal, intended meaning and lets an owner grant "download these one at a time" vs "grab everything" distinctly. Veto: treat `download` as sufficient for the zip too (then `download_all` becomes vestigial and Z1 collapses — the zip just needs ≥ `download`).

2. **Z2 — New dependency (`archiver`).** Streaming a zip on-the-fly needs a zip library; `archiver` is the standard, well-maintained, stream-oriented choice (pipes into an HTTP response, appends read-streams, no temp files). *Recommended default: **add `archiver` to `backend/package.json`.*** It's a pure Node library (no cloud, no native binary issues on the local Docker image). Flagged per the constraint that new deps get called out. Veto to hand-roll with Node's `zlib` (more code, more risk) or to defer P5 entirely if adding a dep is unwanted.

3. **Z3 — Inline stream vs. BullMQ job (THE P5 decision).** The guest-access spec's rule ("async only if genuinely slow") applies. A folder zip streams object-by-object; for typical folders (tens to a few hundred photos) this is fine to stream inline within the request. A pathologically large folder (thousands of large originals) could hold a connection open a long time. *Recommended default: **inline-stream this pass**, with a **guard cap** — if the folder has more than **N photos** (recommended **N = 500**) or estimated total bytes over a threshold, return **409 "folder too large to download as a single zip — narrow it down"** rather than starting a giant stream. Async (enqueue a BullMQ job that builds the zip into MinIO and returns a pre-signed URL when ready) is DEFERRED as a follow-up if real usage hits the cap.* Rationale: async adds a stored-artifact lifecycle (where does the zip live, when is it cleaned up, how does the client poll/get notified, a new pre-signed-URL-to-a-zip path) — real complexity for a local MVP that no current folder size justifies. Veto toward async-from-the-start if large-folder support is a hard MVP requirement (then this becomes a bigger spec: a `zip_jobs` surface + cleanup).

4. **Z4 — Which photos go in the zip?** Only photos with a real downloadable original. *Recommended default: include photos that have a stored original `s3Key` (i.e. successfully uploaded); **skip `failed` photos** (no/partial original) and **skip `duplicate` photos** (their bytes are the same as the original they point at — including both would put identical bytes twice; the original is already included). Include `done` and `uncategorized`-but-stored photos.* Veto to include duplicates too (some users want every file they uploaded).

5. **Z5 — Mid-stream read failure handling.** Once bytes are flowing, a per-object MinIO read failure can't become a clean JSON error. *Recommended default: **abort the archive and destroy the response**** so the client gets a failed/truncated download (and we log the error) rather than a 200 that silently omits photos. Pre-flight checks (auth, ownership/scope, non-empty) run before any byte is written, so the ordinary failures stay clean. Veto to "skip the unreadable object and continue" (a complete-looking zip missing some photos — arguably worse).

6. **Z6 — Empty folder.** *Recommended default: **400 "no downloadable photos"** before streaming*, rather than returning a valid-but-empty zip. Veto to return an empty zip (200).

7. **Z7 — Audit the download-all?** *Recommended default: **audit the GUEST zip** (`folder_downloaded`, actorType guest) — it's a shared-surface access, exactly the "who downloaded" differentiator the audit log exists for; do NOT audit the OWNER's own zip (owner-on-own-data, per AP1).* New additive `action` string. Veto to audit both or neither.

### P6 — Basic search (namespace S)

1. **S1 — Is AI-label/category search in scope, and which column does it read?** Roadmap § 3 says "keyword search across categories and metadata"; Week 11 says "by folder, by date, by filename" (category not explicit). *Recommended default: **include a `category` filter this pass**, implemented by matching against the photo's **folder name** (the AI-generated folders ARE named for their category — "Nature", "People", etc.), i.e. `category` filter = "photos whose folder's name equals this category". This needs NO new column and NO new index (the folder relation already exists). Free-text search over raw Vision *labels* (the individual detected labels, not the mapped category) is DEFERRED — labels aren't stored in a queryable per-photo column today, and full-label search implies more infra (S4).* Veto to (a) drop category entirely this pass (filename+date+folder only), or (b) include raw-label search now (then we spec where labels are stored/indexed — a bigger change).

2. **S2 — Which date does the date-range filter use — upload date or EXIF capture date?** *Recommended default: **filter on `createdAt` (upload time)** this pass — it's always present and indexed-friendly; EXIF `takenAt` can be null (not every photo has EXIF date) and mixing "coalesce takenAt else createdAt" complicates the SQL. Note EXIF-capture-date search as a clean follow-up.* Veto to filter on the EXIF capture date (then define the null-fallback behavior and confirm the column name/index).

3. **S3 — `folderId` filter for a folder the owner doesn't own, and the Unfiled case.** *Recommended default: **a not-owned `folderId` → 404** (consistent with every other folder-scoped endpoint's 404-not-403), and **`folderId=unfiled`** (a reserved literal) → photos with `folderId = null`.* Veto to treat a not-owned folder as an empty result (200 `[]`) instead of 404 — but 404 matches the house rule.

4. **S4 — SQL `ILIKE` vs full-text search infra.** *Recommended default: **plain SQL** — Prisma `contains`/`mode: 'insensitive'` for filename, range predicates for date, equality for folder/category. This fits the local Postgres slice with zero new infra.* Anything fancier (Postgres full-text `tsvector`, trigram `pg_trgm` indexes, a search service) is DEFERRED and flagged as a future performance pass. Veto only if substring search over filenames is known to be too slow at expected scale (it won't be for an MVP library).

5. **S5 — Any new index for search?** *Recommended default: **no new index this pass.*** Owner-scoping already filters on `ownerId` (indexed via existing relations); filename `ILIKE '%...%'` can't use a btree index anyway (leading wildcard); date/folder/category filters ride existing columns. If a Tester or profiling shows a slow query at MVP data volumes, add an index in a follow-up. Veto to add a `pg_trgm` GIN index on `originalFilename` now (additive migration) for faster substring search.

6. **S6 — Empty query (no filters) behavior.** *Recommended default: **return the owner's whole library newest-first, paginated** (search-with-no-filter = browse-all).* Simple and useful. Veto to require at least one filter (400 otherwise) if a bare `GET /api/search` should not double as a full-library dump.

7. **S7 — Audit search?** *Recommended default: **no** — search is a read of the owner's own data (not a shared-surface access), consistent with AP1 excluding owner-on-own-data actions from the audit log.* Veto to log searches (low value, high volume — not recommended).

---

## UI that needs a wireframe round (for Master to queue)

The backend of each part is fully buildable and Tester-verifiable over HTTP **without** any UI — none is UI-blocked. Per-part UI status:

- **P4 (folder rename/merge/delete) — NEEDS a wireframe round.** The surface is `/organize` (the existing folder-management page with the sidebar tree + move/reclassify controls). Rename could be a thin inline edit, but **merge is a genuine interaction** (pick a source folder, pick a destination, confirm the consequence — especially the F1 "this folder is shared, revoke first" 409 path and the F2 "photos will move to Unfiled" delete confirmation). Recommend a propose→pick→build round covering: the rename affordance, the merge picker + confirm, and the delete confirm (with the shared-folder-blocked and photos-go-to-Unfiled messaging). Backend is buildable first; UI follows the pick.

- **P5 (download-all button) — THIN addition, likely no full round needed.** A single "Download all" button on the owner folder views (`/browse` and/or `/organize`) and on the guest portal folder view (`/g/[token]`, shown only when the guest holds `download_all` per Z1). It's a button that hits the streaming endpoint — no new information surface. Recommend Master treat it as a thin add (a one-line "where does the button go + when is it shown" confirmation) rather than a full wireframe round, unless Abhishek wants the round.

- **P6 (search) — NEEDS a wireframe round.** A search bar + a results view is a **new information surface** (where does the search bar live — global top bar? a dedicated `/search` page? — how are filters exposed [filename box, date pickers, folder/category dropdowns], how are results rendered [reuse the photo-card grid + viewer], empty/no-results state). Recommend a propose→pick→build round. Backend `GET /api/search` is buildable + verifiable first.
