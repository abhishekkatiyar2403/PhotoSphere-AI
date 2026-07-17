# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Note: this repo already has a root `CLAUDE.md` (multi-agent orchestration workflow), `Day1.md` (auth + upload-pipeline baseline, commit `74d1f4b`), and `Day2.md` (AI-classification backend, `feature/ai-classification` commits `8f1f065`…`27afa75`). This file covers everything built since Day2.md, on the same branch, through commit `79da87b`: the reclassification/organize UI, the read-only folder browser + shared photo viewer, the dashboard, a Next.js security bump, and the full backend of Week 9–10 Guest Access + OTP. Read Day1.md and Day2.md first; this file only covers what's new or changed since Day2.md.

## What Day 3 added, in one sentence

The AI-classification backend from Day2.md got its UI (organize, browse, dashboard), the framework got a security patch, and a second major subsystem — guest sharing with OTP-gated approval — was scoped, built, and adversarially security-tested end to end, with its three UI surfaces wireframed and picked (backend built; frontend not yet built).

## Commands (additions/changes to Day1.md/Day2.md's list)

```bash
# Third migration on top of Day1's baseline + Day2's classification migration
# backend/prisma/migrations/20260703215312_add_guest_access_otp/
npx prisma migrate deploy   # replays all 4 migrations cleanly on a fresh DB (verified)

# Guest-access test files (vitest filename filter, same convention as Day1/Day2)
npm run test -w backend -- guest-access.smoke      # live e2e: full share->OTP->guest-session->revoke flow
npm run test -w backend -- notifications.offline   # proves the mock OTP module can't reach the network

# Two new .env vars (backend/.env, gitignored — set these on a fresh checkout)
GUEST_SESSION_TTL_HOURS="24"        # guest session cap; also bounded by the sharing folder's own expiry
NOTIFICATIONS_EXPOSE_OTP="false"    # "true" ONLY for local dev/testing — exposes the mock OTP via a dev-only endpoint

# Frontend now has 4 real pages beyond auth (frontend/src/app/): dashboard, organize, browse, upload
```

