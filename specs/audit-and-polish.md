# Spec — Audit Log + Phase-1-Close Polish (Week 11–12)

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 7 (Phase 1 — MVP, Week 11–12: Audit, Polish, Launch Prep), § 6 (Database Schema — `audit_log` table + `idx_audit_actor`), § 11 (API Design — `GET /api/audit`), § 12 (Security Architecture — Layer 6 "Audit — immutable log of all actions"), § 2 (Market Differentiation — "Audit trail (who viewed/downloaded)")
**Status:** draft
**Written by:** Planner Agent, 2026-07-05

## Problem

Week 1–10 is complete, tested clean, and pushed: owners upload, AI-organize, browse, and share scoped folders with guests behind an OTP gate; guests view and download only what they were granted. But two of the roadmap's marquee differentiators for Phase-1 close are still missing:

1. **Audit trail (roadmap § 2, § 12 Layer 6).** "Audit trail (who viewed/downloaded)" is a checkmark PhotoSphere claims over Google/Apple/Dropbox. Today, when a guest views or downloads a photo, or an owner approves/denies/revokes a share, *nothing is recorded* — the owner has no answer to "who saw my photos, and when." The guest-access build was deliberately written so this is a non-refactor add: `approve`, `deny`, `revoke`, and guest `view`/`download` each already flow through a single choke-point handler (Day3.md, Day4.md, spec decision G9). This spec cashes that in.

2. **Phase-1-close polish.** The roadmap's Week 11–12 line item bundles "Error handling, loading states, empty states throughout UI" plus a few concrete loose ends deferred from earlier weeks (folder rename/merge/delete from Week 5–6; bulk `download_all` from Week 9–10; basic search). This spec makes "polish" concrete and *bounded* — a specific checklist with a recommendation on what makes this pass vs. stays deferred — rather than an open-ended "make everything nicer."

The two halves are deliberately delineated below. **Part A (audit log) is the buildable, roadmap-specified core and the priority of this pass.** Part B (polish) is a scoped checklist; several of its items are flagged for deferral.

## Hard constraints (baked in, non-negotiable)

1. **Local-first slice only.** Docker Compose (Postgres/Redis/MinIO), the existing swappable mocks (Vision, notifications). **No AWS/Terraform/EKS/Stripe, no real email/SMS/push, no cloud credentials, no production deploy.** Several Week 11–12 roadmap bullets are cloud/infra and are explicitly OUT of scope (see Non-goals) — flagged for Master/Abhishek, not specced as a build.
2. **Additive Prisma migration**, continuing the existing history (last: `20260703215312_add_guest_access_otp`). One new table (`audit_log`) + its index. Nothing renamed or removed. Follows the established snake_case-DB / camelCase-Prisma convention and roadmap § 6's `audit_log` shape.
3. **Existing conventions, verbatim.** `requireAuth` + `asyncHandler` + Zod-on-every-query for the new endpoint; **404-not-403** on any ownership mismatch; opaque tokens (never JWT — unchanged); **owner-scoped** — an owner sees only audit entries for their own resources/guests, never cross-owner data; pre-signed URLs only for any image (the audit surface returns no image data at all). No new dependency.
4. **Audit writes must never break the primary action.** Logging is a side effect, not part of the transaction that performs the action. A failed audit-log insert must NOT roll back an approval, a revoke, a download, or any other primary operation. See § A3.
5. **The audit log is append-only from the API's perspective.** No `PATCH`/`DELETE /api/audit`. Roadmap § 12 calls it "immutable log of all actions" — there is no edit or delete endpoint in this pass, and the write helper only ever inserts.

## Goals

**Part A — Audit log (priority):**
- A new `audit_log` table (roadmap § 6) plus a single reusable write helper.
- Logging hooks at the existing choke points for a defined, enumerated set of actions.
- `GET /api/audit` — owner-scoped, paginated, Zod-validated, filterable by action type and date range, returning an owner's activity log (who did what to which resource, when, from what IP/device).
- Fire-and-forget, correctness-safe write path (constraint 4).

**Part B — Polish (bounded checklist, some items recommended for deferral):**
- A concrete list of Phase-1-close polish items, each marked **IN this pass** or **DEFERRED** with reasoning, for Abhishek to confirm.

