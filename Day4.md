# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Note: this repo has a root `CLAUDE.md` (multi-agent orchestration workflow) plus `Day1.md` (auth + upload baseline), `Day2.md` (AI-classification backend), and `Day3.md` (organize/browse/dashboard UI + Next.js 14.2.35 bump + the Guest Access **backend**). This file covers only what was built **after** Day3.md, on `feature/ai-classification` (commits `a2cfb3f` → `2b4d113`, all now pushed): the Guest Access **frontend** — the three UI pages that Day3.md said were wireframed-but-not-built — and two instructive bugs found and fixed in them. Read Day3.md first for the guest-access data model, the `getPermittedFolderIds` scope choke point, the mock-OTP interface, and the G7 poll-claim token handoff; this file assumes all of that and only covers the client layer on top of it.

## What Day 4 added, in one sentence

The Guest Access backend from Day3.md got its three frontend pages — an owner share-creator, an owner approval/management feed, and a public guest portal — completing Week 9–10 end-to-end, with two bugs (an over-broad 401→login redirect, and a returning-guest dead-end) caught by the Tester and fixed.

## Commands

No new commands, scripts, migrations, or dependencies this session — this was pure frontend built on the existing backend. `Day3.md`'s command list is unchanged. Note the two guest-access `.env` vars from Day3.md still matter for local testing (`NOTIFICATIONS_EXPOSE_OTP=true` to read OTPs, `GUEST_SESSION_TTL_HOURS`).

## Architecture additions (all under `frontend/src/`)

