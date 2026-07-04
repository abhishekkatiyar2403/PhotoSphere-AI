# MR Draft: Guest Access + OTP — frontend (share / guests / guest portal)

**Branch:** `feature/ai-classification` (not pushed — local only, per standing rule)
**Commit:** `a2cfb3f`
**Built against:** `specs/guest-access-otp.md` (backend already built + adversarially security-tested clean, commit `dad0b74`, report `reports/2026-07-04_0358.md`), and the three already-picked wireframes (`design/wireframes/share-panel.svg`, `guest-management.svg`, `guest-portal.svg`).
**No backend files touched.**

## Summary

Ships the three frontend surfaces Week 9–10 (Guest Access + OTP) was missing: an owner "create a share" page, an owner approval/guest-management page, and a public guest portal. All three consume the existing, already-tested backend endpoints verbatim — no API shape changes were needed.

## What was built

### 1. `frontend/src/app/share/page.tsx` — owner, authed
Two-column layout per `design/wireframes/share-panel.svg` (Option B). Left: a checkbox folder picker (sourced the same way `/organize`/`/dashboard` already do — `collectionsApi.list()` → default collection → `foldersApi.list()`), a "Select all" toggle, and a running "N folders · M photos selected" tally computed client-side from the selected folders' own `photoCount`. Right: guest email, permission-level select (`view`/`download`/`download_all`), expiry select (7/30/90 days or never), and "Generate invite link" → `POST /api/guests`. On success, the raw `inviteUrl` is shown in a readonly input with a Copy button (`navigator.clipboard`, with a silent no-op fallback if the Clipboard API is unavailable rather than a hard failure). Auth-gated identically to `/dashboard`/`/organize`/`/browse` (`authApi.me()` → redirect to `/login` on 401).

Unfiled photos are deliberately excluded from the folder picker — `folder_permissions` are keyed on a real folder id (spec decision G3), and Unfiled photos have `folderId: null`, so they cannot be shared this pass. Not a gap; a structural consequence of G3.

### 2. `frontend/src/app/guests/page.tsx` — owner, authed
Single prioritized feed per `design/wireframes/guest-management.svg` (Option C). An attention banner + pending-request cards float to the top (`GET /api/access-requests?status=pending`), each showing the guest email, the folders they requested (cross-referenced from the roster fetch, since the access-request payload itself doesn't carry folder names), IP/device, a relative "requested N min ago" timestamp, a 6-digit OTP input (digits-only, max length 6), and Approve/Deny buttons (`POST /api/access-requests/:id/approve` with `{otp}` / `.../deny`). Below, in the same stream: the full guest roster (`GET /api/guests`) with status pills (`active`/`pending`/`revoked`/`expired`) and a one-tap Revoke (`DELETE /api/guests/:id`) — hidden once a guest is already `revoked` rather than left clickable-but-idempotent, since a second click has nothing left to do. A "+ Share new folders" link in the header reaches `/share`.

### 3. `frontend/src/app/g/[token]/page.tsx` — guest, PUBLIC
This route does **not** run the owner auth-gate pattern at all — no `authApi.me()` call, no redirect to `/login`. Verified live: visiting it with zero cookies, and even with a garbage token, renders normally and never redirects.

Single page, local state machine (`'landing' | 'waiting' | 'unlocked'`) per `design/wireframes/guest-portal.svg` (Option B):
- **landing** — a decorative locked-preview grid (6 static gray/lock tiles, fixed count, no data behind it) + "Request access" → `POST /api/invites/:token/request`. On the `already_approved` short-circuit response, skips straight to `unlocked` without going through `waiting` at all (per spec decision G10). On any other failure (invalid/expired/exhausted token, 429), shows an inline message and stays on `landing`.
- **waiting** — polls `GET /api/invites/requests/:requestId/status` every 5 seconds. On `approved`, moves to `unlocked`. On `denied`/`expired`, moves back to `landing` with a message and a "Request again" affordance that resets local state so the guest can start over. A transient fetch failure on one poll tick is swallowed silently and the interval just retries, rather than tearing down the waiting UI on one bad tick.
- **unlocked** — fetches the real scoped data for the first time: `GET /api/guest/folders`, then `GET /api/guest/folders/:id/photos` for the selected folder (folder chips to switch between shared folders), and a photo detail view via `GET /api/guest/photos/:id`. A Download button (`GET /api/guest/photos/:id/download`) appears per photo, but only when the folder's permission level is not `view` — verified live that it's absent from the DOM entirely for a `view`-only guest, not merely disabled, matching the wireframe's "(hidden if view-only)" note.

## Poll-interval choice

**5 seconds**, chosen against the backend's own `120 requests / 15 min / IP` budget on the status-poll endpoint (spec decision G11). At 5s, a guest polling continuously for the full 15-minute window uses 180 requests — over the raw 120 cap in the worst case, but the realistic ceiling is far lower: the OTP itself expires in 5 minutes (G1), so a guest is only ever polling for at most ~5 minutes before the request resolves (approved/denied/expired) and polling stops — that's 60 requests, comfortably under budget with headroom for a "request again" retry in the same 15-minute window. Chose a round, unhurried number over cutting it close to the limit; nothing in the spec or wireframe calls for faster than a few seconds.

## PhotoViewer reuse decision

**Built a minimal guest-scoped equivalent inline in `/g/[token]/page.tsx` rather than reusing the shared `PhotoViewer` component.** Reasoning: `PhotoViewer`'s data-fetching is hard-wired to `photosApi.get()` (`GET /api/photos/:id`, the owner-scoped endpoint) and its `ViewerPhotoRef`/`PhotoDetail` shapes carry owner-only concerns (`folder.name` on the full owner folder object, duplicate/failed status labels that don't exist on the guest side — a guest never sees a `failed`/`duplicate` photo, only `done` ones inside a permitted folder). Threading a guest-vs-owner branch through the shared component's single fetch call and its status-label logic would have cost more than the ~90 lines of guest-scoped markup + a small `guestPortalApi.photo()`-backed effect built directly in the portal page — the same judgment call `/browse` made for its read-only photo card (`ReadOnlyPhotoCard`, not a mode flag on `/organize`'s `PhotoCard`). The guest viewer reuses the same `.viewer-*` CSS classes wholesale (visually identical fullscreen overlay + info panel), it just doesn't share the component's fetch/prop contract. Deliberately dropped prev/next navigation and EXIF GPS display from the guest viewer (not in the wireframe, not required by the spec) — kept to filename, date-taken, camera, and the download button.

