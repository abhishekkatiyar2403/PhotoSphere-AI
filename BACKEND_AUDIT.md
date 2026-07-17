# PhotoSphere AI — Full Backend Audit

**Date:** 2026-07-13
**Scope:** Entire backend (`backend/src/**`), compared against the two spec-of-record docs (`PhotoSphere_AI_Project_Instruction.md`, `PhotoSphere_AI_Master_Roadmap.md`) and general production-readiness practice. Produced by two parallel deep-scan passes — one comparing implemented routes against every roadmap/spec promise, one auditing security/reliability/data-lifecycle/platform/API hygiene.

This file is the durable record. `dashboard/suggestions.json` carries the subset of these that are product features (for the Planner/Developer queue); the operational/security items below are meant to be worked directly, not queued as product features.

---

## What's already solid (no action needed)

Auth with opaque sessions (bcrypt-12, 7-day TTL), the full upload → thumbnail → EXIF → pHash dedup → async classify pipeline (now with tuned dominance-scoring, face grouping via `PersonFace`, detection caching, and metadata-based screenshot detection), collections/folders (create/rename/merge/delete/restore/zip-download), photo move/bulk-move/reclassify/delete/bulk-delete/restore/download-many, trash with a daily auto-purge job, the complete guest/OTP sharing system (invite → OTP → scoped session → view/download/download_all → revoke, with link-forwarding detection), an 18-action audit log, search (filename/date/folder/category), and dashboard stats. The frontend (`frontend/src/lib/api.ts`) calls no endpoint that doesn't exist. Weeks 1–11 of the roadmap are genuinely covered, and several Phase 2 items (face recognition) are already partially built ahead of schedule.

---

## 🔴 Critical — would break real users immediately in production

### 1. HEIC decoding is broken on Linux (production), not just for Live Photos
- **Where:** `backend/src/worker.ts` — `decodeHeicViaSips` (~line 70) and the EXIF sips fallback (~line 559) are both gated on `process.platform === "darwin"`. Prebuilt `sharp` binaries have no HEVC/HEIC decode support at all (patent licensing), and `exifr` has zero HEIC container parsing (confirmed earlier this session).
- **Impact:** On Railway (Linux), **every** iPhone HEIC photo — not just Live Photos — gets no thumbnail, no EXIF date/GPS, and lands in Uncategorized. This is effectively "photos from iPhones don't work" in production.
- **Fix:**
  1. Short-term/cheapest: add a Linux-compatible HEIC decode path — either (a) build/install a Linux `libheif` package with HEIC support (e.g. `libheif-dev` + a `heif-convert` CLI shelled out to, mirroring the `sips` pattern) inside the Railway container via a custom Dockerfile/buildpack, or (b) use an npm package with a bundled HEIC-capable libheif (e.g. `heic-convert`/`libheif-js` — verify license and real-world reliability first).
  2. Alternative (no server-side dependency risk): convert HEIC → JPEG **client-side** at upload time in the browser (many browsers/JS libraries can do this, e.g. `heic2any`), so the server never receives a HEIC file at all. Changes the upload contract but sidesteps the whole server-side HEIC problem permanently.
  3. Either way, extend the EXIF fallback: once a Linux-capable decoder exists, route EXIF extraction through it too (or keep using `exifr` for JPEG/PNG and only special-case true HEIC).
  - **Do this before any real production deployment** — it's the single most impactful undone item.

