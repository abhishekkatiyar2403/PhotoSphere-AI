# MR: Basic search (P6 backend) — `GET /api/search`

**Branch:** `feature/ai-classification` → (target TBD; no remote push yet)
**Spec:** `specs/folder-mgmt-download-search.md` PART P6, built on the confirmed S1–S7 defaults.
**Scope:** BACKEND ONLY. P6's search UI is wireframe-blocked and deliberately out of this pass. No schema change, no migration, no new index (S5), no new dependency, no audit (S7).

## Summary

Adds one owner-scoped search endpoint, `GET /api/search`, that finds a caller's own photos by filename substring, upload-date range, folder, and AI category. Plain Prisma/SQL — no full-text infra (S4). Results reuse the existing photo-card shape (`toPhotoCard`/`PHOTO_CARD_SELECT`) so every thumbnail is a pre-signed 60s URL, never a raw storage key; same response envelope as `GET /api/folders/:id/photos`: `{ photos, total, limit, offset }`.

## Endpoint — `GET /api/search`

`requireAuth` + `asyncHandler`; every filter validated by a Zod **query** schema `searchQuerySchema` (added to `lib/validation.ts`). All filters optional; combining them ANDs. Empty query (no `q`/date/folder/category) → the owner's whole library newest-first, paginated (S6 — search-with-no-filter = browse-all).

| Filter | Behavior |
|---|---|
| `q?` | Substring on `originalFilename`, case-insensitive — Prisma `contains` + `mode: 'insensitive'` = SQL `ILIKE` (S4). Trimmed; empty/whitespace normalized to absent (does NOT filter to nothing). |
| `from?` / `to?` | ISO date, **range on `createdAt`** (S2 — upload time; EXIF `takenAt` deferred). Invalid date → 400 (Zod `z.coerce.date`); `from > to` → 400 (checked in-route after both parse). |
| `folderId?` | A **UUID** → restrict to that folder, but it must resolve to a folder the caller OWNS (folder → collection → ownerId) else **404** (house rule). The reserved literal **`unfiled`** → `folderId: null` photos (S3). |
| `category?` | A Zod **enum** of the known categories (People/Nature/Animals/Food/Vehicles/Documents/Screenshots/Uncategorized). Unknown value → **400** (S1). Implemented as a **folder-name match** — see below. |
| `limit` / `offset` | Same shape as `folderPhotosQuerySchema`. `limit > 100` → **400** (house rule, not a clamp); garbage `limit`/negative `offset` → 400. |

## S1 — category = folder-name match (owner-scoped)

The AI-generated folders ARE named for their category ("Nature", "People", …). `category=Nature` is implemented as: find the **caller's own** folders whose `name` equals the category (`folder.name = category AND folder.collection.ownerId = req.user.id`), then filter photos to `folderId IN (those folder ids)`. No new column, no new index.

- A category with no matching folder for this owner → **empty result** (200, `total: 0`), not a dropped filter.
- The folder-name lookup is itself owner-scoped, so `category` can never match another owner's identically-named folder (there is a dedicated test for exactly this).
- Combining `category` with an explicit `folderId`: intersected correctly — `folderId=unfiled` + a category (a category is always a folder) → contradictory → empty; a specific `folderId` not among the category folders → empty; otherwise the narrower specific folder is kept.

Raw-Vision-label free-text search is DEFERRED (labels aren't in a queryable per-photo column this pass) — not this endpoint.

## S2 — date axis = `createdAt`

Range predicates on `createdAt` (upload time), always present. `gte from`, `lte to`, inclusive. EXIF-capture-date (`exifTakenAt`, nullable) search noted as a clean follow-up.

## S3 — folderId / unfiled handling

- UUID owned → filter to it.
- UUID not owned (or non-existent) → **404** (never confirm a foreign folder exists — matches every other folder-scoped endpoint).
- literal `unfiled` → `folderId: null`.
The schema accepts `folderId` as `union(uuid, literal("unfiled"))`, so a non-UUID, non-`unfiled` value is a 400.

## LEAK-PROOF owner scoping (non-negotiable)

Every query builds its `where` starting from `{ ownerId: req.user!.id }`; all filters narrow WITHIN that. No filter can widen past the caller's own data:
- filename/date filters only add predicates to an already-owner-scoped `where`;
- `folderId` is verified owned before it's applied (else 404);
- `category`'s folder lookup is owner-scoped, so it can only ever resolve the caller's own folders.

A dedicated two-owner test seeds identical filenames under owner A and owner B and asserts each owner's `?q=` returns ONLY their own photo — **both directions**.

## Files

- `backend/src/routes/search.ts` — **new.** The endpoint. Mounted `/api/search` in `app.ts` (a top-level GET, no `:id` shadowing hazard).
- `backend/src/lib/validation.ts` — added `searchQuerySchema` + `SEARCH_CATEGORIES` + `UNFILED_FOLDER_LITERAL` + the `SearchQuery` type.
- `backend/src/app.ts` — import + mount `searchRouter` at `/api/search`.
- `backend/src/__tests__/search.smoke.test.ts` — **new**, 20 tests.

## Test coverage (20 tests, all P6 acceptance criteria)

- **q** — case-insensitive substring returns only matching owned photos; response has a `thumbnailUrl` (pre-signed or null) and NO `s3Key`/`s3ThumbnailKey` anywhere in the body; empty/whitespace `q` treated as absent.
- **date** — `?from`/`?to` bound the range (inclusive); `?from`-only lower bound; invalid date → 400; `from > to` → 400.
- **folderId** — owned restricts; not-owned → 404; non-existent → 404; `unfiled` → folderId-null only.
- **category** — folder-name match returns exactly that category's photos; unknown → 400; no-matching-folder → empty; **owner-scoped: does NOT match another owner's identically-named folder.**
- **combined** — `q + folderId` ANDs (only the photo satisfying both).
- **pagination** — `limit>100` → 400; garbage `limit`/negative `offset` → 400.
- **S6** — empty query → whole library newest-first, `limit:50`/`offset:0` defaults.
- **LEAK-PROOF** — two owners, overlapping filenames, each `?q=` returns only their own (both directions).
- **401** with no session.

## Verification

- `npm run typecheck -w backend` — clean.
- `npm run lint -w backend` — clean.
- Full backend suite — **137/137 green** (was 117, +20). Search file in isolation: 20/20. (Docker Postgres/Redis/MinIO healthy; the `prisma:error` line in the suite log is the pre-existing deliberate 409-collision assertion in `classification.smoke.test.ts`, not a failure.)

## Deviations

None. Built exactly to the P6 spec on the confirmed S1–S7 defaults. No UI, no schema change, no migration, no new index, no new dependency, no audit, no push.