## Non-goals (explicitly out of scope for this pass)

**Roadmap Week 11–12 bullets that are OUT of the local-first slice (flagged for Master/Abhishek, NOT built):**
- **Email notifications** (invite sent, access approved, access expiring) — needs real email delivery (SES/Resend); mocked-only per CLAUDE.md. Would be a one-file extension of the existing `lib/notifications` mock if wired, but there is no owner/guest surface to *receive* it locally. Deferred to whenever real email is approved. **OUT.**
- **Deploy to production (AWS or Railway)** — real cloud infra, explicitly deferred per CLAUDE.md. **OUT.**
- **Stripe / pricing page** — no Stripe, no payments, per CLAUDE.md ground rule. **OUT.**
- **Rate limiting on all APIs** and **Security headers (Helmet.js)** — *partially already done* (auth/upload/reclassify/invite rate-limit buckets all exist and are tested; Helmet is a small addition). See Part B for the bounded piece of this that is IN scope (a Helmet pass + an audit of which endpoints still lack a limiter).

**Audit-specific non-goals:**
- **An audit-log viewing UI** — `GET /api/audit` is the buildable backend core; whether the owner-facing activity view is a new page or a tab needs a decision (see "UI that needs a wireframe round"). No UI is designed or built in this spec.
- **Owner-side content actions (login, upload, photo move/reclassify, folder create)** are NOT audited this pass — see Pending Decision AP1. The audit log this pass is scoped to the **sharing/access surface** (the differentiator: "who viewed/downloaded", plus the approval/revoke governance trail), not general owner activity.
- **Geo enrichment** of audit `ip_address` (city/country) — same external-service constraint as guest access (decision G8); capture raw IP + device only.
- **Log retention / pruning job** — no scheduled purge in this pass (see AP2); entries accumulate. A prune job is a later concern (and trivially a BullMQ repeatable job when wanted).
- **Real-time audit streaming / webhooks** ("when photo classified → Slack") — Phase 3 (roadmap § 9). Not this pass.
- **Exporting the audit log** (CSV/PDF) — not in the roadmap's Phase-1 line; deferred.

## Scope for this sprint

### Part A — Audit log

#### A1. Schema (`backend/prisma/schema.prisma` + a new additive migration)

One new model, matching roadmap § 6's `audit_log` shape (camelCase Prisma / snake_case DB). Additive-only — no existing model touched.

```prisma
model AuditLog {
  id           String   @id @default(uuid())
  actorType    String   @map("actor_type")            // 'owner' | 'guest'
  actorId      String   @map("actor_id")              // users.id or guest_users.id
  ownerId      String   @map("owner_id")              // the owner who OWNS this trail (see note)
  action       String                                 // enum below (A2)
  resourceType String?  @map("resource_type")         // 'photo' | 'folder' | 'guest' | 'access_request'
  resourceId   String?  @map("resource_id")
  metadata     Json?                                  // extra context (guest email, folder name, permission level, outcome)
  ipAddress    String?  @map("ip_address")
  createdAt    DateTime @default(now()) @map("created_at")

  @@index([ownerId, createdAt(sort: Desc)])            // the primary query: an owner's trail, newest first
  @@index([actorId, createdAt(sort: Desc)])            // roadmap §6 idx_audit_actor
  @@map("audit_log")
}
```

**Deviation from roadmap § 6, flagged (AP3):** the roadmap's `audit_log` has `actor_type` + `actor_id` but **no `owner_id`**. The `GET /api/audit` contract is "owner's full activity log" (§ 11) — an owner must see entries where *they* are the actor (approve/deny/revoke) AND entries where *their guest* is the actor (a guest viewing/downloading the owner's photo). Deriving the second set from `actor_id` alone requires a join back through `guest_users.created_by` on every audit read. Adding a denormalized `owner_id` on each row (the owner whose trail this belongs to) makes the query a single indexed scan and makes owner-scoping trivial and leak-proof. Recommended: add `owner_id`. Veto if the trail must match roadmap § 6 verbatim (then the read does the join).

