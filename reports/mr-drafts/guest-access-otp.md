# MR Draft — Guest Access + OTP (backend/API/data-model core)

**Branch:** `feature/ai-classification` (local only — NOT pushed; needs Abhishek's separate go-ahead)
**Commit:** `dad0b74`
**Spec:** `specs/guest-access-otp.md` (Week 9–10)
**Scope:** backend + data model + tests ONLY. No UI (the 3 guest UIs are wireframe-blocked).

## Summary

An owner can share specific folders with a lightweight, account-less guest via an invite link. The guest opens the link and requests access; a 6-digit OTP (mock-delivered, no real email/SMS) goes to the OWNER for real-time approval; on approval the guest gets an opaque, revocable guest session scoped to exactly the shared folders, with every image served as a 60s pre-signed URL. The owner can revoke instantly.

Built strictly on decisions G1–G12 (all confirmed defaults). The two load-bearing ones — G3 (share unit = folder) and G7 (cookie-on-poll token handoff) — are implemented deliberately and localized.

## Files

**Schema + migration**
- `backend/prisma/schema.prisma` — 5 additive models (`GuestUser`, `InviteToken`, `FolderPermission`, `AccessRequest`, `GuestSession`) + back-relations `User.guestsInvited` / `Folder.permissions`. Geo columns omitted (G8), audit log deferred (G9).
- `backend/prisma/migrations/20260703215312_add_guest_access_otp/migration.sql` — **additive-only** (verified: only `CreateTable`/`CreateIndex`/`AddForeignKey`; no `ALTER`/`DROP`/`RENAME` on any existing table). Continues the history from `20260702090917_add_collections_folders_classification`.

**Libs**
- `backend/src/lib/guestSession.ts` — mirrors `lib/session.ts` one-to-one for guests. Distinct cookie `photosphere_guest_session`; raw `crypto.randomBytes(32).toString("hex")` to the client, SHA-256 to DB; `createGuestSession` / `createGuestSessionFromHash` / `getGuestSession` / `revokeGuestSessionsForGuest` / `guestSessionCookieOptions`. TTL from `GUEST_SESSION_TTL_HOURS` (default 24), capped at earliest live permission expiry (G2).
- `backend/src/lib/notifications/index.ts` — swappable mock OTP provider (mirrors `lib/classification/index.ts`). `NotificationProvider` interface + `MockNotificationProvider`. No real email/SMS/Twilio/SES/SendGrid/Resend/nodemailer, no JWT lib, no cloud creds. Plaintext OTP exposed only under `NOTIFICATIONS_EXPOSE_OTP === "true"` or `NODE_ENV === "test"`; never logged in plaintext. Header-documented as the one-file swap-in point.
- `backend/src/lib/otp.ts` — `generateOtp()` (6 digits via `crypto.randomInt(100000, 1000000)`), `hashOtp()` (SHA-256), `verifyOtp()` (constant-time compare via `crypto.timingSafeEqual`).
- `backend/src/lib/validation.ts` — added `createGuestSchema`, `accessRequestsQuerySchema`, `approveAccessRequestSchema`, `PERMISSION_LEVELS`.

**Middleware**
- `backend/src/middleware/requireGuest.ts` — mirrors `requireAuth`; attaches `req.guest`. Exports `getPermittedFolderIds(guestUserId)` — the **single scope choke point** (live = `revokedAt` null AND (`expiresAt` null OR future)) — and `getFolderPermissionLevel()` for the download gate. Every guest folder/photo query filters against this set; anything outside → 404.
- `backend/src/middleware/inviteRateLimiter.ts` — own IP-keyed buckets separate from auth/upload/reclassify (G11): request 10/15min, status-poll 120/15min, both relaxed under `NODE_ENV=test`.

**Routers** (all wired in `backend/src/app.ts`)
- `backend/src/routes/guests.ts` — `POST /api/guests` (create share; all-or-nothing 404 on any unowned folder; raw token returned once, hash stored), `GET /api/guests` (derived status), `DELETE /api/guests/:id` (one-tap revoke: invite deactivated, permissions revoked, sessions revoked, pending requests denied; idempotent).
- `backend/src/routes/accessRequests.ts` — `GET /api/access-requests?status=`, `POST /:id/approve` (OTP gate: 5-min TTL, single-use, 3 wrong → auto-deny, constant-time compare), `POST /:id/deny`. 404 (not 403) on cross-owner.
- `backend/src/routes/invites.ts` — public: `POST /api/invites/:token/request` (generic 404 on any invalid/expired/exhausted token; G10 re-click logic), `GET /api/invites/requests/:requestId/status` (G7 cookie handoff), plus a **test/dev-only** `GET /api/invites/requests/:requestId/otp` (gated on the exposure flag) so Tester reads the OTP without DB access. Route order per §7: literal `requests/*` before `:token/request`.
- `backend/src/routes/guest.ts` — scoped portal: `GET /folders`, `GET /folders/:id/photos`, `GET /photos/:id`, `GET /photos/:id/download`. All filtered through `getPermittedFolderIds`; 60s pre-signed URLs only (reuses `toPhotoCard` / `getPresignedGetUrl`); download gate 403 on view-only (G5).

**Tests**
- `backend/src/__tests__/guest-access.smoke.test.ts` — 12 integration tests (skip-not-fake infra/worker probe pattern from `dashboard.smoke.test.ts`).
- `backend/src/__tests__/notifications.offline.test.ts` — 3 offline tests (mirrors `classification.offline.test.ts`): all network entry points stubbed to throw while the mock "sends"; static dependency-graph checks that the module imports nothing network-capable, no real-delivery SDK, no JWT lib.

## Decisions implemented (G1–G12)

- **G1** OTP: 6 digits, SHA-256, 5-min TTL, single-use, 3 wrong → auto-deny (roadmap-fixed).
- **G2** Guest session `expires_at` added; capped at min(`GUEST_SESSION_TTL_HOURS`=24, earliest live permission expiry).
- **G3** (load-bearing) Share unit = folder; `invite_token.collection_id` stored as informational context only.
- **G4** Owner supplies `guestEmail` (label); raw `inviteUrl` returned to owner to share manually; OTP goes to owner.
- **G5** `view`-only download → 403 (existence legitimately known); 404 for folders/photos out of scope.
- **G6** Invite `max_uses = 1` (no owner override this pass).
- **G7** (load-bearing) Cookie-on-poll handoff — see below.
- **G8** Geo columns omitted; capture IP + user-agent (`device_info`) only.
- **G9** No audit table/endpoint; approve/deny/revoke are single choke-point handlers for a later non-refactor add.
- **G10** Re-click: live session → `already_approved`; unexpired pending → reuse same request; otherwise fresh OTP.
- **G11** Own IP buckets: request 10/15min, poll 120/15min, relaxed in test.
- **G12** All three permission levels stored; `view` vs `download` enforced on download; `download_all` treated as ≥ `download`; no bulk-zip endpoint.

## G7 handoff — how it's actually built (and one deviation from the spec, flagged)

The spec (§4/§7, Open Decision #7b) says: "mint the guest session at approval time, store its hash keyed to the access_request, have the guest's status call claim it (set-cookie) exactly once." **I implemented a functionally-equivalent variant and want it flagged, not buried:**

- The **approve** handler only flips the request to `approved` + invalidates the OTP + increments `use_count`. It does **not** mint the session and returns no raw token to the owner.
- The **status-poll** handler, on the first poll that observes `approved` with the session not yet claimed, mints the session there: generates a fresh opaque token, sets the httpOnly guest cookie on the polling (guest's) browser, stores only the SHA-256 hash in `guest_sessions`, and atomically latches a new `AccessRequest.session_claimed_at` timestamp (claim-once — a concurrent double-poll can't mint two sessions).

**Why the variant:** the spec's literal "mint at approval, stash the token's hash" runs into the fact that a raw token is not recoverable from its hash — so setting the guest's cookie later would require persisting the *raw* token somewhere, which violates the "raw guest token never persisted" rule. Minting at claim time keeps the raw token existing only for the duration of the response that sets the cookie, and nothing but its hash is ever stored. Net behavior is identical to the spec's intent (raw token never touches the owner or any copy-paste path; single-use; durable across restarts). The only schema difference from a literal reading is a `session_claimed_at` latch column instead of a `pending_session_token_hash` column. **Contained to `routes/invites.ts` + one nullable column**, so a later change to the handoff is localized as the spec asked.

## Test coverage (security-critical AC)

Full backend suite: **71/71** (was 56/56; +12 guest smoke, +3 notification offline), run twice back-to-back with zero flake. Covered:

- OTP wrong-attempt cap → auto-deny at the 3rd (DB-verified `otp_attempts`/`status`), correct code rejected after auto-deny.
- OTP single-use (replay of the same code post-approval → 401/409).
- OTP 5-min expiry rejection (even a correct code → 403, status → `expired`).
- Cross-scope leakage: guest 404s on a folder the owner owns but did NOT share, and on a completely different owner's photo; `GET /api/guest/folders` returns only the shared folder.
- Pre-signed URLs: guest photo/thumbnail/download URLs are signed MinIO URLs (`X-Amz-*`), never raw keys.
- Revocation cuts a live session off immediately (next `/api/guest/*` → 401); permissions revoked, invite deactivated, sessions revoked; re-request with the dead token → 404.
- 404-not-403 on cross-owner approve/deny and on cross-owner `DELETE /api/guests/:id` (with no side effect).
- Guest endpoints 401 with no/invalid guest session.
- Share creation: 201 with raw token (hash-only in DB, `max_uses=1`), 404 + zero rows on any unowned folder, 400 on invalid body.
- Offline notification test proving no code path reaches the network + no real-delivery/JWT import.

## Verification

- `npm run typecheck -w backend` — clean (incl. tests).
- `npm run lint -w backend` — clean.
- Migration `20260703215312_add_guest_access_otp` applied cleanly (created via `prisma migrate dev`; also survived a `migrate reset` replay from scratch during development).
- Full backend suite 71/71 green, twice.
- No UI built. No real email/SMS/cloud/JWT dependency added (verified statically by the offline test).

## Deviations from spec (flagged, not buried)

1. **G7 handoff variant** — session minted at *claim* (status-poll) instead of at *approval*, using a `session_claimed_at` latch column instead of `pending_session_token_hash`. Rationale + equivalence above. Behavior matches the spec's intent exactly.
2. **Test/dev-only `GET /api/invites/requests/:requestId/otp`** — not in the spec's endpoint tables, but the spec's success signal explicitly requires Tester to "read the OTP from the mock provider's test-exposed value." This route surfaces `getExposedOtp()` over HTTP, gated on the same test/exposure flag (returns 404 in dev/prod). Additive, no real-user surface.
3. **`.env`** — added `GUEST_SESSION_TTL_HOURS` (24) and `NOTIFICATIONS_EXPOSE_OTP` (false) with documenting comments. `.env` is gitignored (not committed); noting so the values are set on any fresh checkout.

## Not built (correctly out of scope)

3 guest UIs (owner Share panel, owner approval/guest-management view, guest portal) — wireframe-blocked (U1–U3), queued for standard propose→pick→build rounds. Real email/SMS, cloud export, bulk-zip download, audit log, geo enrichment — all deferred per spec Non-goals.