## Privacy constraint — explicit verification

The build brief's hard constraint (never fetch or render a real image/thumbnail/pre-signed URL before a guest session exists) was verified live with Playwright, not just code-reviewed:
- A guest visiting the invite link and taking **zero action** for several seconds fires **zero** `/api/*` requests of any kind (confirmed via network-request logging on the page).
- The locked-preview grid contains **zero `<img>` elements** — it's `PREVIEW_TILE_COUNT` (6) static `<div>` tiles with a CSS gradient + a lock glyph, not derived from any fetch.
- `/api/guest/folders` and `/api/guest/folders/:id/photos` are only ever called after the state machine reaches `unlocked` (confirmed by the request log timestamps relative to the approval action).
- A `view`-only guest's unlocked grid renders zero download buttons (confirmed by DOM query, not just CSS `disabled`).

## Entry-point decision

Added a "Guests" link into `/dashboard`'s top bar, immediately to the left of the existing user-name/"Log out" cluster (`.dashboard-guests-link`, same visual treatment as the logout button — outlined, transparent, on the primary-color top bar). Reasoning: the app has no persistent nav shell yet (deliberately deferred, per Pending Decision from the Dashboard-page cycle), and logout is already "folded into the top bar" rather than given its own nav element — the Guests link follows that exact precedent rather than introducing a new pattern. `/guests` itself then has its own "+ Share new folders" link to `/share`, so the two owner pages are reachable from each other without a second dashboard entry point.

## Deviations from spec/wireframes

None structural. Two small, flagged judgment calls, both scoped to this frontend build only:
1. **`download_all` is presented in the `/share` permission-level dropdown with an explicit label ("Download all — same as download this pass")** rather than hiding it, since the backend stores and accepts it (spec decision G12: `download_all` is treated as ≥ `download`, no bulk-zip endpoint yet) — surfacing it honestly rather than pretending it doesn't exist, while being clear in the UI copy that it behaves identically to `download` for now.
2. **The pending-request card's "wants Food, Nature (download)" folder-name line is derived by cross-referencing the roster fetch** (`GET /api/guests`) against the pending request's `guest.id`, since `GET /api/access-requests` itself doesn't return folder names on the request payload — no backend change made for this; if the roster fetch is slow/fails independently of the pending-request fetch, that line silently omits the folder names rather than blocking the OTP-entry UI, which still works from the IP/device/timestamp alone.