No relation fields are added to `User`/`GuestUser`/`Photo`/`Folder` — `actorId`/`resourceId`/`ownerId` are stored as plain string IDs, not FK relations, deliberately: an audit entry must survive the deletion of the resource it describes (e.g. a revoked guest or deleted folder) — a hard FK with `onDelete: Cascade` would erase history, defeating the purpose of an immutable log. Store IDs as strings, resolve names best-effort at read time (or capture the human label into `metadata` at write time — see A2). This keeps the migration purely additive (one `CREATE TABLE` + two `CREATE INDEX`, zero `ALTER` on existing tables).

#### A2. What gets logged (the enumerated action set)

Scoped to the **sharing / access-control surface** — the roadmap's actual differentiator ("who viewed/downloaded", plus the governance trail). Each action, its choke point (all already exist), the actor, and what goes in `metadata`:

| `action` | Choke point (existing) | actorType / actorId | resourceType / resourceId | metadata captured at write time |
|---|---|---|---|---|
| `share_created` | `POST /api/guests` (`routes/guests.ts`) | owner / ownerId | `guest` / guestUserId | `{ guestEmail, folderIds, folderNames, permissionLevel, expiresAt }` |
| `access_requested` | `POST /api/invites/:token/request` (`routes/invites.ts`, on fresh-request path only) | guest / guestUserId | `access_request` / requestId | `{ guestEmail, ipCaptured, userAgent }` |
| `access_approved` | `POST /api/access-requests/:id/approve` (`routes/accessRequests.ts`, on match) | owner / ownerId | `access_request` / requestId | `{ guestEmail }` |
| `access_denied` | same handler (explicit deny) + auto-deny (3 wrong OTP) path | owner / ownerId | `access_request` / requestId | `{ guestEmail, reason: 'owner_denied' \| 'otp_attempts_exceeded' \| 'otp_expired' }` |
| `guest_revoked` | `DELETE /api/guests/:id` (`routes/guests.ts`) | owner / ownerId | `guest` / guestUserId | `{ guestEmail }` |
| `photo_viewed` | `GET /api/guest/photos/:id` (`routes/guest.ts`) | guest / guestUserId | `photo` / photoId | `{ folderId }` (see AP4 — this is the high-volume one) |
| `photo_downloaded` | `GET /api/guest/photos/:id/download` (`routes/guest.ts`, only on the success/200 path — a 403 view-only refusal is NOT a download) | guest / guestUserId | `photo` / photoId | `{ folderId }` |

Notes:
- `ownerId` on every row is resolved from the choke point's existing context — owner handlers already have `req.user!.id`; guest handlers already resolve the guest and can look up `guestUser.createdBy` (already loaded in several handlers, one cheap lookup otherwise).
- **`access_denied` is one action with a `reason`**, not three actions — the auto-deny (3-wrong-OTP) and expiry paths in `accessRequests.ts` (which already exist and return 403) both log with the appropriate `reason`.
- **Owner-side content actions are excluded this pass** (AP1). No `login`, `upload`, `photo_moved`, `reclassified`, `folder_created` entries. Reasoning: the roadmap's audit differentiator is the *access* trail; owner-on-own-data actions are low-value in a single-owner MVP and add write volume. Recommended default; vetoable.

#### A3. The write helper — fire-and-forget, correctness-safe (`backend/src/lib/audit.ts`)

A single module, the only thing that writes to `audit_log`:

```
logAudit({ actorType, actorId, ownerId, action, resourceType?, resourceId?, metadata?, ipAddress? }): void
```

- **Synchronous inline vs. async decision (AP5):** logging is **fire-and-forget in-process**, NOT via BullMQ. The insert is a single fast indexed write; a queue would add Redis dependency + latency + failure modes for no benefit (the same "async only if genuinely slow" rule the guest-access spec applied to OTP). `logAudit` kicks off the insert and returns immediately; the primary handler does not `await` it.
- **A failed audit write must never break the primary action (constraint 4).** `logAudit` wraps its own insert in a `.catch()` that logs the failure to the server logger and swallows it. It is called *after* the primary operation's transaction commits (or, for guest reads, after the pre-signed URL is generated and the response is being sent), never inside the primary `$transaction`. An audit insert throwing (DB blip, constraint) can therefore never roll back an approval/revoke/download.
- **Ordering caveat for guest reads:** for `photo_viewed`/`photo_downloaded`, call `logAudit` right before `res.json(...)` on the success path only — a 401 (no session) or 404 (not permitted) or 403 (view-only) must NOT produce an audit row (those are not successful accesses). This keeps the log to *actual* views/downloads.
- Header comment states the fire-and-forget + never-break-primary contract explicitly, same discipline as the classifier/notification mock headers.

