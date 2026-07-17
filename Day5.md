# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Note: this repo has a root `CLAUDE.md` (multi-agent orchestration workflow) plus `Day1.md` (auth + upload baseline), `Day2.md` (AI-classification backend), `Day3.md` (organize/browse/dashboard UI + Next.js 14.2.35 bump + Guest Access **backend**), and `Day4.md` (Guest Access **frontend** — the `/share`, `/guests`, `/g/[token]` pages). This file covers everything built **after** Day4.md, on `feature/ai-classification` (through commit `7f33f64`, all pushed): the **Audit log + Phase-1-close polish** (Week 11–12), the **P7 audit-viewer UI**, and the three **deferred features** — folder rename/merge/delete, bulk zip-download, and search — each built backend + UI. Read Day1–4 first; this file only covers what's new since Day4.md.

## What Day 5 covered, in one sentence

Phase 1's tail got finished: an owner-scoped **audit trail** (who shared / viewed / downloaded, with a `/activity` viewer), plus the three long-deferred features (**folder rename/merge/delete**, **bulk "download all" zip**, **search**) — all built backend-first, Tester-verified, and shipped, completing the entire local-first slice.

## Commands (additions to Day1–4)

```bash
# Migration added this stretch (continues after Day2's classification migration)
# backend/prisma/migrations/20260705154110_add_audit_log/
npx prisma migrate deploy   # replays all migrations cleanly on a fresh DB (verified)

# New backend test files (vitest filename filter, same convention as prior days)
npm run test -w backend -- audit.smoke          # audit hooks + owner-scoped GET /api/audit
npm run test -w backend -- folder-mgmt.smoke    # rename/merge/delete + F1 guard + /unfiled reachability
npm run test -w backend -- folder-zip.smoke     # streaming zip, no-raw-key, download_all gate
npm run test -w backend -- search.smoke         # GET /api/search, leak-proof owner-scoping

# New deps this stretch
#   helmet ^8.2.0     — security headers (P1)
#   archiver ^7.0.1   — streaming zip for bulk download (P5), + @types/archiver (dev)

# New .env vars (backend/.env, gitignored) from the audit work:
NOTIFICATIONS_EXPOSE_OTP="true"   # (from Day3/4 guest access; kept true locally for testing)
# Backend suite grew 85 → 137 across this stretch (+52).
```

New frontend routes: `/activity` (audit viewer) and `/search`. New top-bar nav links: "Activity" and "Search".

## Architecture additions

### The audit log — an owner-scoped, append-only trail (Week 11–12, spec `specs/audit-and-polish.md`)

The differentiator "who viewed/downloaded my photos." It cashes in the single choke-point handlers the guest-access build (Day3/Day4) deliberately left at every access action.

- **Schema:** one additive `audit_log` table (migration `20260705154110_add_audit_log`) — `{ actorType 'owner'|'guest', actorId, ownerId, action, resourceType?, resourceId?, metadata Json?, ipAddress?, createdAt }` + two indexes. **IDs are plain strings, NOT FK relations** — deliberately, so an audit row survives deletion of the resource it names (a revoked guest, a deleted folder). **Deviation from the roadmap schema (accepted, decision AP3): a denormalized `owner_id` column** so `GET /api/audit` is a single indexed owner-scoped scan and leak-proofing is trivial (an owner's trail includes both their own actions AND their guests' view/download actions).
- **`backend/src/lib/audit.ts` — the ONLY writer, and its contract is load-bearing.** `logAudit({...}): void` is **fire-and-forget**: it is NEVER `await`-ed inside a primary `$transaction`, is called AFTER the primary operation commits (or right before the response on a guest read's 200 path), and wraps its own insert in a `.catch()` that logs-and-swallows. **A failed audit write can therefore never roll back or fail an approval / revoke / download.** No BullMQ (a single fast indexed insert, per the "async only if genuinely slow" rule). If you add a new audited action, follow this exact shape — additive `action` string (the column is a free string), success-path-only, post-commit. There is a test-only `__setAuditInsertForTest` seam (guarded to `NODE_ENV=test`) that forces an insert failure to prove the primary action still succeeds.
- **7 hooks (owner + guest actors):** `share_created`, `access_requested`, `access_approved`, `access_denied` (with `metadata.reason`: owner_denied / otp_attempts_exceeded / otp_expired), `guest_revoked`, `photo_viewed`, `photo_downloaded`. **Logged ONLY on the success/200 path** — a view-only guest hitting `/download` (403) or any 404 writes NO row. Owner-on-own-data actions (login, upload, move, folder_created) are deliberately NOT audited (AP1 — the log is scoped to the sharing/access surface).
- **`GET /api/audit` (`backend/src/routes/audit.ts`):** owner-scoped (`where ownerId = req.user.id`, always — leak-proof), paginated, filterable by `action` / `actorType` / `from` / `to`. **Append-only from the API: no PATCH/DELETE, no `GET :id`.**
- Later additive tweak: `photo_viewed`/`photo_downloaded` also capture `metadata.folderName` (not just `folderId`) so the viewer can render "photo in Nature" instead of a raw UUID; the frontend reads `folderName` with an id fallback for older rows.

### P1 polish — Helmet (`backend/src/app.ts`)

`helmet()` added for security headers (`X-Content-Type-Options`, `X-Frame-Options`, HSTS, `Referrer-Policy`, `Cross-Origin-Resource-Policy`, no `X-Powered-By`). **CSP is relaxed/off under `NODE_ENV=development`** (decision AP10) so it doesn't break the Next dev flow; a real CSP is wired for prod. **P2** (rate-limiter coverage) and **P3** (empty/error/loading-state sweep across all 7 pages) were both **verified already-complete — zero code change** — the deliverable was the written enumeration/findings, not new code (don't re-audit expecting to find gaps).

