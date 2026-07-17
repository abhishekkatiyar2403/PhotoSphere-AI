# Spec — Guest Access + OTP (Share Grants, OTP Approval Gate, Guest Sessions, Scoped Guest Portal)

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 7 (Phase 1 — MVP, Week 9–10: Guest Access + OTP System), § 6 (Database Schema — `guest_users`, `invite_tokens`, `folder_permissions`, `access_requests`, `guest_sessions`), § 11 (API Design — GUEST ACCESS + GUEST PORTAL), § 12 (Security Architecture — Layer 5 OTP Gate, OTP Security Details, Pre-signed URL Flow), § 14 (Guest Access & Cloud Export System — flow diagram)
**Status:** draft
**Written by:** Planner Agent, 2026-07-04

## Problem

Week 1–8 is complete and clean: a photographer (the "owner") can sign up, upload, have photos AI-organized into folders inside a default collection, browse them, and see a dashboard. But the product's Definition of Done (roadmap § 7) ends with *"they share specific folders with clients via invite link with OTP approval, client downloads photos."* None of that sharing surface exists yet. Today every photo/folder endpoint is strictly owner-scoped (`ownerId === req.user!.id`, 404 otherwise); there is no notion of a guest, no way to grant a scoped subset of one's library to someone without a full account, and no approval gate before a stranger with a link can look at private photos.

This spec builds the **backend + data model core** of Guest Access: an owner creates a share (an invite scoped to specific folders with a permission level and expiry), a guest opens the invite link and requests access, an OTP is generated and delivered **to the owner** (mocked, see hard constraint) for real-time approval, and on approval the guest gets an opaque guest session that can list and view *only* the shared folders — every image still delivered as a 60s pre-signed URL, never a raw key. The owner can revoke any guest instantly.

**This spec deliberately stops at the API + data model.** The three new UI surfaces it implies (owner "Share" panel, owner pending-request/approval + guest-management view, and the guest portal landing→OTP-wait→scoped-browser flow) each need the standard propose→pick→build wireframe round and are called out at the end for Master to queue — they are NOT designed or built here.

## Hard constraints (baked in, non-negotiable)