`next` and `eslint-config-next` are now `14.2.35`, not `14.2.13` (Day1/Day2's version) — see "Next.js bump" below before assuming a lint/type behavior from Day1/Day2 still applies verbatim.

## Architecture additions

### The organize UI + a structural bug it exposed

`frontend/src/app/organize/page.tsx` — sidebar folder tree with live counts, inline folder creation, paginated photo grid with three card states (normal/failed/duplicate), a per-card "Move to…" dropdown, and a reclassify action. This is the first UI built against Day2's classification backend.

**The bug worth knowing about:** `failed`/`duplicate` photos have `folderId: null` forever (Day2's dedup gate and failed-pipeline paths both short-circuit before folder assignment) — so they were only reachable via a *collection-scoped* "Unfiled" endpoint, which doesn't exist yet for a brand-new user who has never had a folder created. A user whose very first upload happened to fail or dedupe had that photo permanently stuck, invisible, unrecoverable. Fixed by adding a genuinely **user-scoped** `GET /api/photos/unfiled` (collection-independent — `routes/photos.ts`), which is now the one you should call for "show me everything not yet filed," not the older collection-scoped variant that nothing else calls. This is the same shape of lesson as Day2's dedup-cycle bug: the failure mode only shows up before the "normal" happy-path state (a folder, a collection) has ever been created — **when building anything for this app, explicitly test the zero-state, not just the populated state.**

A second latent bug fixed in the same pass: the sidebar's known collection id stayed `null` after a user's *first-ever* successful reclassify, so a newly-auto-created folder existed server-side but never appeared without a manual reload.

### Browse (`/browse`) + shared `PhotoViewer` — read-only, not a mode flag

`frontend/src/app/browse/page.tsx` is a **genuinely separate route** from `/organize`, not `/organize` with a `readOnly` prop — deliberate: `/organize`'s state model is tightly coupled to editable-grid concerns (per-card mutation state, poll timers) that a read-only mode would have to thread a flag through everywhere, leaving untested dead paths live. `/browse` reuses the same visual pattern and the "Unfiled" concept but has zero mutation surface (no move dropdown, no reclassify button, no folder creation) — verified read-only two ways in every Tester pass: DOM absence of controls *and* network monitoring showing zero PATCH/POST fired.

`PhotoViewer` (new shared component, used by both `/browse` and `/organize`) is fullscreen image + EXIF panel + prev/next scoped to the current page + three independent close methods (X/Escape/backdrop-click). If you're adding a new photo-viewing surface, use this component rather than building another fullscreen view.

`/browse` also carries a minimal `?folder=<id>` deep-link param (Suspense-wrapped `useSearchParams`, honored once on initial load, never overrides a later sidebar click) — this exists specifically so the Dashboard's folder tiles can land on the right folder. **Next.js 14's App Router requires `useSearchParams()` to sit inside a `<Suspense>` boundary or the production build fails** — if you add another page that reads query params, wrap it the same way `BrowsePageInner` is wrapped here.

### Dashboard (`/dashboard`) — data assembly is deliberately backend-light

`GET /api/dashboard` (`routes/dashboard.ts`) returns storage usage (BigInt-safe strings, server-computed `usedPercent`) and per-**collection** totals — but the Dashboard page's folder-shortcut tiles need a per-**folder** breakdown, which that endpoint doesn't carry. Rather than reshape the endpoint, the page assembles tiles client-side from endpoints that already exist (`GET /api/collections` → `GET /api/collections/:id/folders` + `GET /api/photos/unfiled`), the same multi-fetch-on-mount pattern `/organize` already uses. **This is the pattern to follow for a future page that needs a cross-cutting view**: prefer composing existing endpoints over widening one endpoint's shape, unless the composition becomes a genuine N+1 problem.

Storage-meter and byte formatting are both defensive by construction: `usedPercent` is clamped to `[0,1]` client-side even though the server already caps it, and `formatBytes()` returns `"0 B"` for any non-finite/negative/missing value rather than rendering `NaN`. The empty state (brand-new user, zero photos) was specifically re-verified clean after the `/organize` bug above — it does **not** repeat that failure mode.

### Next.js security bump: 14.2.13 → 14.2.35 (patch only, not a major)

`npm audit`'s suggested fix (`npm audit fix --force`) jumps to **Next 16** — a breaking App-Router/RSC-semantics migration. That was deliberately **not** taken. Instead `next`/`eslint-config-next` were bumped to `14.2.35`, the newest patch on the *same* 14.2.x line: zero source changes needed, `next build`/typecheck/lint all clean on the first run. This closed the one **critical** advisory (an authorization-bypass CVE) plus 9 others; **14 advisories remain and are only closeable by the Next 15→16 major migration**, which stays an explicit, separate, not-yet-approved decision (tracked in `agents/STATUS.md`'s Pending Decision #16) — don't casually run `npm audit fix --force` in this repo, it will silently attempt that migration.

**Operational lesson, not code:** the local dev processes (`tsx watch src/server.ts`, `src/worker.ts`, `next dev`) accumulate duplicates across sessions if a prior session's watcher is never killed before a new one starts — by the time this was noticed, there were multiple stale `server.ts` watchers idle in the process list (only one can ever bind the port, so it's silently harmless, but it pollutes `ps aux` and once raised a real question of "is a second worker double-processing BullMQ jobs" that had to be checked). If you start a dev server in a new session, check `lsof -nP -iTCP:4000` / `:3000` first rather than assuming a fresh `npm run dev` is the only one running.

### Guest Access + OTP backend — the major new subsystem (spec: `specs/guest-access-otp.md`)

This is Week 9–10 of the roadmap: an owner shares specific **folders** with a guest via an invite link; the guest requests access; a 6-digit OTP goes to the **owner** (not the guest) for real-time approval; on approval the guest gets a scoped, revocable session. Backend + data model only — **no frontend page exists yet** for this (see "UI wireframes" below).

**Schema — 5 new additive tables** (`backend/prisma/schema.prisma`, migration `20260703215312_add_guest_access_otp`): `GuestUser`, `InviteToken` (SHA-256 hash of the raw token, never the raw token, stored), `FolderPermission` (`view`/`download`/`download_all`, `revokedAt`/`expiresAt`), `AccessRequest` (the OTP challenge: hash, expiry, attempt counter, status), `GuestSession` (mirrors `Session` — opaque, hash-only). Two virtual back-relations on `User`/`Folder`, no physical columns added to existing tables.

**Guest auth is a parallel, separate system from owner auth — not a branch inside it.** `lib/guestSession.ts` mirrors `lib/session.ts` one-to-one (same `crypto.randomBytes(32)` → SHA-256-hash-to-DB pattern as Day1's owner sessions) but uses its own cookie name (`photosphere_guest_session`, distinct from `photosphere_session`) so an owner previewing their own share and a guest session can coexist in one browser. `middleware/requireGuest.ts` mirrors `requireAuth` but attaches `req.guest`, not `req.user`. **Do not merge these into one helper "for DRY" — they're kept separate on purpose, the same way the auth and upload rate limiters are kept separate in Day1.**

**The single scope choke point: `getPermittedFolderIds(guestUserId)`.** Every guest-facing query (`routes/guest.ts`) filters against this one function's result — the set of folder IDs with a *live* permission (`revokedAt` null AND `expiresAt` null-or-future). This is what makes cross-folder leakage structurally impossible rather than something each endpoint has to remember to check individually. **If you add a new guest-facing endpoint, it must filter through this function, not re-derive its own permission check.**

**OTP delivery is mocked behind a swappable interface, exactly mirroring Day2's classification provider pattern.** `lib/notifications/index.ts` exports a `NotificationProvider` interface + `MockNotificationProvider` — no real email/SMS/Twilio/SES/SendGrid, ever, until explicitly approved (same ground rule as "no real Vision API" in Day1/Day2). The plaintext OTP is only ever readable via a **flag-gated, dev-only endpoint** (`GET /api/invites/requests/:requestId/otp`, active only when `NOTIFICATIONS_EXPOSE_OTP="true"` or `NODE_ENV=test`) — it 404s otherwise. This is the mechanism that lets the guest-access.smoke test (and a live Tester pass) exercise the *entire* approve flow without DB access. **Keep `NOTIFICATIONS_EXPOSE_OTP` at `"false"` outside local dev/test** — it was flipped `true` once for live testing and flipped back is the expected state.

**The one genuinely non-obvious design decision: how the raw guest token reaches the guest's browser.** The spec's naive approach (return the raw token in the owner's `approve` response) is useless — the owner isn't the guest. The actual mechanism: the guest's own `GET /api/invites/requests/:requestId/status` poll is what mints and hands back the session, via a claim-once latch (a `session_claimed_at` column) — because a raw token can't be recovered from the SHA-256 hash stored in the DB at approval time, it has to be minted at the *poll* that first observes `approved`, not at approval itself. This is a deviation from the spec's original phrasing but preserves its actual intent (raw token never shown to the owner, never persisted in plaintext, single-use). If you touch the approve/status endpoints in `routes/invites.ts` and `accessRequests.ts`, read this mechanism before changing it — it's easy to accidentally reintroduce a "return the token from approve" shape that doesn't work.

**Security properties, all adversarially verified live (not just code-reviewed) before this was trusted:** OTP is single-use (a second approve attempt with the same code fails even if otherwise correct), capped at 3 wrong attempts before auto-deny, expires in 5 minutes; a guest 404s (not 403s) on any folder/photo outside their permitted set *and* that folder is absent from their folder list, not just access-denied; cross-owner access-request approve/deny/revoke all 404 (owner A cannot act on owner B's guest, full stop); revoking a guest cuts off their *next* request immediately, not eventually; invite tokens use a generic 404 for garbage/expired/exhausted alike (no enumeration signal); images are still 60s pre-signed URLs, a guest never receives a raw storage key, exactly like the owner-facing photo endpoints in Day1.

**Rate limiting is its own bucket:** `middleware/inviteRateLimiter.ts` — the public, unauthenticated `POST /api/invites/:token/request` is the highest-abuse surface in the app (no session gate at all), so it gets an independent IP-keyed bucket from both the Day1 auth limiters and the upload limiter, per this codebase's established "don't share buckets across concern areas" convention.

**No BullMQ for OTP** — deliberately synchronous (generation + mock "send" are instant; there's no slow I/O to hide behind a queue the way the Day1 upload pipeline needs one). If real email is ever wired in and proves slow, that's a contained change inside `lib/notifications/index.ts`, not a reason to add a queue now.

### UI wireframes: 4 picked, 3 more awaiting a frontend build

Following this repo's UI-decision protocol (root `CLAUDE.md`): the **Dashboard page shipped this session as Option B** (storage-meter hero + folder shortcut tiles + at-a-glance totals; record at `design/wireframes/dashboard.svg`). For Guest Access, three more surfaces were wireframed (2–3 SVG options each, presented as a rendered comparison) and picked, but **not yet built**:

- **Share panel → Option B**, a dedicated `/share` page (two-column: folder multi-select left, permission/expiry/link right). Record: `design/wireframes/share-panel.svg`.
- **Guest management → Option C**, a single prioritized feed (pending OTP-approval requests float to the top under an attention banner; the guest roster with one-tap revoke flows below in the same stream). Record: `design/wireframes/guest-management.svg`.
- **Guest portal → Option B**, preview-first: locked/blurred thumbnails shown to the guest *before* approval, with a status bar that swaps request→waiting→unlocked in place. Record: `design/wireframes/guest-portal.svg`.

**Read this before building the guest portal:** Option B's pre-approval "preview" must render **only decorative locked/blurred placeholder tiles** — never a real image, never a working pre-signed URL — until a guest session actually exists. The backend already guarantees this naturally (no guest session → 401 on every `/api/guest/*` route → no pre-signed URL is ever issued pre-approval), but the frontend build must not "helpfully" fetch or cache a real thumbnail early to make the preview look nicer. This was a deliberate, flagged privacy trade-off (showing *any* preview of private photos pre-approval), not an oversight — don't silently relax it.

## Testing (additions to Day1.md/Day2.md)

Two new backend test files, same skip-not-fake discipline as Day1/Day2:
- **`guest-access.smoke.test.ts`** — live end-to-end: owner creates a share → anonymous invite request → OTP read via the flag-gated dev endpoint → owner approves → guest session established via the poll-claim mechanism → guest lists/views/downloads exactly the shared folders → 404 on unshared → owner revokes → guest's next request 401. Plus the adversarial branches: wrong-OTP-3x auto-deny, expired OTP, double-approve, cross-owner 404s.
- **`notifications.offline.test.ts`** — mirrors Day2's `classification.offline.test.ts` pattern: stubs every network entry point, proves the mock notification module cannot reach a real service.

Backend suite is now **71/71** (was 56/56 at the end of Day2's cycle; +15 for guest access). No new frontend automated tests — verification of the four shipped pages (`/dashboard`, `/organize`, `/browse`, `/upload`) has been manual/Playwright-via-Tester-subagent, same as Day1/Day2's stated frontend testing gap.

## Known accepted trade-offs (not bugs — read the reasoning before "fixing")

- **Guest sessions have an `expires_at` the roadmap's own schema doesn't specify** — added deliberately (an unexpiring session is a smell) and capped at `min(24h, the earliest live folder-permission's expiry)`, so a session can never outlive the grant that justified it.
- **Sharing is folder-level only** — no single-photo shares, no whole-collection shares, in this pass. `InviteToken.collectionId` is stored as informational context only; `FolderPermission` rows are the actual enforced scope.
- **Invites are single-use by default** (`maxUses = 1`) — tied to one named guest, not a freely-forwardable link, with no UI override yet.
- **No audit log yet** — deliberately deferred (the roadmap sequences it into Week 11–12), but every approve/deny/revoke/view/download call already passes through a single choke-point handler per action, specifically so audit logging can be added later without a refactor.
- **`download_all` is stored as a permission level but has no bulk/zip endpoint** — treated as `≥ download` for now; per-photo download only.

## Where to look next

- `specs/guest-access-otp.md` — the full spec this was built against, including 12 explicitly-flagged decisions (G1–G12: OTP numbers, session lifetime, share-unit granularity, the token-handoff mechanism, rate-limit numbers, etc.) with stated defaults — check it before assuming a number here is arbitrary, same discipline as Day2's classification spec.
- `reports/mr-drafts/guest-access-otp.md` — build history + the three flagged deviations (the poll-claim handoff, the dev-only OTP endpoint, the two new env vars).
- `reports/2026-07-04_0358.md` — the adversarial security-test report; read this before touching any guest-auth code, it documents exactly what was proven and how.
- `agents/STATUS.md` — current live status: the Guest Access backend is built and tested clean; the three wireframed UI surfaces (share panel, guest management, guest portal) are picked but **not yet built** — that's the next buildable unit of work on this branch.