### P7 — the `/activity` audit viewer (`frontend/src/app/activity/page.tsx`)

Dedicated page (wireframe Option A) rendering `GET /api/audit`: a filter bar (action / owner-vs-guest toggle / date range + Apply, held in local state — no `useSearchParams`), a paginated newest-first feed with a colored left-edge + OWNER/GUEST badge per row, the actor ("you" / guest email), a metadata second line (folder name, permission level, deny reason, IP), and relative timestamps. Owner-gated like `/dashboard`.

### P4 — folder rename / merge / delete (`backend/src/routes/folders.ts`, extended)

- `PATCH /api/folders/:id` (rename; **409 on name collision caught off the `@@unique([collectionId,name])` constraint**, never an app pre-check), `POST /api/folders/:id/merge` (move A's photos → B, reconcile BOTH `photoCount`s inside ONE `serializableTransaction()` re-deriving the moved count, delete A), `DELETE /api/folders/:id` (photos → Unfiled, folder removed).
- **THE load-bearing rule (decision F1):** a merge or delete of a folder that has a **live guest `folder_permission`** (`revokedAt = null`, non-expired) is **BLOCKED with 409** — the guard runs FIRST, before any data moves. This is deliberate: silently migrating the guest's grant to the merge target would expose photos the owner never shared (privilege escalation); silently revoking would sever an active client without the owner realizing. The owner must revoke the share explicitly first. If you add another folder-mutating op, apply the same guard.
- **Delete moves photos to Unfiled (`folderId = null`), never destroys them or their MinIO objects** (decision F2). This exposed and fixed a real reachability bug: `GET /api/photos/unfiled` filtered `status IN (failed,duplicate)`, so a `done` photo orphaned by a folder-delete would be invisible. **`/unfiled` was broadened to `folderId IS NULL AND status NOT IN (pending,processing)`** — "unfiled" now means *not in any folder, whatever the reason*, anchored on `folderId: null` so a filed photo can never appear. Any future "photo has no folder" state must be surfaced here.
- **Audit (F4):** merge/delete write `folder_merged`/`folder_deleted`; rename is NOT audited (cosmetic). Ops are allowed on `ai_generated` folders too (F5); the worker may re-create an AI folder by its category name on the next matching upload — benign.

### P5 — bulk "download all" (folder zip) — streaming, no raw keys

- `GET /api/folders/:id/download-all` (owner) + `GET /api/guest/folders/:id/download-all` (guest). Shared helper `backend/src/lib/folderZip.ts` (`streamFolderZip`) + pre-flight helper `backend/src/lib/folderDownload.ts`.
- **The ZIP is assembled on-the-fly by piping each object's MinIO read stream through `archiver` into the HTTP response** — never buffered fully in memory or to a temp file, and **the client receives only zip bytes, never a raw `s3Key` or pre-signed URL** (archive entry names are the photos' original filenames, de-duplicated on collision). `lib/storage.ts` gained `getObjectStream(key)` (authorized server-side read) for this — distinct from the client-facing pre-signed-URL helper.
- **Decision Z3: inline stream with a 500-photo guard cap** (over → 409 "narrow it down"); async/stored-zip deferred. **Decision Z1: the guest zip requires `download_all`** (a `download`-only guest → 403); this is the reason `download_all` exists distinct from `download`. **Z4:** only stored `done` originals go in (skip failed/duplicate/in-flight). **Z5:** a mid-stream read error aborts + destroys the response rather than emitting a silently-incomplete 200. **Z7:** the guest zip writes a `folder_downloaded` audit row on success; the owner's own zip is not audited.

### P6 — search (`backend/src/routes/search.ts`, new, mounted `/api/search`)