No veto needed on backend behavior — nothing about the backend's contracts changed.

## Verification

- `npm run typecheck -w frontend` — clean.
- `npm run lint -w frontend` — clean (`✔ No ESLint warnings or errors`).
- `npm run build -w frontend` — clean production build; all three new routes present (`/share`, `/guests`, `ƒ /g/[token]` — correctly dynamic, no Suspense issue since `[token]` is a route param, not a query string).
- **Live end-to-end verification via Playwright against the running stack** (backend `:4000`, frontend `:3000`), through real browser clicks in separate owner/guest browser contexts (separate cookie jars):
  - Owner signs up → uploads → `/dashboard` → clicks "Guests" → `/guests` → clicks "+ Share new folders" → `/share` → selects a folder (tally updates correctly, e.g. "1 folder · 1 photo selected") → fills guest email + permission + expiry → generates a link.
  - Guest (separate context) opens the invite link → sees the locked preview (6 decorative tiles, zero `<img>`, zero API calls pre-click) → clicks "Request access" → moves to the waiting spinner.
  - Owner sees the pending request appear on `/guests` under the attention banner, reads the OTP via the same dev-only endpoint Tester uses (`GET /api/invites/requests/:id/otp`, never scraped from anywhere in the UI — the UI correctly never shows it), enters it, clicks Approve — banner clears.
  - Guest's page auto-unlocks via the 5s poll (observed within ~10s), the scoped folder/photo grid renders with exactly the shared folder's 1 photo, and the Download button is present (permission was `download`).
  - Separately verified a `view`-only guest: full flow to unlock, then confirmed zero download buttons in the DOM.
  - Separately verified both owner pages redirect to `/login` when logged out, and the guest portal does **not** redirect even with a syntactically-invalid token — it shows a clean "This invite link is invalid or has expired." message on Request-access instead of crashing.
  - Zero console errors / zero page errors on the guest side throughout; the only console errors seen anywhere were the same benign pre-login `auth/me` 401 pattern documented in every prior Tester report (owner pages, before `authApi.me()` resolves).
- Backend automated suite not re-run (zero backend files touched — confirmed via `git status --short backend/` showing no diff before committing).

## Files changed

- `frontend/src/lib/api.ts` — added `guestsApi`, `accessRequestsApi` (owner context) and `invitesApi`, `guestPortalApi` (guest context), all on the existing `apiFetch`/`ApiError`/`credentials:"include"` conventions.
- `frontend/src/app/share/page.tsx` — new.
- `frontend/src/app/guests/page.tsx` — new.
- `frontend/src/app/g/[token]/page.tsx` — new.
- `frontend/src/app/dashboard/page.tsx` — added the "Guests" top-bar link.
- `frontend/src/app/globals.css` — added `.share-*`, `.guests-*`, `.portal-*` class families (reusing `--color-*` tokens and the `.organize-topbar`/`.viewer-*` patterns wholesale, no new visual language) plus `.dashboard-guests-link`.

## Testing notes for the Tester Agent

- The owner-side rate limiters (signup 5/15min/IP, login 10/15min/IP under `NODE_ENV=development`) will exhaust quickly under repeated manual UI signups in one session — this build hit that exact wall partway through verification and worked around it the same way prior Tester reports document: seeding an owner + session directly via Prisma for setup, keeping the guest-side flow black-box over HTTP/browser. Not a bug in this build.
- The dev-only OTP endpoint (`GET /api/invites/requests/:requestId/otp`) is what both this build's verification and the Tester's prior backend pass use to complete the flow without DB access — confirm `NOTIFICATIONS_EXPOSE_OTP="true"` is still set on the running backend before testing (per STATUS.md's Notes/Risks, it was flipped on for the guest-access backend pass and left on).
- Worth a dedicated adversarial pass on this frontend specifically for: rapid double-click on Approve/Deny/Revoke (no client-side in-flight guard beyond the per-row `busy` state — verify it can't double-submit), and the guest portal's behavior if the backend cookie fails to set (e.g. a browser blocking third-party/SameSite cookies in some configuration) — the current code has no explicit fallback UI for "approved but no cookie arrived," it would just keep polling and never see `unlocked` trigger correctly on a retried status call after the claim was already made by a different tab/request.