### 2. No `trust proxy` setting
- **Where:** `backend/src/app.ts` — no `app.set("trust proxy", ...)` anywhere.
- **Impact:** Behind Railway's edge proxy, `req.ip` resolves to the proxy's IP for every request. The login rate limiter (`routes/auth.ts`, 10 attempts/15min) becomes a **shared global bucket** — one aggressive user (or a bug) can lock out login for every user on the app simultaneously. Guest-invite rate limiting and audit-log IP recording are equally corrupted.
- **Fix:** `app.set("trust proxy", 1)` in production (trust exactly one hop — Railway's own proxy), gated behind `NODE_ENV === "production"` or an explicit env var so local dev (no proxy) isn't affected. One line, test that `req.ip` resolves correctly after deploying.

### 3. CSRF gap in production
- **Where:** `backend/src/lib/session.ts` (~line 71) and `backend/src/lib/guestSession.ts` (~line 126) set `sameSite: "none"` in production (needed for the Vercel/Railway cross-site cookie setup) with **no CSRF token and no Origin-header check** anywhere in `app.ts`.
- **Impact:** State-changing POST endpoints with optional/empty bodies (`/api/auth/logout`, `/api/photos/:id/restore`, `/api/folders/:id/restore`, trash-empty) don't trigger a CORS preflight, so they're forgeable via a simple cross-site form POST from any malicious page while a user is logged in.
- **Fix:** Add an Origin/Referer-validation middleware applied to all non-GET routes in production: reject (403) any state-changing request whose `Origin` header isn't in the same allow-list already used for CORS (`FRONTEND_ORIGIN` / `MOBILE_DEV_ORIGIN` / `EXTRA_ALLOWED_ORIGINS`). This is a well-understood, cheap alternative to full CSRF tokens for an API-only backend with a known frontend origin set.

### 4. No account deletion path
- **Where:** No endpoint anywhere in `backend/src/routes/*.ts` deletes a `User` row.
- **Impact:** Two problems at once: (a) there is literally no way for a user to delete their account (a GDPR/roadmap promise — "delete endpoint removes all data including S3 objects within 30 days"), and (b) if a user row were ever deleted directly in the DB, Prisma's cascades would clean up rows but **orphan every S3 object** (originals + thumbnails) and the **Rekognition face collection** (`faces.ts` only ever calls `CreateCollectionCommand` — `DeleteCollection`/`DeleteFaces` are never called anywhere).
- **Fix:**
  1. Add `DELETE /api/auth/me` (or `/api/account`): re-authenticate (require password confirmation), then in order: (a) walk every live photo for the user and best-effort delete its S3 objects (original + all thumbnail sizes) — reuse the existing purge logic in `lib/purge.ts`; (b) delete the Rekognition face collection via `DeleteCollectionCommand` (new call in `faces.ts`); (c) delete the `User` row (Prisma cascades take the rest of the DB rows).
  2. Consider a 30-day soft-delete grace period (matches the GDPR promise's own wording) rather than instant hard delete: mark the user `deletedAt`, block login, and let the existing daily purge-job pattern sweep accounts past 30 days — mirrors the trash-system design already in the codebase.

### 5. No environment validation at boot
- **Where:** `backend/src/lib/storage.ts` (~lines 39–40) uses non-null assertions (`process.env.AWS_ACCESS_KEY_ID!`) instead of validating at startup. Same pattern likely elsewhere (Rekognition region, Resend key, etc.).
- **Impact:** A missing/misconfigured env var doesn't fail the deploy — it surfaces later as a confusing runtime S3/Rekognition error on the first real request, often deep in worker code, making it hard to diagnose.
- **Fix:** Add a small env-validation module (zod schema of required vars, branched by which providers are enabled — e.g. only require `AWS_S3_BUCKET`+creds when that provider path is active) called once at the very top of `server.ts` and `worker.ts`. Exit with a clear error message listing every missing var if validation fails, before anything else runs.

---

## 🟠 Major product gaps (roadmap promises not yet built)

### 6. Cloud export (Drive/Dropbox) — entirely missing
- **Where:** No `/api/exports/*` routes, no OAuth connect flow, no `export_jobs`/`oauth_tokens` tables, no export worker.
- **Why it matters:** Named as a **core differentiator** in the Project Instruction doc and fully designed in Roadmap §14 (endpoints, tables, streaming S3→Drive flow).
- **Fix (scope as its own spec via Planner, this is genuinely large):**
  1. Schema: `OAuthToken` (per-owner, per-provider access/refresh tokens, encrypted at rest) and `ExportJob` (status, target folder id, progress, error) tables.
  2. OAuth connect flow: `GET /api/exports/connect/:provider` → redirect to Google/Dropbox OAuth consent → callback stores encrypted tokens.
  3. `POST /api/exports` (kick off a job: which folder/photos, which destination) → BullMQ job that streams each photo from S3 straight into the destination API (never buffering the whole file in memory — same streaming discipline as the existing folder-zip download).
  4. `GET /api/exports/:id` for progress polling, same pattern as reclassify's job-status polling already in the codebase.

### 7. Billing / plan enforcement — missing
- **Where:** `users.plan` column exists and defaults to `"free"` but is never read anywhere in the codebase (grep confirms zero reads). Only `storageLimitBytes` is actually enforced.
- **Why it matters:** The free tier's promised 3-guest limit is unenforced (a free user can invite unlimited guests today); no Pro/Studio tier differentiation exists at all.
- **Fix (in two independent pieces — enforcement doesn't require Stripe):**
  1. **Plan enforcement now (no billing needed):** add a guest-count check in `routes/invites.ts` (or wherever invites are created) — count the owner's live `GuestUser` rows, reject with 402/403 once `plan === "free"` and count ≥ 3. Similarly gate any other free-tier limits the roadmap defines (larger storage limits per plan already partially works via `storageLimitBytes`, just needs to vary that value by plan on signup/plan-change).
  2. **Stripe billing (deferred per CLAUDE.md until explicitly approved)** — when approved: `POST /api/billing/checkout` (Stripe Checkout session), a webhook endpoint to update `users.plan`/`storageLimitBytes` on successful subscription events, and a customer-portal link for self-service plan management.

### 8. Auth surface is incomplete
- **Where:** `backend/src/routes/auth.ts` has only signup/login/logout/me.
- **Missing:** password reset (forgot-password email + reset-token flow), email verification, profile update (name/password change), magic-link login (promised in Roadmap §11), Google OAuth (tech-stack promise; schema already allows a null `password_hash` in anticipation of this).
- **Fix (each is its own small-to-medium spec):**
  1. **Password reset:** `POST /api/auth/forgot-password` (generates a short-lived hashed reset token, emails a link via the existing `lib/notifications` — same pattern as OTP emails) → `POST /api/auth/reset-password` (validates token, updates `passwordHash`, invalidates all existing sessions for that user — ties into gap #11 below).
  2. **Email verification:** add an `emailVerifiedAt` column, send a verification link on signup (reuse the OTP-style token pattern), gate sensitive actions (guest invites?) on verification if desired.
  3. **Profile update:** `PATCH /api/auth/me` for name; a dedicated `POST /api/auth/change-password` (requires current password) that also revokes other sessions.
  4. **Google OAuth:** add Passport.js (already a roadmap tech-stack promise) with a Google strategy; on first login, create a `User` row with `passwordHash: null`; existing login endpoint already needs to handle that case gracefully (verify it does — audit didn't confirm either way).
  5. **Magic link:** `POST /api/auth/magic-link` (email a single-use, short-TTL login token) → `GET /api/auth/magic-link/:token` (verifies + establishes a session) — essentially a simpler cousin of the reset-password flow, can reuse most of its plumbing.

### 9. Guest invite emails are missing
- **Where:** `lib/notifications/index.ts` only exposes `sendOwnerOtp`. The actual `/g/:token` invite link is never emailed to the guest — the owner has to copy/share it manually today.
- **Fix:** Add `sendGuestInviteEmail(guestEmail, inviteUrl, ownerName)` to `lib/notifications`, call it right after `InviteToken` creation in `routes/invites.ts` (or wherever invites are generated). Also add an "access expiring soon" reminder: a small daily job (same repeatable-job pattern as the trash purge) that finds `FolderPermission` rows nearing any expiry the roadmap defines and emails a reminder.

### 10. Multi-collection workflow doesn't exist
- **Where:** `routes/collections.ts` only lists collections and serves per-collection folders; there's no `POST /api/collections`, `GET /api/collections/:id`, or `DELETE /api/collections/:id`. Every upload lands in one lazily-created default collection.
- **Fix:** Add the three missing CRUD endpoints (straightforward — mirror the existing folder CRUD patterns for auth/ownership checks), and let the upload endpoint accept an optional `collectionId` (defaulting to the auto-created one, preserving all existing behavior) so a "project/batch" workflow becomes possible.

### 11. AI labels aren't searchable or editable as tags
- **Where:** `Photo.aiLabels` (string array) is stored and shown in the UI, but `routes/search.ts` only filters by folder/category/date/filename — never by label text. There's also no endpoint to manually edit a photo's tags.
- **Fix:** Add a `labels` query param to `GET /api/search` (Prisma array-contains / `hasSome` filter on `aiLabels`); add `PATCH /api/photos/:id/labels` for manual tag editing (append/remove), storing manual edits either by mutating `aiLabels` directly (simplest) or adding a separate `manualLabels` column if you want AI-detected vs. user-added labels to stay distinguishable (recommended — keeps the "why is this here" reason logic from Bugs.md #15 uncorrupted by manual edits).

---

## 🟡 Operational hardening

### 12. Unbounded table growth — no cleanup sweep
- **Where:** `Session`, `GuestSession`, `InviteToken`, `AccessRequest`, `AccessRequestTouch` rows are never deleted after expiry; `ProcessingJob` rows only ever get removed via a photo's own delete-cascade, so completed rows for live photos accumulate ~1–2 per upload forever; `AuditLog` has no retention policy at all.
- **Fix:** Extend the **existing** daily repeatable job (`lib/trashPurgeJob.ts` already runs one BullMQ repeatable job on a schedule) with additional sweep steps rather than building new infrastructure:
  1. `DELETE FROM sessions WHERE expiresAt < now()` (and same for `GuestSession`).
  2. `DELETE FROM invite_tokens WHERE expiresAt < now() AND used = false` (keep used ones if needed for audit; otherwise delete both).
  3. `DELETE FROM access_requests WHERE status IN ('expired','denied') AND createdAt < now() - interval '30 days'` (and cascade `AccessRequestTouch` via the existing FK).
  4. `DELETE FROM processing_jobs WHERE status = 'completed' AND createdAt < now() - interval '90 days'` — keep failed ones longer for debugging.
  5. For `AuditLog`: decide a retention window (90 days? 1 year?) and either delete or move to cold storage past it — this is a product/compliance decision, flag it as a pending decision rather than guessing.

### 13. Rate limiting coverage gaps
- **Where:** Only signup/login/upload/reclassify/invite endpoints have limiters. The guest portal (`routes/guest.ts`) — which mints presigned URLs — has none; no global fallback limiter exists for anything else.
- **Fix:** Add a lightweight limiter to every guest-portal endpoint (reuse the existing rate-limiter middleware pattern, just a new bucket keyed by guest session or IP), and add one global, generous fallback limiter (e.g. 300 req/min per IP) applied in `app.ts` ahead of all routes as a backstop against anything not explicitly covered.

### 14. Ops visibility gaps
- **Where:** `/health` in `app.ts` (~line 75) returns 200 unconditionally — checks nothing. The worker process has no health/heartbeat signal at all. Only `console.log`/`console.error` exist — no structured logging, no correlation IDs, no error-monitoring integration (Sentry etc.). BullMQ has `removeOnFail: false` with no dead-letter alerting, and a photo whose job-enqueue fails after the DB commit gets stuck `pending` forever with no reconciliation.
- **Fix (do incrementally, roughly in this order):**
  1. Make `/health` actually check something: a fast `SELECT 1` against Postgres and a Redis `PING`, returning 503 if either fails — this alone makes Railway's own health-check-based restart behavior meaningful.
  2. Give the worker a trivial heartbeat: write a timestamp to a Redis key on every processed job (or every N seconds); `/health` (or a separate `/worker-health` hit via a shared Redis key) can then report "worker last seen Xs ago."
  3. Swap `console.*` for a structured logger (pino is the lightest-weight standard choice) — cheap win, makes every other observability step easier.
  4. Add a stale-`pending`/`processing` sweep to the same daily job from #12: any photo stuck in `pending`/`processing` for >1 hour with no matching active `ProcessingJob` gets re-enqueued or flagged `failed` with a clear error.
  5. Sentry (or similar) is a bigger step — worth doing once the product has real users, not urgent before then.

### 15. No graceful shutdown on the API
- **Where:** `server.ts` has no `SIGTERM`/`SIGINT` handler; the worker already handles this correctly (`worker.ts` ~lines 866–873) but doesn't disconnect Prisma/Redis even there.
- **Fix:** In `server.ts`, listen for `SIGTERM`: stop accepting new connections (`server.close()`), wait for in-flight requests to finish (with a timeout), then `await prisma.$disconnect()` before exiting. Add the same `prisma.$disconnect()` to the worker's existing shutdown handler.

### 16. Orphaned S3 objects — no reconciliation
- **Where:** `lib/purge.ts` deletes the DB row first, S3 cleanup is best-effort log-and-continue (~lines 84–92) — correct ordering (DB is the source of truth) but means a failed S3 delete is silently orphaned forever. Symmetrically, a crash between `putObject` and the DB write in `routes/photos.ts` (~lines 104–130) can leave a DB row with no matching object or an object with no matching row.
- **Fix:** A periodic (weekly?) reconciliation script/job: list S3 keys under each owner's prefix, diff against known `s3Key`/thumbnail-key values in the DB, delete orphaned objects older than some grace period (e.g. 24h, to avoid racing an in-flight upload). Not urgent at current scale; worth having before real growth.

### 17. Misleading guest telemetry
- **Where:** `GuestSession.lastUsedAt` is set once at creation and never updated on subsequent use, but `routes/guests.ts` (~line 198) surfaces it to the owner as "last access" — it's actually "first access."
- **Fix:** Update `lastUsedAt` on every authenticated guest-portal request (a simple `updateMany` in the guest-auth middleware), or rename the field/label if "first access" is actually the intended semantic (quick decision needed, then a one-line fix either way).

---

## 🟢 Minor polish

### 18. JSON 404 handler
- **Where:** Unknown routes fall through to Express's default HTML 404 page, breaking the otherwise-consistent `{ error }` JSON shape every other endpoint uses.
- **Fix:** Add a catch-all `app.use((req, res) => res.status(404).json({ error: "Not found" }))` after every real route registration.

### 19. No API versioning or docs
- **Fix:** Not urgent for a single first-party frontend. If a public API ever ships (see the `rest-api-webhooks` item already in the dashboard's Phase 3 queue), version then (`/api/v1/...`) rather than retrofitting.

### 20. `bcryptjs` instead of native `bcrypt`
- **Where:** `routes/auth.ts` (~lines 13, 58).
- **Impact:** Pure-JS bcrypt burns main-thread CPU per login/signup — fine at current scale, a real bottleneck under load (blocks the Node event loop during hashing).
- **Fix:** Swap to native `bcrypt` (or `argon2`) — drop-in API-compatible replacement in most cases; verify build works in the Railway container (native module compilation) before committing to it.

### 21. Password max-length
- **Where:** `lib/validation.ts` (~line 5) only enforces `min(8)`.
- **Fix:** Add `max(72)` (bcrypt silently truncates beyond 72 bytes — worth enforcing explicitly rather than letting users assume their 200-char password is fully used).

### 22. No pre-upload duplicate warning
- **Where:** Dedup only runs post-upload in the worker; there's no lightweight "have I already uploaded this?" check before the bytes are sent.
- **Fix:** Add a cheap pre-upload endpoint (`POST /api/photos/check-duplicate` — SHA-256 of the file computed client-side, checked against the owner's existing `fileSha256` values) so the frontend can warn *before* spending the upload bandwidth, not just after.

### 23. CI pipeline
- **Already queued** in `dashboard/suggestions.json` (`ci-pipeline`, backlog tier) — GitHub Actions running `tsc --noEmit` + lint + the test suite on every PR. No new action needed here beyond what's already tracked.

---

## Recommended attack order

1. **Quick wins (one sitting, all S-sized, all real fixes):** #2 trust proxy, #3 CSRF/Origin check, #5 env validation, #12 cleanup sweep, #13 rate-limit coverage, #15 graceful shutdown, #17 lastUsedAt semantics, #18 JSON 404, #21 password max-length.
2. **Then the two production blockers:** #1 Linux HEIC decoding (blocks any real deploy with iPhone users), #4 account deletion (blocks any real GDPR-compliant launch).
3. **Then ops visibility:** #14 (health checks, worker heartbeat, structured logging, stale-job sweep) — makes every future issue easier to diagnose.
4. **Then the product features** (#6–#11, #22) via the normal Planner → spec → Developer flow, since these are genuine feature builds, not bug fixes — each deserves its own scoped spec, not a rushed implementation alongside the operational fixes above.