- `GET /api/search` (owner-scoped): `q` (filename substring, ILIKE via Prisma `contains`+`mode:insensitive`), `from`/`to` (date range on `createdAt` — decision S2, EXIF `takenAt` deferred), `folderId` (owned → restrict, not-owned → 404, literal `unfiled` → `folderId:null`), `category` (a Zod enum of the 8 categories, **matched as an owner-scoped folder-name filter** — the AI folders ARE named for their category, decision S1), `limit`/`offset` (`>100` → 400). Empty query → whole library newest-first (S6). Plain SQL, no full-text infra (S4), no new index/schema.
- **Leak-proof owner-scoping is non-negotiable:** every query starts `WHERE ownerId = req.user.id`; the folder/category lookups are themselves owner-scoped so nothing can widen past the caller. **No audit** for search (owner-on-own-data read, S7). Results are photo cards with pre-signed 60s thumbnails.

### The three feature UIs (`33731cb`)

- **P4 on `/organize`:** a per-folder "⋯" kebab (Rename inline / Merge into… modal with a destination picker / Delete confirm), shown on real folders (incl. AI folders) but not the virtual Unfiled row. The **F1 409 flips the modal to a red "shared with a guest — revoke first" block**; the delete confirm carries the **"N photos will move to Unfiled — not deleted"** copy. Merge/delete refresh the tree + counts from the server.
- **P5 "Download all" button:** owner folder header on `/organize` + `/browse`; guest `/g/[token]` shown **only when the guest's `permissionLevel === "download_all"`** (that level is exposed on `GuestFolder`). The download is triggered by a **credentialed top-level browser navigation** (`window.location.assign`) to the streaming endpoint so the browser saves the attachment — NOT a fetch-into-memory.
- **P6 `/search` page:** filter bar + results grid (reuses the photo-card grid + `PhotoViewer`) + pagination + loading/empty/error states. Owner-gated.

## Testing (additions to Day1–4)

Four new backend suites, same skip-not-fake discipline: `audit.smoke`, `folder-mgmt.smoke`, `folder-zip.smoke`, `search.smoke`. **Backend suite grew 85 → 137.** The audit-log and all three deferred backends were Tester-verified in a comprehensive backend-only live pass (**208 assertions, 0 bugs, 0 security holes** — `reports/2026-07-06_1810.md`), covering the F1 share-guard (blocks merge AND delete), merge count-exactness, delete→Unfiled reachability, zip no-raw-key + `download_all` gate + audit, and search leak-proofing across two owners.

**Known verification gap (honest):** the **browser-DOM pass of the P4/P5/P6 UIs did not complete** — the Playwright/CDP Tester harness failed three times (two 600s watchdog stalls, then a session-limit hit mid-run; none an app issue). The UIs are judged substantively ship-ready (build clean; the backends are 208-verified; the Developer live-drove every API path over HTTP, incl. the 409 shared-block and the download_all gate), but the pure visual/interaction pass (modal rendering, clicks, a real zip save) is outstanding — click through `/organize`, `/search`, and a guest link locally to confirm. This same harness also left the P7 `/activity` browser pass outstanding. Frontend still has no automated test suite (unchanged from Day1–4).

## Operating notes / gotchas (carried + new)

- **Never run `next build` while `next dev` is live on the same `.next` dir** — it corrupts the dev server's route manifest. Bit multiple cycles; the P4/P5/P6 UI build worked around it by building to an isolated `.next-verify` dir. Recovery: kill dev, `rm -rf frontend/.next`, restart.
- **`npm audit` shows a "critical" that is NOT reachable** (checked 2026-07-06): it's in `vitest` (dev-only test runner) and requires the Vitest UI server, which this project never installs or runs (`@vitest/ui` absent; test script is headless `vitest run`). Its only fix is a vitest 2→4 double-major jump — deferred. The remaining `next` highs need the Next 15→16 major migration — also deferred. `npm audit fix --force` would drag in BOTH breaking majors; don't run it. `next` stays pinned at `14.2.35`.
- **Fire-and-forget audit writes** mean a Tester checking for an audit row must poll briefly (post-response insert) — by design, not flakiness.

## Where things stand after Day 5

The entire **Phase-1 local-first slice is built end-to-end and pushed** to `feature/ai-classification` (`7f33f64`; `master`/`main` still doesn't exist on the remote, no PR). Zero open bugs. Everything through roadmap Week 12 plus the three deferred features (P4/P5/P6) is done. Outstanding/optional, all awaiting an explicit decision: the browser-DOM UI pass (harness-blocked); the F/Z/S + AP + G decision batches (built-on safe defaults, open for veto); a dev-DB clean-slate (~26 accumulated `@example.com` Tester-seed accounts, no real data); and the two deferred hardening majors (Next 15→16, vitest 2→4). MR drafts for this stretch: `reports/mr-drafts/{audit-and-polish,audit-viewer-ui,folder-mgmt,bulk-zip-download,search,folder-search-ui}.md`.