#### A4. `GET /api/audit` — owner activity log (`backend/src/routes/audit.ts`, mounted `/api/audit`)

| Method + path | Auth | Query | Behavior | Errors |
|---|---|---|---|---|
| `GET /api/audit` | owner (`requireAuth`) | `?limit` (1–100, default 50), `?offset` (default 0), `?action` (optional, one of the enum in A2), `?actorType` (optional, `owner`\|`guest`), `?from` (optional ISO date), `?to` (optional ISO date) | Return this owner's audit trail: all rows where `ownerId === req.user!.id`, newest first, filtered by the optional params, paginated. Each row: `{ id, actorType, actor: { id, email? }, action, resourceType, resourceId, metadata, ipAddress, createdAt }`. Best-effort resolve the actor's human label (owner name / guest email) — from `metadata` where captured, else a lookup, else just the id. Return `{ entries, total, limit, offset }`. | 400 invalid query (Zod); 401 no session |

- **Owner-scoped, leak-proof:** the `where` is always `ownerId: req.user!.id` — an owner can never page into another owner's trail. There is no `GET /api/audit/:id` and no cross-owner filter. (No 404-not-403 case arises because there is no per-id lookup — the list is inherently scoped.)
- **Filtering scope (AP6):** action-type filter + actorType filter + date-range (`from`/`to`) are IN scope (cheap, indexed, and the obvious owner questions: "show me all downloads", "what happened last week"). Filtering **by specific guest** is DEFERRED (recommended) — it needs a guest picker on the eventual UI and is a thin add later (`?guestId=` filtering on `actorId` where `actorType='guest'`). Vetoable.
- Validation via a new `auditQuerySchema` in `lib/validation.ts`, same pattern as `folderPhotosQuerySchema`/`accessRequestsQuerySchema`.

#### A5. Wiring (`backend/src/app.ts`)

Mount one new router: `app.use("/api/audit", auditRouter)`. No route-order hazard (single top-level GET). Add the audit hooks into the five existing choke-point handlers (guests.ts ×2, accessRequests.ts ×2 incl. both deny paths, invites.ts ×1, guest.ts ×2) as post-commit `logAudit(...)` calls.

### Part B — Polish checklist (bounded; each item marked IN / DEFERRED)

Recommendation per item. **IN** = build this pass. **DEFERRED** = recommend leaving out, flagged so Abhishek can pull it in.