1. **OTP delivery is MOCKED behind a swappable one-file interface**, exactly mirroring `backend/src/lib/classification/index.ts`. A new `backend/src/lib/notifications/index.ts` exposes a `NotificationProvider` interface (`sendOwnerOtp({ ownerEmail, ownerName, guestEmail, code, requestId })`) with a single `MockNotificationProvider` implementation that does NOT send real email/SMS — no Twilio/SendGrid/SES/Resend, no cloud credentials, ever, until Abhishek explicitly wires a real provider (CLAUDE.md ground rule). The mock records the delivery in-memory and exposes the plaintext OTP **only under a test flag** (see § 5) so Tester can complete the flow end-to-end. Swapping in real email later is a one-file change to that module and nothing else. State this in the module's header comment, same as the classifier's.
2. **Opaque guest session tokens, never JWT.** Guest sessions reuse the exact pattern in `backend/src/lib/session.ts`: `crypto.randomBytes(32).toString("hex")` raw token to the client, SHA-256 hash stored in the DB, checked server-side on every guest request so revocation is instant and durable. A parallel `guestSession.ts` helper mirrors `session.ts` (do NOT overload the owner-session helpers with a guest branch — keep them separate, like the two rate limiters are separate).
3. **Every image access still goes through permission check → 60s pre-signed URL.** A guest photo view/download calls `getPresignedGetUrl(key, 60)` (existing `lib/storage.ts`) only *after* the guest session is validated AND a live `folder_permission` for that photo's folder is confirmed. A guest NEVER receives a raw `s3Key`, and can only reach photos whose `folderId` is in their permitted set. No new storage code — reuse the existing pre-signed-URL path verbatim.
4. **404-not-403 on ownership/authorization mismatch**, `requireAuth`/`asyncHandler`/Zod-on-every-body-and-query conventions, additive Prisma migration (nothing renamed/removed), async work via BullMQ only if something is genuinely slow (nothing here is — see § 4 note). Guest-facing endpoints return 404 for any folder/photo not in the guest's permitted set, never confirming existence of something they can't see.
5. **Local-first slice only** — Docker Compose (Postgres/Redis/MinIO). No AWS/Terraform/EKS/Stripe. No cloud export (§ 14's "Export to Drive/Dropbox" is explicitly Non-goal — Phase 2).

## Goals

- **Share creation (owner):** `POST /api/guests` — owner picks folders they own + a guest email + a permission level + an expiry, system creates a `guest_user`, an `invite_token` (raw token → SHA-256 hash, short-link-friendly), and one `folder_permission` per selected folder.
- **Guest listing + revocation (owner):** `GET /api/guests` (all guests this owner created, with status), `DELETE /api/guests/:id` (one-tap revoke — revokes all the guest's sessions + marks permissions revoked, instantly cutting off access).
- **Access request (guest, unauthenticated):** `POST /api/invites/:token/request` — guest opens the link, system validates the token, creates a `guest_user`-scoped `access_request` (status `pending`), captures IP + user-agent, generates a 6-digit OTP, hashes it, stores the hash + expiry, and hands it to the mock notification provider addressed **to the owner** (the owner approves, per roadmap § 12 Layer 5 — the guest never types the OTP).
- **OTP approval/deny (owner):** `POST /api/access-requests/:id/approve` — owner submits the OTP they received; on match (within TTL, under the attempt cap, single-use) the request flips to `approved`, a `guest_session` is minted, and the raw guest token is returned so the guest's polling client can pick it up. `POST /api/access-requests/:id/deny` — owner rejects; request → `denied`.
- **Guest session issuance + polling:** the guest's landing page polls request status; once `approved`, the guest receives (or already holds) the opaque guest session cookie/token and is redirected into the scoped browser. (See Open Decision #7 for exactly how the raw guest token reaches the guest client.)
- **Scoped guest portal (guest session required):** `GET /api/guest/folders` (only permitted, non-revoked, non-expired folders), `GET /api/guest/folders/:id/photos` (paginated, 404 if not permitted), `GET /api/guest/photos/:id` (metadata + 60s pre-signed thumbnail/original URLs, 404 if the photo isn't in a permitted folder), `GET /api/guest/photos/:id/download` (permission_level ≥ download; 60s pre-signed URL to the original).
- **Guest-scope enforcement middleware:** a `requireGuest` middleware mirroring `requireAuth`, plus a per-request permitted-folder-set resolver so no guest endpoint can leak a folder/photo outside the grant.
- **Security:** OTP is 6 digits (`crypto.randomInt(100000, 999999)`), SHA-256-hashed, 5-min TTL, single-use, max 3 wrong attempts → request auto-denied (all per roadmap § 12). Guest sessions expire; owner can revoke. Its own rate-limit bucket for the invite-request endpoint (public, unauthenticated — the highest-abuse surface here).
- All new endpoints follow existing conventions exactly (see Hard constraint 4).

## Non-goals (explicitly out of scope for this pass)

- **Real email/SMS/push delivery** — repeated for emphasis: mock only, no Twilio/SES/SendGrid/Resend, no credentials. Real delivery is a one-file swap-in gated on Abhishek's explicit go-ahead.
- **Cloud export (Google Drive / Dropbox / OneDrive / iCloud)** — roadmap § 14's export half is Phase 2 (§ 8 lists no export in Phase 1 MVP-close), needs third-party OAuth we can't wire locally. Not this spec.
- **The three guest UIs** — owner Share panel, owner approval/guest-management dashboard, guest portal (landing/OTP-wait/scoped browser + download button). Each needs its own wireframe round (see "UI that needs a wireframe round"). This spec is the buildable API + data-model core those UIs will call.
- **Short-link vanity domain / URL shortener** (`photosphere.app/g/xK92mP`) — the token *is* the short link's payload; we generate a URL-safe token and expose the invite path (e.g. `/g/:token` on the frontend → `POST /api/invites/:token/request`). No external shortener service, no custom domain (that's deploy/infra, Week 11–12+). See Open Decision #4.
- **Audit log** (`audit_log` table, roadmap § 6 / Week 11–12 "Audit, Polish") — roadmap explicitly sequences the audit log into Week 11–12, not Week 9–10. This spec does NOT build the `audit_log` table or `GET /api/audit`. It DOES leave the natural hook points (approve/deny/revoke/view/download all pass through single choke-point handlers) so Week 11–12 can add logging without refactoring. Flagged Open Decision #9.
- **Geolocation enrichment** (`access_requests.location_city` / `location_country`) — roadmap § 6 has these columns, but IP→geo needs an external lookup service we won't wire locally. Capture IP + user-agent (`device_info`) only; leave the geo columns out of the additive migration (or nullable-and-unset). Flagged Open Decision #8.
- **Guest self-service access extension**, **download watermarking**, **face-based sharing**, **email "access expiring" notifications** — all Phase 2 / Week 11–12 per roadmap § 8.
- **Owner UI for selecting folders** — the API takes folder IDs; how the owner picks them is the Share-panel wireframe round, not this spec.
- **`is_public` collection flag / public galleries** — sharing here is invite+OTP-gated only, never a public link. No `is_public` handling.
- **Guest account upgrade to a full user** — a guest is a lightweight `guest_user`, never promoted to `users` in this pass.

## Scope for this sprint

### 1. Schema (`backend/prisma/schema.prisma` + a new additive `prisma migrate dev` migration)

All additive — no existing model renamed or removed. New models follow the established snake_case-DB / camelCase-Prisma convention and roadmap § 6's table shapes (with the two documented deviations: geo columns dropped, see Non-goals; owner-notification via mock).

```prisma
model GuestUser {
  id        String   @id @default(uuid())
  email     String
  name      String?
  createdBy String   @map("created_by") // the owner (users.id) who invited them
  createdAt DateTime @default(now()) @map("created_at")

  owner            User               @relation("GuestsInvited", fields: [createdBy], references: [id], onDelete: Cascade)
  inviteTokens     InviteToken[]
  folderPermissions FolderPermission[]
  accessRequests   AccessRequest[]
  guestSessions    GuestSession[]

  @@index([createdBy])
  @@map("guest_users")
}

model InviteToken {
  id           String    @id @default(uuid())
  tokenHash    String    @unique @map("token_hash") // SHA-256 of the raw token (raw only ever in the link)
  guestUserId  String    @map("guest_user_id")
  collectionId String?   @map("collection_id") // roadmap ties invites to a collection; folders carry the real scope (Open Decision #3)
  createdBy    String    @map("created_by")
  maxUses      Int?      @map("max_uses") // null = unlimited (see Open Decision #6)
  useCount     Int       @default(0) @map("use_count")
  expiresAt    DateTime? @map("expires_at")
  isActive     Boolean   @default(true) @map("is_active")
  createdAt    DateTime  @default(now()) @map("created_at")

  guestUser GuestUser @relation(fields: [guestUserId], references: [id], onDelete: Cascade)
  accessRequests AccessRequest[]

  @@index([guestUserId])
  @@map("invite_tokens")
}

model FolderPermission {
  id              String    @id @default(uuid())
  guestUserId     String    @map("guest_user_id")
  folderId        String    @map("folder_id")
  permissionLevel String    @map("permission_level") // 'view' | 'download' | 'download_all'
  expiresAt       DateTime? @map("expires_at")
  grantedBy       String    @map("granted_by") // users.id
  revokedAt       DateTime? @map("revoked_at") // null = active
  createdAt       DateTime  @default(now()) @map("created_at")

  guestUser GuestUser @relation(fields: [guestUserId], references: [id], onDelete: Cascade)
  folder    Folder    @relation(fields: [folderId], references: [id], onDelete: Cascade)

  @@unique([guestUserId, folderId])
  @@index([guestUserId])
  @@map("folder_permissions")
}

model AccessRequest {
  id            String    @id @default(uuid())
  inviteTokenId String    @map("invite_token_id")
  guestUserId   String    @map("guest_user_id")
  ipAddress     String?   @map("ip_address")
  deviceInfo    Json?     @map("device_info") // user-agent etc. (no geo — see Non-goals)
  status        String    @default("pending") // pending|approved|denied|expired
  otpHash       String?   @map("otp_hash") // SHA-256 of the 6-digit OTP
  otpExpiresAt  DateTime? @map("otp_expires_at")
  otpAttempts   Int       @default(0) @map("otp_attempts") // increments on each wrong owner-submitted code; 3 -> auto-deny
  createdAt     DateTime  @default(now()) @map("created_at")
  resolvedAt    DateTime? @map("resolved_at")
  resolvedBy    String?   @map("resolved_by") // users.id of the approving/denying owner

  inviteToken InviteToken @relation(fields: [inviteTokenId], references: [id], onDelete: Cascade)
  guestUser   GuestUser   @relation(fields: [guestUserId], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
  @@map("access_requests")
}

model GuestSession {
  id          String    @id @default(uuid())
  guestUserId String    @map("guest_user_id")
  tokenHash   String    @unique @map("token_hash") // SHA-256, mirrors Session
  ipAddress   String?   @map("ip_address")
  userAgent   String?   @map("user_agent")
  expiresAt   DateTime  @map("expires_at") // added vs roadmap §6 (which omits it) — see Open Decision #2
  lastUsedAt  DateTime  @default(now()) @map("last_used_at")
  revokedAt   DateTime? @map("revoked_at")
  createdAt   DateTime  @default(now()) @map("created_at")

  guestUser GuestUser @relation(fields: [guestUserId], references: [id], onDelete: Cascade)

  @@index([guestUserId])
  @@map("guest_sessions")
}
```

Additive relation fields on existing models (both back-relations only, no column changes):
- `User`: `guestsInvited GuestUser[] @relation("GuestsInvited")`
- `Folder`: `permissions FolderPermission[]`

The migration is additive-only: five new tables + two new relation arrays (which are virtual in Prisma, no column added to existing tables). `prisma migrate dev` continues the existing migration history (last: `20260702090917_add_collections_folders_classification`).

### 2. Guest session helper (`backend/src/lib/guestSession.ts`)

Mirrors `lib/session.ts` one-to-one but for guests:
- `GUEST_SESSION_COOKIE_NAME = "photosphere_guest_session"` (distinct from the owner cookie so a logged-in owner previewing their own share doesn't collide — an owner and a guest can hold both cookies simultaneously).
- `createGuestSession(guestUserId, { ip, userAgent })` → `{ rawToken, expiresAt }`, raw token to client, SHA-256 hash to DB.
- `getGuestSession(rawToken)` → the `GuestSession` + its `guestUser`, or null if missing/revoked/expired.
- `revokeGuestSessionsForGuest(guestUserId)` → mark all that guest's sessions revoked (used by `DELETE /api/guests/:id`).
- `guestSessionCookieOptions()` — same HttpOnly/SameSite=Lax, Secure-conditional-on-prod pattern as the owner cookie.
- Guest session TTL from `GUEST_SESSION_TTL_HOURS` env (default per Open Decision #2).

### 3. Guest-scope middleware (`backend/src/middleware/requireGuest.ts`)

Mirrors `requireAuth` but resolves a guest instead of an owner:
- Reads the guest cookie, validates via `getGuestSession`, 401 if invalid/revoked/expired.
- Attaches `req.guest = { guestUserId, sessionId }` (augment Express `Request` the same way `requireAuth` augments `user`).
- A helper `getPermittedFolderIds(guestUserId): Promise<Set<string>>` returns the folder IDs the guest currently has a **live** (`revokedAt = null` AND (`expiresAt` null OR future)) permission for. **Every** guest-facing folder/photo query filters against this set; anything outside it is 404. This is the single choke point that makes cross-scope leakage structurally impossible — reviewed as such.

### 4. OTP + notification (mock) module (`backend/src/lib/notifications/index.ts` + OTP helpers)

- `NotificationProvider` interface + `MockNotificationProvider` (see Hard constraint 1). The mock stores the last delivery per `requestId` in an in-memory map and, **only when `NOTIFICATIONS_EXPOSE_OTP === "true"` (or `NODE_ENV === "test"`)**, exposes the plaintext code so Tester can read it. In any other mode the code is never returned or logged in plaintext.
- OTP helpers (co-located, e.g. `backend/src/lib/otp.ts`): `generateOtp()` → 6-digit string via `crypto.randomInt(100000, 999999)`; `hashOtp(code)` → SHA-256; constant-time compare on verify.
- **No BullMQ for OTP** — generation + mock "send" are synchronous and instant; enqueueing would only add latency and failure modes with no benefit (Hard constraint 4's "async only if genuinely slow"). If/when real email is swapped in and proves slow, that swap can move the send into a job then; the interface makes that a contained change.

### 5. Endpoints

All owner endpoints: `requireAuth`, Zod validation, 404-not-403 on any folder/guest not owned by the caller. All guest endpoints: `requireGuest`, filtered against `getPermittedFolderIds`, 404 for anything outside scope.

**Owner — share management (mounted `/api/guests`, `/api/access-requests`):**

| Method + path | Auth | Body / params | Behavior | Errors |
|---|---|---|---|---|
| `POST /api/guests` | owner | `{ guestEmail, guestName?, folderIds: string[] (1..N), permissionLevel: 'view'\|'download'\|'download_all', expiresInDays?: number }` | Validate every `folderId` belongs to a collection the owner owns (404 on any miss — never partially create). Create `guest_user`, `invite_token` (raw token generated, hash stored), one `folder_permission` per folder. Return `{ guestId, inviteToken (raw, once), inviteUrl, expiresAt }`. | 400 invalid body; 404 if any folder not owned |
| `GET /api/guests` | owner | — | List all `guest_users` this owner created, each with derived status (`pending` / `active` / `revoked` / `expired`), permitted folder names, permission level, last access time. | — |
| `DELETE /api/guests/:id` | owner | — | 404 if guest not created by this owner. Otherwise: `invite_token.is_active = false`, all `folder_permissions.revoked_at = NOW()`, `revokeGuestSessionsForGuest()`, any `pending` access_requests → `denied`. Idempotent. | 404 if not owner's guest |
| `GET /api/access-requests` | owner | `?status=pending` (default) | Pending (and optionally resolved) access requests across this owner's guests, with captured IP/device + guest email — the approval queue. | — |
| `POST /api/access-requests/:id/approve` | owner | `{ otp: string(6) }` | 404 if the request isn't for one of this owner's guests. Enforce: not already resolved, OTP not expired, attempts < 3. Constant-time compare hash. On match: single-use invalidate (`otp_hash = null`), status `approved`, `resolved_at/by` set, mint `guest_session`, increment `invite_token.use_count`. Return `{ status: 'approved', guestToken (raw), guestTokenExpiresAt }` (see Open Decision #7). On mismatch: increment `otp_attempts`; at 3 → status `denied` (`otp_hash` cleared), return 403 "request denied". Otherwise 401 "invalid code". | 404; 401 wrong code; 403 auto-denied/expired; 409 already resolved |
| `POST /api/access-requests/:id/deny` | owner | — | 404 if not owner's guest's request. Set `denied`, clear `otp_hash`. Idempotent-ish (409 if already `approved`). | 404; 409 if already approved |

**Guest — public (unauthenticated), invite entry (mounted `/api/invites`):**

| Method + path | Auth | Body / params | Behavior | Errors |
|---|---|---|---|---|
| `POST /api/invites/:token/request` | none (rate-limited, see § 6) | — (captures IP + UA server-side) | Look up `invite_token` by SHA-256 of `:token`. 404 if not found / `is_active=false` / expired / `use_count >= max_uses`. **Never confirm token validity to reduce enumeration** — invalid token → generic 404. On valid: create `access_request` (`pending`), generate + hash OTP, store hash + 5-min expiry, hand plaintext to mock provider addressed to the owner. Return `{ requestId, status: 'pending' }` (never the OTP). If a live `guest_session` already exists for this guest (re-click), short-circuit: return `{ status: 'already_approved' }` without a new OTP (Open Decision #10). | 404 invalid/expired/exhausted token; 429 rate-limited |
| `GET /api/invites/requests/:requestId/status` | none (rate-limited) | — | Polling endpoint for the guest's waiting page. Returns `{ status: 'pending'\|'approved'\|'denied'\|'expired' }`. On `approved`, if the guest-token-in-cookie approach is chosen (Open Decision #7), this is where the cookie is set. Returns 404 for an unknown `requestId` (no enumeration of others' requests — `requestId` is a UUID, unguessable). | 404 unknown request; 429 |

**Guest — portal (guest session required, mounted `/api/guest`):**

| Method + path | Auth | Behavior | Errors |
|---|---|---|---|
| `GET /api/guest/folders` | guest | List only folders in `getPermittedFolderIds`, each with name + photoCount + permission_level. Empty array if all revoked/expired (not an error). | 401 no/invalid guest session |
| `GET /api/guest/folders/:id/photos` | guest | 404 unless `:id` ∈ permitted set. Paginated (reuse `folderPhotosQuerySchema`), photo cards with 60s pre-signed thumbnail URLs (reuse `toPhotoCard`/`PHOTO_CARD_SELECT` — never a raw key). | 401; 404 not permitted; 400 bad pagination |
| `GET /api/guest/photos/:id` | guest | Fetch photo; 404 unless its `folderId` ∈ permitted set. Return metadata + 60s pre-signed thumbnail + original URLs. Same 60s-TTL pre-signed path as the owner `GET /api/photos/:id`. | 401; 404 not permitted |
| `GET /api/guest/photos/:id/download` | guest | Requires the photo's folder permission to be `download` or `download_all` (404/403 if only `view` — Open Decision #5 on which code). 60s pre-signed URL to the original. | 401; 404 not permitted; 403 view-only |

### 6. Rate limiting (`backend/src/middleware/inviteRateLimiter.ts`)

The public, unauthenticated `POST /api/invites/:token/request` (and the status-poll) is the highest-abuse surface (no session gate, could be hammered to spam owners with OTP requests or enumerate tokens). It gets **its own IP-keyed bucket**, separate from auth/upload/reclassify (the established one-bucket-per-endpoint-group rule). Proposed: **10 requests / 15 min / IP** for the request endpoint, relaxed under `NODE_ENV=test` like the auth limiters. The status-poll endpoint is higher (polling every ~3s per roadmap § 14): **120 / 15 min / IP**, or exempt in test. Numbers open — Open Decision #11. The OTP *attempt* cap (max 3 wrong codes → auto-deny) is enforced in the approve handler on the `access_request` row itself, independent of the IP rate limiter.

### 7. Wiring (`backend/src/app.ts`)

Mount four new routers: `/api/guests`, `/api/access-requests`, `/api/invites`, `/api/guest`. Order matters only within `/api/invites` (literal `requests/:requestId/status` must not be shadowed by `:token/request` — register the literal-prefixed route first, same lesson as `/api/photos/unfiled` vs `/:id`).

## Acceptance criteria

Verification legend (consistent with `specs/ai-classification.md`):
- **[Tester-live]** — black-box verifiable by the Tester Agent against the running stack (HTTP + DB inspection allowed).
- **[Developer-verified]** — verified by Developer via code review / unit test where live black-box exercise is impractical or the surface is internal.

**Schema & migration**
- [ ] [Tester-live] `prisma migrate dev` creates `guest_users`, `invite_tokens`, `folder_permissions`, `access_requests`, `guest_sessions` matching this spec; the migration is additive (no existing table altered destructively — verifiable by replaying migrations on a fresh DB and confirming `users`/`photos`/`collections`/`folders`/`sessions` are unchanged).
- [ ] [Developer-verified] Prisma back-relations on `User`/`Folder` add no physical columns to those tables.

**Share creation (owner)**
- [ ] [Tester-live] `POST /api/guests` with valid folders the owner owns returns 201 with a raw `inviteToken` (returned exactly once), creates a `guest_user`, an `invite_token` storing only the SHA-256 hash (raw token never persisted — verified by DB inspection), and one `folder_permission` per folder.
- [ ] [Tester-live] `POST /api/guests` including a `folderId` the owner does NOT own returns 404 and creates NOTHING (no partial guest/token/permission rows).
- [ ] [Tester-live] `POST /api/guests` with an invalid body (empty `folderIds`, bad `permissionLevel`, malformed email) returns 400 before any DB write.

**Access request + OTP (guest → owner)**
- [ ] [Tester-live] `POST /api/invites/:token/request` with a valid raw token returns 200 `{ requestId, status: 'pending' }`, creates a `pending` access_request, captures IP + user-agent, and does NOT return the OTP in the response body.
- [ ] [Tester-live] The mock notification provider, under the test flag, exposes the plaintext OTP for that `requestId` so Tester can read it — and confirms NO real network/email call occurred (offline-verifiable the same way the classifier's offline test proves no network reach).
- [ ] [Tester-live] `POST /api/invites/:token/request` with a garbage/expired/revoked/exhausted token returns a generic 404 (no distinction that would enable token enumeration).
- [ ] [Developer-verified] The stored `otp_hash` is a SHA-256 of the 6-digit code; the plaintext code is never persisted to the DB.

**Approval / deny (owner)**
- [ ] [Tester-live] `POST /api/access-requests/:id/approve` with the correct OTP within 5 min flips the request to `approved`, mints a `guest_session` (hash-only in DB), returns a raw guest token, and invalidates the OTP (a second approve attempt with the same code → 409/401, proving single-use).
- [ ] [Tester-live] A wrong OTP returns 401 and increments `otp_attempts`; the 3rd wrong attempt auto-denies the request (status `denied`, subsequent approves 403) — verified by DB inspection of `otp_attempts` and `status`.
- [ ] [Tester-live] An OTP submitted after 5 minutes is rejected as expired (403/401) even if otherwise correct.
- [ ] [Tester-live] `POST /api/access-requests/:id/deny` sets `denied`; an approve after a deny is rejected.
- [ ] [Tester-live] An owner cannot approve/deny an access_request belonging to a different owner's guest → 404 (not 403).

**Guest portal scoping**
- [ ] [Tester-live] With a valid guest session, `GET /api/guest/folders` returns ONLY the permitted folders (verified against a control folder the owner has that was NOT shared — it must be absent).
- [ ] [Tester-live] `GET /api/guest/folders/:id/photos` for a permitted folder returns photo cards whose image URLs are 60s pre-signed URLs (never a raw `s3Key` — verified by asserting the URL is a signed MinIO URL, not a bare key); for a NON-permitted folder (including one the guest's owner owns but didn't share) returns 404.
- [ ] [Tester-live] `GET /api/guest/photos/:id` for a photo in a permitted folder returns 60s pre-signed original+thumbnail URLs; for a photo in a non-permitted folder → 404; for a photo of a completely different owner → 404.
- [ ] [Tester-live] `GET /api/guest/photos/:id/download` succeeds when the permission level is `download`/`download_all` and is refused when it is `view` only.
- [ ] [Tester-live] All `/api/guest/*` endpoints return 401 with no/invalid/expired guest session cookie.

**Revocation**
- [ ] [Tester-live] After `DELETE /api/guests/:id`, the guest's existing session immediately fails (next `/api/guest/*` request → 401), `folder_permissions` show `revoked_at` set, and a subsequent invite-request with the same token no longer grants access (token `is_active=false`).
- [ ] [Tester-live] `DELETE /api/guests/:id` for another owner's guest → 404, no effect.

**Guest session = opaque, revocable**
- [ ] [Tester-live] Guest session tokens are stored only as SHA-256 hashes; the raw token is not a JWT (verified by confirming it is not a decodable JWT structure), and revocation is enforced server-side (the whole point of opaque tokens).

**Rate limiting**
- [ ] [Tester-live] `POST /api/invites/:token/request` is rate-limited on its own IP-keyed bucket (429 past the limit), independent of the auth/upload/reclassify buckets.

**Ground rules**
- [ ] [Developer-verified] No real email/SMS/cloud provider, no Twilio/SES/SendGrid/Resend dependency, no JWT library; the notification module is a one-file mock swap-in, header-documented as such.

## Success signal

Tester can run the full flow end-to-end against the local stack: owner creates a share for two of their four folders (`download` level, 7-day expiry) → captures the raw invite token → hits `POST /api/invites/:token/request` as an anonymous client → reads the OTP from the mock provider's test-exposed value → owner approves with that OTP → receives a guest token → the guest lists exactly the two shared folders (the other two are invisible), views a photo via a 60s pre-signed URL, downloads it, and is 404'd on a photo in an unshared folder → owner revokes → the guest's very next request is 401. DB inspection confirms: no plaintext OTP or plaintext token ever persisted, `otp_attempts`/`status` transitions correct, all permissions/sessions revoked after the delete. A from-scratch offline check confirms no code path in the notification module can reach the network.

## Pending Decisions (recommended defaults — do NOT silently bake in; confirm or veto)

Roadmap-specified values are used where they exist and marked as such; the rest are genuine ambiguities.

1. **OTP length + TTL + max attempts — ROADMAP-SPECIFIED, using as-is.** Roadmap § 12 "OTP Security Details" fixes: 6 digits via `crypto.randomInt(100000, 999999)`, SHA-256 hash, **5-minute** validity, single-use, **max 3 wrong attempts → auto-deny**. No decision needed unless Abhishek wants to override the roadmap. *Default: roadmap values.*

2. **Guest session lifetime.** Roadmap § 6's `guest_sessions` table has NO `expires_at` column (unlike owner sessions) — only `revoked_at`. But an unexpiring guest session is a security smell, and the invite/permissions carry their own `expires_at`. *Recommended default: add an `expires_at` to `guest_sessions` (deviation from roadmap § 6, flagged) and cap the guest session at **min(24 hours, the earliest folder-permission expiry)** — so a session can never outlive the grant. `GUEST_SESSION_TTL_HOURS` env, default 24.* Veto if guest sessions should live as long as the permission (up to the invite's `expiresAt`) instead.

3. **What unit gets shared — folder vs. collection vs. single photo.** Roadmap § 6 ties `invite_tokens` to a `collection_id` but `folder_permissions` to individual `folder_id`s, and § 14's flow shows the owner selecting *folders*. *Recommended default: the share unit is the **folder** (one or more), which matches `folder_permissions` and the § 14 flow; `invite_token.collection_id` is stored as informational context (the collection the folders belong to) but the real access scope is the set of `folder_permissions`.* No single-photo sharing this pass. Veto if single-photo shares or whole-collection shares are wanted in the MVP.

4. **Does the guest need an email up front, or just a link?** Roadmap § 14's flow has the owner enter the guest's email and the *system emails the guest the link*. But we can't send real email (mock). *Recommended default: owner supplies `guestEmail` (stored on `guest_user`, used as the human label in the owner's guest list and as the addressee the real provider would use post-swap), but since we can't deliver, the **raw invite URL is returned to the owner** in the `POST /api/guests` response for them to share manually (copy-paste / their own channel). The guest is NOT required to prove that email — the OTP goes to the OWNER, not the guest, so the guest only needs the link.* Veto if the guest should be emailed (blocked on real email anyway) or if email should be optional.

5. **`view`-only download refusal — 404 or 403?** House rule is 404-not-403 for *existence/ownership* hiding. But a view-permitted guest legitimately knows the photo exists (they can see its thumbnail) — refusing *download* isn't hiding existence, it's an authorization limit on a known resource. *Recommended default: **403** on `GET /api/guest/photos/:id/download` when permission is `view`-only (the resource's existence is already legitimately known to this guest, so 404 would be misleading), while keeping **404** for photos in folders the guest can't see at all.* Veto if you want a uniform 404 everywhere on the guest surface.

6. **Invite `max_uses` — single-use link or multi-use?** Roadmap § 6 has `max_uses` (null = unlimited) + `use_count`. *Recommended default: an invite is tied to ONE named guest, so `max_uses = 1` by default (one approved access), preventing link-forwarding to strangers; owner can't currently override it (no UI field this pass). A re-click before approval reuses the same pending request rather than consuming a use.* Veto if invites should be freely shareable multi-use links.

7. **How the raw guest token reaches the guest client after approval.** The guest is polling `GET /api/invites/requests/:requestId/status`; the owner approves on a different device/session. Two clean options: **(a)** the approve response returns the raw token to the *owner*, useless to them — bad; **(b)** the status-poll endpoint, upon detecting `approved`, sets the guest session cookie directly on the polling guest's browser and returns `{ status: 'approved' }` (the guest never handles the raw token — the cookie is httpOnly). *Recommended default: **(b)** — mint the guest session at approval time, store its hash keyed to the access_request, and have the guest's own authenticated-by-polling status call claim it (set-cookie) exactly once. This keeps the raw token off the owner's screen and out of any copy-paste path.* This is the one genuinely fiddly bit; flagging explicitly so Developer builds the agreed mechanism, not a guess.

8. **Geo enrichment (`location_city`/`location_country`).** Needs an external IP-geo service we won't wire locally. *Recommended default: omit the geo columns from the migration; capture IP + user-agent (`device_info`) only. Add geo in the Week 11–12 audit pass if wanted.* Veto if the columns should exist now (nullable, unpopulated) to avoid a later migration.

9. **Audit log timing.** Roadmap sequences `audit_log` + `GET /api/audit` into Week 11–12, not Week 9–10. *Recommended default: do NOT build the audit table/endpoint here; route approve/deny/revoke/view/download through single choke-point handlers so Week 11–12 can add logging without refactoring.* Veto if a minimal audit log should ship alongside guest access now.

10. **Re-click on an already-approved / still-pending invite.** *Recommended default: if a live guest session already exists → `{ status: 'already_approved' }` (client re-attaches, no new OTP). If a `pending` request already exists and its OTP is unexpired → return that same `requestId` (don't spam the owner with a fresh OTP per click); if expired → issue a fresh one.* Veto if every click should mint a new request.

11. **Invite-request rate-limit numbers.** Its own IP-keyed bucket (per the one-bucket-per-group rule). *Recommended default: request endpoint **10 / 15 min / IP**; status-poll **120 / 15 min / IP** (accommodates ~3s polling for ~6 min); both relaxed under `NODE_ENV=test`. OTP wrong-attempt cap stays at 3 on the row itself.* Numbers open to veto.

12. **Permission-level granularity — do we need `download_all` distinct from `download` in this pass?** Roadmap lists three levels (`view`/`download`/`download_all`), but `download_all` (bulk/zip download) has no endpoint in § 11's guest portal beyond per-photo download. *Recommended default: store all three levels (so the data model is roadmap-complete), enforce `view` vs `download` on the per-photo download endpoint, and treat `download_all` as ≥ `download` for now (a bulk-zip endpoint is deferred — no `GET /api/guest/folders/:id/download-all` this pass).* Veto if bulk folder download must ship in the MVP.
```
