# MR Draft — Audit Log + Phase-1-Close Polish (Week 11–12)

**Branch:** `feature/ai-classification` (local only — no remote yet, do not push)
**Spec:** `specs/audit-and-polish.md` (Part A + Part B P1/P2/P3, on the AP1–AP10 recommended defaults)
**Commits:**
- `7fd5c15` — **Part A (audit-log backend) + P1 (Helmet)**. Already committed and Tester-adjacent (backend suite 85/85, verified).
- `b8c0ad1` — **P2 (rate-limiter coverage audit) + P3 (empty/error/loading-state sweep) + this MR draft.** Both P2 and P3 resolved to **zero code changes** (see below); the enumeration table and per-page sweep findings are the deliverable, plus this draft.

Author: Abhishek. No `Co-Authored-By: Claude` trailer (standing rule).

---

## Title
feat: Week 11–12 audit log + Phase-1-close polish (Helmet, rate-limiter audit, empty/error/loading sweep)

## Summary

Closes out the Week 11–12 roadmap line for the local-first MVP slice:

- **Part A — Audit log (the roadmap's "who viewed/downloaded" differentiator):** a new append-only `audit_log` table, a single fire-and-forget `logAudit` write helper, `logAudit` hooks at the 7 existing sharing/access choke points, and an owner-scoped, paginated, filterable, leak-proof `GET /api/audit`.
- **P1 — Helmet security headers** on all API responses, with CSP relaxed under `NODE_ENV=development` per AP10.
- **P2 — Rate-limiter coverage audit:** a written enumeration of every mutating/public endpoint and its limiter status. **Outcome: nothing abuse-prone is missing a limiter — zero code change.**
- **P3 — Empty/error/loading-state sweep across all 7 pages:** each page confirmed to have a loading indicator on initial fetch, a non-crashing empty state, and a visible error state. **Outcome: all 7 pages already covered — zero code change.**

Everything else in `specs/audit-and-polish.md` (P4 folder rename/merge/delete, P5 bulk download-all, P6 basic search, P7 the audit-viewer UI) is deferred to its own spec/wireframe round per the spec's recommended defaults (AP7–AP9 + the P7 UI queue).

---

## Part A — Audit log (commit `7fd5c15`, already committed)

### Files touched (Part A + P1)
- `backend/prisma/schema.prisma` — new `AuditLog` model (additive; no existing model touched).
- `backend/prisma/migrations/20260705154110_add_audit_log/migration.sql` — additive migration: one `CREATE TABLE audit_log` + two indexes (`[ownerId, createdAt desc]`, `[actorId, createdAt desc]`). Zero `ALTER`/`DROP` on existing tables.
- `backend/src/lib/audit.ts` — the fire-and-forget `logAudit` write helper (the only writer of `audit_log`).
- `backend/src/lib/validation.ts` — new `auditQuerySchema` (limit/offset/action/actorType/from/to).
- `backend/src/routes/audit.ts` — `GET /api/audit`, owner-scoped list-only.
- `backend/src/app.ts` — mounts `/api/audit`; also adds `helmet()` (P1).
- `backend/src/routes/guests.ts`, `accessRequests.ts`, `invites.ts`, `guest.ts` — additive `logAudit(...)` calls at the choke points (no logic change to the primary handlers).
- `backend/src/__tests__/audit.smoke.test.ts` — new suite (drives the schema, the 7 hooks, owner-scoping, filters, 401, and the fire-and-forget contract).
- `backend/package.json` + `package-lock.json` — `helmet` dependency (the only new dep, allowed by the spec).

### Design decisions (on the AP defaults)
- **AP1 — audited action set:** sharing/access surface only (`share_created`, `access_requested`, `access_approved`, `access_denied`, `guest_revoked`, `photo_viewed`, `photo_downloaded`). Owner content actions (login/upload/move/reclassify/folder-create) excluded.
- **AP3 — denormalized `owner_id`** on every row (deviates from roadmap §6, which has only `actor_type`/`actor_id`) so the per-owner read is a single indexed scan and leak-proofing is trivial. Flagged deviation, taken on the recommended default.
- **AP4 — `photo_viewed` IS logged** (it's the literal §2 differentiator); bounded because `GET /api/guest/photos/:id` is a per-opened-photo detail fetch, not a per-thumbnail grid load.
- **AP5 — fire-and-forget in-process** (not BullMQ): `logAudit` is never `await`-ed inside the primary transaction and wraps its insert in a `.catch()` that logs-and-swallows, so a failed audit write can never roll back or fail the primary action.
- **No FK relations** on `actorId`/`resourceId`/`ownerId` (plain string IDs) so an audit entry survives deletion of the resource it describes (revoked guest, deleted folder) — immutable history.
- **AP6 — filters:** action-type + actorType + date-range IN; filter-by-specific-guest deferred.
- **Append-only / list-only:** no `PATCH`/`DELETE /api/audit`, no `GET /api/audit/:id`.

### Success signal (Part A)
Owner runs the full flow (share → guest requests → approve → view + download → revoke) then `GET /api/audit` returns the complete ordered trail newest-first, filterable to just downloads, with zero rows from a second owner's parallel activity. Backend suite 85/85 (was 71/71; +14 audit tests) confirms this end-to-end.

---

## P1 — Helmet security headers (commit `7fd5c15`, already committed)

`app.ts` now applies `helmet()` before CORS. Config:

```
helmet({
  contentSecurityPolicy: isDev ? false : { directives: { ...defaults, img-src, connect-src } },
  crossOriginResourcePolicy: { policy: "cross-origin" },
})
```

- **CSP posture (AP10):** disabled under `NODE_ENV=development` (a strict CSP breaks Next's dev server — inline bootstrap scripts + HMR — and would block the cross-origin API/image loads). A sensible CSP is wired for prod (`img-src` allows `data:`/`https:`/`blob:` for pre-signed MinIO/S3 URLs; `connect-src` allows the frontend origin) so it's ready when a real deploy happens. Since there's no prod deploy this pass, the practical local effect is: safe non-CSP headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`/`frame-ancestors`, `Referrer-Policy`, HSTS, no `X-Powered-By`) with the frontend fully functional.
- **`crossOriginResourcePolicy: cross-origin`** so the separate-origin frontend can consume this API's responses (Helmet's default `same-origin` would block it).

Tester-verifiable via response headers; the frontend still loads and functions in the dev config.

---

## P2 — Rate-limiter coverage audit (this follow-up commit — ZERO code change)

Per AP6/the P2 spec row: enumerate every mutating or public/unauthenticated endpoint and record its limiter status, or a documented reason it needs none. **Add a limiter only where one is trivially missing on a genuinely abuse-prone (unauthenticated or expensive) surface.**

### Existing rate-limit buckets (all relaxed under `NODE_ENV=test`)
| Bucket | Where | Production limit | Keyed by |
|---|---|---|---|
| `signupRateLimiter` | `POST /api/auth/signup` | 5 / 15 min | IP |
| `loginRateLimiter` | `POST /api/auth/login` | 10 / 15 min | IP |
| `uploadRateLimiter` | `POST /api/photos/upload` | (upload bucket) | user |
| `reclassifyRateLimiter` | `POST /api/photos/:id/reclassify` | 30 / 15 min | user |
| `inviteRequestRateLimiter` | `POST /api/invites/:token/request` | 10 / 15 min | IP |
| `inviteStatusRateLimiter` | `GET /api/invites/requests/:requestId/status` (+ dev-only `/otp`) | 120 / 15 min | IP |

### Full endpoint → limiter enumeration

| Method + path | Auth gate | Mutating? | Public? | Rate limiter | Verdict |
|---|---|---|---|---|---|
| `POST /api/auth/signup` | none | yes | **yes** | `signupRateLimiter` (5/15m/IP) | Covered ✓ |
| `POST /api/auth/login` | none | yes (session mint) | **yes** | `loginRateLimiter` (10/15m/IP) | Covered ✓ |
| `POST /api/auth/logout` | none | yes (clears own cookie) | yes | none | **No limiter needed** — clears the caller's own session cookie; no cross-user effect, no expensive work, no enumeration signal. Trivially non-abuse-prone. |
| `GET /api/auth/me` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `POST /api/photos/upload` | `requireAuth` | yes | no | `uploadRateLimiter` | Covered ✓ (expensive: sniff/hash/queue). |
| `GET /api/photos/unfiled` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `GET /api/photos/:id` | `requireAuth` | no | no | none | Session-gated read (owner-scoped, 404-not-403). No limiter needed. |
| `GET /api/photos/:id/status` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `PATCH /api/photos/:id` | `requireAuth` | yes (move) | no | none | **Session-gated mutation, cheap** (a single owner-scoped folder reassignment, Serializable-isolated). Abuse ceiling is self-inflicted on the owner's own data; no cross-user/expensive surface. No limiter added — documented as acceptable. |
| `POST /api/photos/:id/reclassify` | `requireAuth` | yes (enqueues a job) | no | `reclassifyRateLimiter` (30/15m/user) | Covered ✓ (the expensive session-gated mutation — enqueues worker jobs — already has its own bucket). |
| `GET /api/collections` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `GET /api/collections/:id/folders` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `POST /api/collections/:id/folders` | `requireAuth` | yes (create folder) | no | none | **Session-gated mutation, cheap** (one owner-scoped `INSERT` with a unique-name guard). Same reasoning as `PATCH /api/photos/:id`. No limiter added — documented. |
| `GET /api/collections/:id/unfiled-photos` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `GET /api/folders/:id/photos` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `GET /api/dashboard` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `POST /api/guests` | `requireAuth` | yes (share + invite) | no | none | **Session-gated mutation, cheap** (creates a guest + invite for the owner's own resources). Owner-authenticated; no public/expensive surface. No limiter added — documented. |
| `GET /api/guests` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `DELETE /api/guests/:id` | `requireAuth` | yes (revoke) | no | none | **Session-gated mutation, cheap** (owner revokes their own guest, 404-not-403 cross-owner). No limiter added — documented. |
| `GET /api/access-requests` | `requireAuth` | no | no | none | Session-gated read. No limiter needed. |
| `POST /api/access-requests/:id/approve` | `requireAuth` | yes (OTP verify + mint) | no | none | **Session-gated, but the OTP wrong-attempt cap (3 → auto-deny) is the security control here, enforced on the `access_request` row itself** (independent of any IP limiter). Owner-authenticated, owner-scoped (404-not-403). The brute-force surface (OTP guessing) is bounded by the 3-attempt lock, not by a rate limiter. No limiter added — documented; the attempt cap is the correct control. |
| `POST /api/access-requests/:id/deny` | `requireAuth` | yes | no | none | Session-gated owner mutation on own resource. No limiter needed. |
| `GET /api/invites/requests/:requestId/status` | none | no | **yes** | `inviteStatusRateLimiter` (120/15m/IP) | Covered ✓ (public poll surface). |
| `GET /api/invites/requests/:requestId/otp` | none (dev/test-gated) | no | dev/test only | `inviteStatusRateLimiter` | Covered ✓; additionally 404s unless `NOTIFICATIONS_EXPOSE_OTP=true` or `NODE_ENV=test`. Never wired for real users. |
| `POST /api/invites/:token/request` | none | yes (request + OTP send) | **yes** | `inviteRequestRateLimiter` (10/15m/IP) | Covered ✓ (the highest-abuse public surface — could spam owners / enumerate tokens). |
| `GET /api/guest/folders` | `requireGuest` | no | no (guest-session-gated) | none | Guest-session-gated read (requires a valid opaque guest token from an already-approved session). No limiter needed. |
| `GET /api/guest/folders/:id/photos` | `requireGuest` | no | no | none | Guest-session-gated read. No limiter needed. |
| `GET /api/guest/photos/:id` | `requireGuest` | no | no | none | Guest-session-gated read (pre-signed URL, 60s TTL). No limiter needed. |
| `GET /api/guest/photos/:id/download` | `requireGuest` | no | no | none | Guest-session-gated read (permission-scoped, view-only → 403). No limiter needed. |
| `GET /api/audit` (NEW this Week 11–12) | `requireAuth` | no | no | none | **Session-gated, owner-scoped read** (always `where ownerId = req.user.id`; no per-id lookup, no cross-owner filter, returns zero image data). A limiter would only throttle an owner reading their own log — no cross-user, unauthenticated, or expensive surface. **No limiter needed; documented as fine without one.** |

### P2 conclusion
**Every unauthenticated/public surface is rate-limited** (signup, login, invite request, invite status, dev-only OTP reader). **Every expensive session-gated surface is rate-limited** (upload, reclassify). Everything else is a session-gated read or a cheap owner-scoped mutation on the owner's own resources; the one brute-force-sensitive session-gated surface (OTP approve) is protected by a per-request 3-attempt lock rather than an IP limiter, which is the correct control. `GET /api/audit` is a session-gated owner-scoped read and is fine without a limiter.

**No limiter was trivially missing on any genuinely abuse-prone (unauthenticated or expensive) surface. Zero code change for P2.** No existing tested numbers were re-tuned.

---

## P3 — Empty / error / loading-state sweep across all 7 pages (this follow-up commit — ZERO code change)

Bounded sweep per the P3 spec row: confirm each page has (a) a loading indicator on initial fetch, (b) a non-crashing empty state, (c) a visible error state on a failed fetch/action. **Fix only genuine gaps; do not restyle or redesign working pages.**

| Page | Loading indicator | Empty state | Error state | Verdict |
|---|---|---|---|---|
| `/dashboard` | "Loading dashboard…" | "No photos yet — upload one to get started." | inline `{error}` on failed `GET /api/dashboard` | **Already fine.** (Fresh-user empty state was bug-fixed in a prior cycle.) |
| `/organize` | `foldersLoading` + `gridLoading` indicators | folder-tree empty + "No photos in this folder" + Unfiled bucket | `foldersError` + `gridError` + per-card `actionError` | **Already fine.** (Fresh-user "photo unreachable before any collection" crash was bug-fixed in a prior cycle; re-verified clean since.) |
| `/browse` | "Loading folders…" + "Loading photos…" | "No photos yet…" + "Select a folder to view its photos." + "No photos in this folder." | `foldersError` + `gridError` | **Already fine.** |
| `/upload` | "Uploading…" button state + `<progress>` bar | n/a — it's a form, no list to be empty (self-labeled "minimal round-trip proof / test page", Week 1–2 auth-proof placeholder) | red `{error}` on failed upload/poll | **Already fine for its purpose.** Deliberately left untouched per the bounded-sweep rule (no restyle of a working test page; loading + error present, empty-state concept doesn't apply to a single-file form). |
| `/share` | "Loading folders…" | folder list drives the multi-select (empty folders → nothing to select, no crash) | `foldersError` + `submitError` on failed share creation | **Already fine.** |
| `/guests` | "Loading…" | "No guests yet — create a share to invite one." | `loadError` + per-request-card action error + per-guest revoke error | **Already fine.** (Wrong-OTP-ejects-owner + spent-invite bugs were fixed and Tester-verified in a prior cycle.) |
| `/g/[token]` | `'probing'` state → decorative locked grid; "Loading your shared folders…"; "Loading photos…" | "No folders are currently shared with you." + "No photos in this folder." | `landingError`, `denied`/`expired` outcome messages, spent-invite 404 message, `foldersError`, `photosError`, `viewerError`, download error | **Already fine.** (denied/expired/spent-invite states were hardened in prior cycles; privacy constraint intact.) |

### P3 conclusion
**All 7 pages already cover loading + empty + error for their purpose. No genuine gap found. Zero code change for P3.** No page was restyled, redesigned, or refactored. The `/upload` page is a deliberate minimal test page and has no list, so an "empty state" doesn't apply — it has loading (progress) and error states, which is complete for a single-file form; left untouched per the bounded-sweep instruction rather than manufacturing a change.

---

## Testing notes

- `npm run typecheck -w backend` — clean.
- `npm run lint -w backend` — clean.
- `npm test -w backend` — **85/85 passing** (Docker Compose stack up: Postgres/Redis/MinIO). The lone "Unique constraint failed on the fields: (collection_id, name)" log line is the expected P2002 catch-and-refetch during concurrent folder auto-creation, not a test failure (documented across prior reports).
- **Frontend NOT touched** (P2 and P3 both resolved to zero code change), so no `next build`/typecheck/lint delta and no `.next` corruption risk.

## Deviations from spec (flagged, not buried)

1. **AP3 — denormalized `owner_id` on `audit_log`** (Part A): deviates from roadmap §6, which has only `actor_type`/`actor_id`. Taken on the spec's recommended default; makes the owner-scoped read a single indexed scan and leak-proofing trivial. Vetoable.
2. **P2 and P3 each produced zero code change.** This is the spec's explicitly-anticipated "most likely outcome" for P2 (audit-only unless trivially missing) and the honest result for P3 (prior cycles already hardened these surfaces). The enumeration table + per-page findings above are the P2/P3 deliverable. No changes were manufactured to look busy.
3. **`/upload` empty state:** the page is a deliberate minimal test/dev placeholder with no list, so "empty state" doesn't apply. Recorded as "fine for its purpose" rather than adding an artificial empty state or restyling it (out of the bounded-sweep scope).

## Deferred (per spec, NOT built this pass)
- **P4** folder rename/merge/delete — own spec (AP7).
- **P5** bulk `download_all` folder-zip — own spec (AP8).
- **P6** basic search — own spec (AP9).
- **P7** the owner audit-viewer UI — queued for a propose→pick→build wireframe round (the `GET /api/audit` backend is built and Tester-verifiable via HTTP without it).