| # | Item | Origin | Recommendation | Reasoning |
|---|---|---|---|---|
| P1 | **Helmet.js security headers** | Roadmap Week 11 ("Security headers") | **IN** | Small, dependency-is-in-the-roadmap, real hardening, zero UI. Add `helmet()` to `app.ts` with a config compatible with the local frontend (CSP relaxed enough for Next dev, or CSP off in dev / on in prod). Backend-only, Tester-verifiable via response headers. |
| P2 | **Rate-limiter coverage audit** | Roadmap Week 11 ("Rate limiting on all APIs") | **IN (audit only, add where trivially missing)** | Most surfaces already have buckets (auth split, upload, reclassify, invite request/status — all tested). This is a *review* pass: enumerate every mutating/public endpoint, confirm it has a limiter or a documented reason it doesn't (e.g. session-gated read endpoints). Add a limiter only where one is trivially missing on an abuse-prone surface. Do NOT re-tune existing tested numbers. Backend-only. |
| P3 | **Empty / error / loading states audit across the 4 owner pages + guest portal** | Roadmap Week 11 ("Error handling, loading states, empty states throughout UI") | **IN (bounded)** | Prior cycles already hardened several (the `/organize` and Dashboard fresh-user empty states were bug-fixed; the guest portal has denied/expired/spent-invite states). This is a *bounded sweep*: confirm each page (`/dashboard`, `/organize`, `/browse`, `/upload`, `/share`, `/guests`, `/g/[token]`) has (a) a loading indicator on initial fetch, (b) a non-crashing empty state, (c) a visible error state on a failed fetch/action. Fix only genuine gaps found; do not restyle. This is elaboration of existing surfaces (no new information architecture), so it does NOT need a wireframe round. |
| P4 | **Folder rename / merge / delete** | Deferred from Week 5–6 (Pending Decision #8); roadmap § 3 "Folder Management — auto-create, rename, merge, delete" + § 11 `PATCH /api/folders/:id`, `DELETE /api/folders/:id` | **DEFERRED (recommended)** | Real feature work, not "polish" — it needs its own spec: rename collision rules, what "merge" does to `photoCount` and to any `folder_permissions` pointing at the merged-away folder (a guest could be sharing a folder that gets merged/deleted — real correctness surface), and a UI round for the merge/delete affordance. Too big to bundle into a polish pass without under-scoping it. Recommend a separate Week 5–6-closeout spec. Flag AP7. |
| P5 | **Bulk `download_all` (folder zip) endpoint** | Deferred from Week 9–10 (decision G12); permission level already stored | **DEFERRED (recommended)** | Needs a streaming-zip implementation (archiver over pre-signed reads), a new guest + owner endpoint, and a decision on whether it runs inline or as a BullMQ job for large folders. Genuine feature, not polish. `download_all` is already stored and treated as ≥ `download`, so nothing regresses by deferring. Recommend its own small spec. Flag AP8. |
| P6 | **Basic search (by folder / date / filename)** | Roadmap Week 11 ("Basic search") | **DEFERRED (recommended)** | A new query surface (endpoint + UI) — feature work, not polish. Recommend its own spec after audit ships. Flag AP9. |
| P7 | **Owner activity dashboard (the audit VIEWING UI)** | Roadmap Week 11 ("Owner activity dashboard") | **DEFERRED to a wireframe round** (backend `GET /api/audit` is built this pass; the UI is queued separately) | See "UI that needs a wireframe round." The backend is the buildable core here; the UI is a genuine new surface needing propose→pick→build. |

**Recommended cut for this pass:** Part A (audit log, full) + P1 + P2 + P3. Everything else (P4–P7) recommended deferred to its own spec, each flagged below so Abhishek can pull any forward.

## Acceptance criteria

Verification legend (consistent with `specs/guest-access-otp.md`):
- **[Tester-live]** — black-box verifiable against the running stack (HTTP + DB inspection allowed).
- **[Developer-verified]** — verified via code review / unit test where live black-box exercise is impractical.

**Schema & migration (A1)**
- [ ] [Tester-live] The new migration creates `audit_log` with the columns in A1; replaying migrations on a fresh DB leaves `users`/`photos`/`collections`/`folders`/`sessions`/all guest-access tables unchanged (additive-only — one `CREATE TABLE` + indexes, zero destructive `ALTER`).
- [ ] [Developer-verified] `audit_log` has no FK constraint that would cascade-delete history when a guest/folder/photo is deleted (IDs stored as strings).

**Logging hooks (A2, A3)**
- [ ] [Tester-live] Creating a share (`POST /api/guests`) writes exactly one `share_created` row with `actorType='owner'`, correct `ownerId`, `resourceType='guest'`, and `metadata` containing the folder names + permission level.
- [ ] [Tester-live] An anonymous invite request writes one `access_requested` row (`actorType='guest'`) with the captured IP; approving writes `access_approved`; denying writes `access_denied` with `reason='owner_denied'`; three wrong OTPs writes `access_denied` with `reason='otp_attempts_exceeded'`.
- [ ] [Tester-live] A guest viewing a permitted photo (`GET /api/guest/photos/:id` → 200) writes one `photo_viewed` row; downloading (→ 200) writes one `photo_downloaded` row. A **view-only guest hitting `/download` → 403 writes NO `photo_downloaded` row**; a **404 (not-permitted) write NO row** on either endpoint.
- [ ] [Tester-live] Revoking a guest writes one `guest_revoked` row.
- [ ] [Developer-verified] `logAudit` is called *after* the primary transaction commits and is never `await`-ed inside it; a forced audit-insert failure (e.g. simulated DB error in the helper) does NOT roll back or fail the primary action (approval still succeeds, download still returns its pre-signed URL).

**`GET /api/audit` (A4)**
- [ ] [Tester-live] Returns this owner's trail newest-first, paginated (`limit`/`offset` honored, `total` correct), including both owner-actor rows (approve/revoke) and guest-actor rows (view/download) for this owner's guests.
- [ ] [Tester-live] **Owner-scoping is leak-proof:** owner B calling `GET /api/audit` never sees any row belonging to owner A's trail (verified by seeding activity under two owners and asserting zero cross-owner rows either direction).
- [ ] [Tester-live] `?action=photo_downloaded` returns only download rows; `?actorType=guest` returns only guest-actor rows; `?from`/`?to` bound the date range; an invalid `action`/date → 400 (Zod).
- [ ] [Tester-live] `GET /api/audit` with no session → 401.
- [ ] [Developer-verified] There is no `PATCH`/`DELETE /api/audit` and no `GET /api/audit/:id` — the log is append-only and list-only from the API.

**Polish (Part B, whatever is cut IN)**
- [ ] [Tester-live] (P1) Security headers present on API responses (e.g. `X-Content-Type-Options`, `X-Frame-Options`/frame-ancestors, etc. per the Helmet config); the local frontend still loads and functions (no CSP breakage of the Next app in the chosen dev/prod config).
- [ ] [Developer-verified] (P2) A written enumeration of every mutating/public endpoint and its limiter status; any newly-added limiter has its own bucket and is relaxed under `NODE_ENV=test`.
- [ ] [Tester-live] (P3) Each of the 7 pages shows a loading state on initial fetch, a non-crashing empty state, and a visible error state on a failed action — no fresh-user or failed-fetch crash on any page.

**Ground rules**
- [ ] [Developer-verified] No new dependency beyond `helmet` (P1); no real email/SMS/cloud/Stripe; no JWT; migration additive; audit surface returns zero image data / no pre-signed URLs.

## Success signal

Tester can run the full sharing flow end-to-end (owner creates a share → guest requests → owner approves → guest views + downloads a photo → owner revokes) and then, as the owner, call `GET /api/audit` and see the **complete ordered trail** of that flow: `share_created`, `access_requested` (with the guest's captured IP), `access_approved`, `photo_viewed`, `photo_downloaded`, `guest_revoked` — newest first, filterable to just the downloads, and containing **zero** rows from a second owner's parallel activity. DB inspection confirms each row has the right `actorType`/`ownerId`/`metadata` and that a view-only `/download` 403 and any 404 produced no row. A forced audit-write failure leaves the primary approval/download working. The 4 owner pages + 3 guest/share pages each survive a fresh-user / failed-fetch pass without crashing, and API responses carry the Helmet security headers with the frontend still fully functional.

## UI that needs a wireframe round

**Yes — one new surface (P7, "Owner activity dashboard").** `GET /api/audit` is the buildable backend core of this spec; the owner-facing view that renders the trail is a genuine new information surface (a filterable, paginated activity feed — action, actor, resource, time, IP/device) with real layout choices (dedicated `/activity` page vs. a tab on `/guests` vs. a section on `/dashboard`; how much of `metadata` to surface; how to render the mixed owner/guest actor rows). It should go through the standard **propose→pick→build** round (2–3 SVG options), NOT be built blind in this spec. **Queue it for Master after the backend ships** — the backend can be built and Tester-verified via HTTP without waiting on the UI decision, so this spec is not UI-blocked.

The Part B polish items (P1/P2 backend-only; P3 is elaboration of existing pages, no new IA) do **not** need a wireframe round.

## Pending Decisions (recommended defaults — confirm or veto; namespaced AP#)

Roadmap-specified values are used where they exist and marked as such; the rest are genuine ambiguities.

1. **AP1 — Which actions are audited this pass?** *Recommended default: the **sharing/access surface only*** — `share_created`, `access_requested`, `access_approved`, `access_denied`, `guest_revoked`, `photo_viewed`, `photo_downloaded` (A2). Owner-side content actions (login, upload, photo move/reclassify, folder create) are EXCLUDED — the roadmap's audit differentiator (§ 2) is the *access* trail, and owner-on-own-data actions are low-value in a single-owner MVP while adding write volume. Veto if you want owner content actions logged now.

2. **AP2 — Retention: keep forever vs. prune?** *Recommended default: **keep forever this pass*** — no scheduled purge. Volume in the local MVP is trivial, and immutability (roadmap § 12 Layer 6) argues against silent deletion. A prune/retention job is a later concern and a trivial BullMQ repeatable job when wanted (e.g. "prune > 1 year"). Veto if you want a retention window + purge job built now.

3. **AP3 — Add a denormalized `owner_id` to `audit_log` (deviates from roadmap § 6)?** *Recommended default: **yes, add `owner_id***. The `GET /api/audit` contract is per-owner and must include the owner's *guests'* actions; a denormalized `owner_id` makes the read a single indexed owner-scoped scan and makes leak-proofing trivial, at the cost of one extra column the roadmap schema omits. Veto if the table must match roadmap § 6 verbatim (then the read joins `actor_id`→`guest_users.created_by`).

4. **AP4 — Log guest `photo_viewed` (the high-volume event)?** *Recommended default: **yes, log it*** — "who **viewed**" is literally the roadmap § 2 differentiator, so omitting views guts the feature. Volume risk is real (a guest scrolling a gallery generates a view per opened photo), but `GET /api/guest/photos/:id` is a single-photo detail fetch (not a per-thumbnail grid load — the grid uses `/folders/:id/photos` which is NOT logged), so one row per photo actually opened is reasonable and bounded. Veto if you want to log downloads only (cheaper) and drop views, or to log a coarser "folder_viewed" instead.

5. **AP5 — Audit write: synchronous inline vs. fire-and-forget vs. BullMQ?** *Recommended default: **fire-and-forget in-process, never `await`-ed inside the primary transaction, errors caught-and-swallowed*** (A3) — a single fast indexed insert doesn't warrant a queue (same "async only if genuinely slow" rule as the guest-access OTP), and this guarantees a failed audit write can never roll back or fail the primary action (constraint 4). Veto if you want writes queued via BullMQ (durability/back-pressure at the cost of a Redis dependency on the write path).

6. **AP6 — `GET /api/audit` filtering scope this pass?** *Recommended default: **action-type + actorType + date-range (`from`/`to`) IN; filter-by-specific-guest DEFERRED*** (A4). The three included filters answer the obvious owner questions and are cheap/indexed; per-guest filtering needs a guest picker on the eventual UI and is a thin later add. Veto to include (or exclude) any of these.

7. **AP7 — Folder rename/merge/delete (P4): this pass or its own spec?** *Recommended default: **its own spec, DEFERRED*** — it's feature work with real correctness surface (merge/delete of a folder a guest is actively sharing → what happens to that `folder_permission`?) and a UI round, too big to bundle into polish. Veto to pull it into this pass.

8. **AP8 — Bulk `download_all` folder-zip endpoint (P5): this pass or its own spec?** *Recommended default: **its own spec, DEFERRED*** — needs a streaming-zip design and an inline-vs-BullMQ decision for large folders; nothing regresses by deferring (level already stored, treated as ≥ `download`). Veto to pull it forward.

9. **AP9 — Basic search (P6): this pass or its own spec?** *Recommended default: **its own spec, DEFERRED*** — a new query surface (endpoint + UI), feature work rather than polish. Veto to pull it forward.

10. **AP10 — Helmet CSP posture in local dev (P1).** A strict CSP can break the Next dev server (inline scripts / HMR). *Recommended default: **enable Helmet's safe defaults, but relax/disable CSP in `NODE_ENV=development` and enable a sensible CSP only for a prod build*** — since there's no prod deploy this pass, the practical effect is safe non-CSP headers locally with CSP wired-but-dev-relaxed. Veto if you want a strict CSP enforced locally now (accepting the dev-server tuning cost).