Three new pages + additive API-client groups + a new block of CSS classes. Backend was **not touched** this session (the guest-access routers were already security-verified in Day3.md's cycle — 68/68 live + 71/71 suite; no reason to reopen them).

### `lib/api.ts` — four new client groups

Following the existing `apiFetch`/typed-`ApiError`/`credentials:"include"` conventions exactly (see Day1.md), four groups were added: `guestsApi` (owner: create/list/revoke shares), `accessRequestsApi` (owner: list/approve/deny), `invitesApi` (public: request access, poll status), and `guestPortalApi` (guest-session-scoped: folders, folder photos, photo detail, download). The split mirrors the backend's four routers and the two distinct auth contexts (owner cookie vs. guest cookie) — don't collapse them into one object.

### `/share` (`app/share/page.tsx`) — owner, authed

Wireframe Option B: a dedicated two-column page. Left = folder multi-select (fetched via the same `collectionsApi.list()` → `foldersApi.list()` chain `/organize` and `/dashboard` use) with a live "N folders · M photos selected" tally; right = guest email + permission level (`view`/`download`/`download_all`) + expiry + a "Generate invite link" button that calls `POST /api/guests` and surfaces the returned raw `inviteToken`/`inviteUrl` with a Copy button. Auth-gated the same client-side way as every other owner page (`authApi.me()` on mount → redirect to `/login` on 401).

### `/guests` (`app/guests/page.tsx`) — owner, authed

Wireframe Option C: a single prioritized feed. Pending access-requests float to the top (each card shows guest email + captured IP/device + a 6-digit OTP input + Approve/Deny); the guest roster (Active/Pending/Revoked pills + one-tap Revoke) flows below in the same stream. Reached via a "Guests" link folded into the `/dashboard` top bar (the app still has no persistent nav shell — this matches how logout was folded in rather than building one). **The 401-handling in this file is load-bearing and non-obvious — see BUG-1 below before touching `handleApprove`/`handleDeny`.**

### `/g/[token]` (`app/g/[token]/page.tsx`) — PUBLIC guest portal, one page, a state machine

This is the most novel page in the app and the one to read carefully. It is **one route with an internal state machine**, not multiple routes — wireframe Option B (preview-first) was explicitly picked, and splitting it into pages would silently revert that decision.

`PortalState = 'probing' | 'landing' | 'waiting' | 'unlocked'`:
- **`probing`** (initial, added by the BUG-2 fix): on mount, make exactly ONE guest-scoped call — `guestPortalApi.folders()`. `200` → the visitor already holds a live guest session → jump straight to `unlocked`. `401`/anything-else → fall through to `landing`. This is what makes a returning approved guest land in their photos without re-requesting.
- **`landing`**: a static, **decorative** locked-preview grid (gray tiles + lock icons, no data behind them) + a "Request access" button → `POST /api/invites/:token/request` → moves to `waiting`.
- **`waiting`**: polls `GET /api/invites/requests/:requestId/status` every `POLL_INTERVAL_MS = 5000` (deliberately under the backend's 120/15min/IP status-poll budget from Day3.md). On `approved` (the poll response is also what sets the httpOnly guest cookie, per Day3.md's G7 handoff — the fetch must send credentials) → `unlocked`. On `denied`/`expired` → a clear message + "Request again".
- **`unlocked`**: the ONLY state that fetches real data — `guestPortalApi.folders()` → folder photos → photo detail, with a Download button shown per-photo **only** when the folder's permission is `download`/`download_all` (hidden, not disabled, for `view`-only).

**This route deliberately does NOT use the owner auth-gate pattern** — no `authApi.me()`, no redirect to `/login`. It's for anonymous visitors. If you add logic here, do not import the owner-session gate.

**`PhotoViewer` (Day3.md's shared owner component) was intentionally NOT reused here** — its fetch/prop contract is hard-wired to owner-scoped `photosApi.get()` and owner-only statuses (`failed`/`duplicate`) that don't exist in the guest's world. A minimal guest-scoped viewer is inlined in this page instead. Don't try to force `PhotoViewer` to serve both; the coupling would leak owner-only assumptions into the guest surface.

### THE PRIVACY CONSTRAINT — the single most important rule on the guest portal

Option B shows a "preview" before approval; Abhishek accepted that **only** on the condition that nothing real leaks. Enforced and Tester-verified (via live network inspection, not code review): in `probing`/`landing`/`waiting`, the page fetches **zero** real image/thumbnail/pre-signed-URL data and renders **zero** real `<img>` elements — only decorative placeholder tiles. Real `guestPortalApi.*` image data is fetched **only** in `unlocked`. The load-time probe is privacy-safe precisely because a no-session visitor gets `401` and stays in `landing` with nothing behind the tiles. **If you ever make the pre-approval preview "nicer" by fetching a real (even blurred) thumbnail, you have broken the constraint** — the blur must be decorative-only, never real photo bytes. The backend enforces this too (no guest session → 401 on every `/api/guest/*` route), so there is genuinely nothing to fetch pre-approval; keep it that way.

## The two bugs — read these before touching the guest-access frontend

### BUG-1 [was High, ship-blocking] — "any 401 → /login" is wrong on this app's action endpoints

`guests/page.tsx`'s `handleApprove` originally treated the approve endpoint's `401 "Invalid code"` (a wrong OTP) as an owner-session-loss and did `router.replace("/login")` — so a single mistyped digit ejected the owner off the page, and the 3-wrong-attempt auto-deny state was unreachable.

**The fix, and the reusable lesson:** in this codebase `apiFetch` surfaces a `401` for *both* "your session is gone" *and* "this operation was rejected" (wrong OTP). **Key the redirect decision on WHICH call 401'd, not on the status code.** Concretely, in `guests/page.tsx`: the `authApi.me()` gate, the `load()` list calls (`GET /api/access-requests`/`/api/guests`), and `handleRevoke` keep the `isAuthError → /login` branch (a 401 there genuinely means logged-out); but `handleApprove`/`handleDeny` deliberately have **no** such branch — their 401 (`Invalid code`) and 403 (`request denied`/`expired`) are business responses shown **inline** on the request card, staying on the page (a 403 also refreshes the list so the now-terminal request drops out). The `isAuthError` helper carries a comment saying exactly this. Any new owner action endpoint that can return 401/403 as a business response must follow this — do not add a blanket 401→login catch.

### BUG-2 [was Medium, spec-collision] — returning approved guest hit a 404; fixed on the frontend, backend/spec untouched

A guest who had already been approved, revisiting `/g/:token` and clicking "Request access", got `404 "Invite not found"` — because `max_uses=1` (decision G6) + the `use_count` bump makes the invite "exhausted", and the backend's exhaustion-404 check fires *before* the already-approved branch, exactly as the spec's API table orders it.

**Master's decision (recorded, not a silent change):** G6's intent is to stop a *forwarded link reaching a stranger*, NOT to lock out the legitimate returning guest. The backend ordering is correct and secure and was left **untouched**; the fix is the frontend `probing` state above — a returning guest with a live session is detected on load and routed straight to `unlocked`, so they never hit the re-request path. A forwarded link reaching a session-less stranger still correctly 404s (single-use preserved). The genuinely-spent-invite 404 now shows a clear "this link has already been used or is no longer active — ask the owner for a new one" message instead of a raw error. This is the general pattern for a "spec says X, UX wants Y" collision in this project: fix it in the layer that doesn't compromise the security-tested invariant, and write the decision down.

## Testing (additions to Day1–3)

Still **no automated frontend tests** — verification remains live Playwright-via-Tester-subagent + typecheck/lint/build, same gap as Day1–3. This session's two Tester reports:
- `reports/2026-07-05_2015.md` — first regression on the three pages: privacy constraint PASS (adversarial network inspection), happy path PASS, but found BUG-1 and BUG-2.
- `reports/2026-07-05_2025.md` — fix-verification: 30/30, both bugs fixed, privacy constraint still holds after the new probe, backend suite unchanged at **71/71**. Verdict: Guest Access UI ship-ready.

## Known gotchas / operating notes (not bugs)

- **Never run `next build` while `next dev` is live on the same `.next` dir** — it corrupts the dev server's route manifest (routes start 404ing). This bit two subagents this session. If you must build, stop `next dev` first, or build in a throwaway checkout. Recovery: kill dev, `rm -rf frontend/.next`, restart `npm run dev`.
- The portal's load-time probe **fires twice on mount in dev** — React 18 StrictMode double-invoke. Both are harmless `401`s (or both `200`s); it single-fires in a production build. Don't "fix" it with a ref-guard unless it actually causes a problem.
- Guest-portal fetches must send credentials (they use `apiFetch`, which already sets `credentials:"include"`) — the `approved` poll response is what sets the guest cookie (G7), so a non-credentialed fetch would silently never establish the session.

## Where things stand after Day 4

Week 1–10 of the roadmap is now **built, tested clean, and pushed** to `feature/ai-classification` (through `2b4d113`; `master`/`main` still doesn't exist on the remote, no PR). Zero open bugs. The next roadmap horizon is **Week 11–12 (Audit log + polish)** — the guest-access build already left choke-point hooks for the audit log (spec decision G9); see `agents/STATUS.md`. The backend's 12 flagged guest-access decisions (G1–G12) remain open for veto but have been built-on and tested. `reports/mr-drafts/guest-access-ui.md` has the full frontend build + fix history.
