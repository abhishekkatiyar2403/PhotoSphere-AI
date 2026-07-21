# Day 10

Covers everything since `Day9.md` — a full production-hardening pass on the image-delivery and guest-sharing paths: CloudFront went live in front of S3, outbound email moved off Resend's sandbox restriction onto real Gmail SMTP, a real UI bug meant guest invite emails were never actually being sent, the whole guest-approval flow got verified end-to-end, several real frontend bugs got fixed (blurry thumbnails, a broken float animation, a Turbopack path bug), and — the biggest single piece of work — every remaining polling loop in the guest/owner sharing flow was replaced with real-time push (SSE + Redis pub/sub), built once, correctly, for a multi-instance deploy.

## What Day 10 covered, in one sentence

Took the guest-sharing feature from "backend-correct but full of small real-world gaps" to fully working end-to-end — real image CDN, real email delivery to any address, a real fix for an invite-send button that silently did nothing, and a from-scratch real-time architecture (no more polling) for access requests, permission changes, and revokes.

## CloudFront in front of S3

**Abhishek's question:** how does image fetching work today, and can we put CloudFront in front of it so images load through a CDN instead of direct S3?

- No CloudFront existed yet — every thumbnail/original URL was a direct 60s presigned S3/MinIO URL (`lib/storage.ts`'s `getPresignedGetUrl`). Talked through signed-URL vs. signed-cookie CloudFront designs; signed URLs won (matches the existing "one presigned URL per photo per request" permission model).
- Implemented: `getPresignedGetUrl()` now branches — CloudFront signed URL (via `@aws-sdk/cloudfront-signer`) when `CLOUDFRONT_DOMAIN` is configured against real S3, otherwise the old direct S3/MinIO URL, unchanged for local dev/test. Zero caller changes needed (`photoCard.ts`, `routes/photos.ts`, `routes/guest.ts` all picked it up automatically). Force-downloads and the worker's internal classification fetch deliberately stay on direct S3 — CDN is display-path only.
- Walked Abhishek through generating the RSA key pair (`openssl genrsa`/`openssl rsa -pubout`), uploading the public key to CloudFront, creating a trusted key group, and attaching it to the distribution's "Restrict viewer access" setting — plus a corrupted-copy-paste retry on the private key (missing `-----BEGIN`/`-----END` markers) fixed by piping straight to `pbcopy` instead of manual terminal selection.
- **Live-verified end-to-end:** a real photo's `original.url` and every `thumbnails.*` size resolved to the real `dilznozo49ncr.cloudfront.net` domain; the signed URL returned `200 image/jpeg`; the same path with the signature stripped returned `403` — proof the key-group enforcement is actually active, not just a plausible-looking URL.
- Cleaned up the leftover test S3 objects afterward. `AUDIT_FIXES_TRACKER.md`/`SCALABILITY_ROADMAP.md` updated (`#S13` marked done).

## `bcryptjs` → native `bcrypt` (audit tracker #20)

Abhishek picked this as the next tracker item. Swapped the one call site (`routes/auth.ts`) from `bcryptjs` to native `bcrypt` — same `$2b$` hash format, so every existing password in the DB kept working with zero migration. Confirmed the native build compiles cleanly here (the tracker's flagged risk). Live-verified via a real signup/login/wrong-password cycle. 289/289 tests passing at the time.

## Gmail SMTP — sending real email to any recipient

**Abhishek's question:** we're using `RESEND_FROM_EMAIL="onboarding@resend.dev"` — I want to send to any email, not just my own.

- Explained the actual constraint: Resend's shared sandbox sender only delivers to the account owner's own inbox; sending to anyone else needs a **verified domain**, which a plain Gmail address can't be (you don't control `gmail.com`'s DNS).
- Since Abhishek already owns `photosphereai@gmail.com`, the real fix was **Gmail's own SMTP server**, authenticated as that mailbox — no domain verification needed, works today.
- Walked through generating a Gmail **App Password** (2-Step Verification → `myaccount.google.com/apppasswords`).
- Built `GmailNotificationProvider` (`lib/notifications/index.ts`, `nodemailer`) alongside the existing Resend/mock providers, same swappable-provider pattern as everywhere else in this codebase. Gmail takes priority over Resend when both are configured.
- **Bug found and fixed along the way:** the app password Google displays has spaces (`abcd efgh ijkl mnop`) — stripped defensively in code so a literal copy-paste still authenticates.
- **Real bug found and fixed:** this machine's network routes `smtp.gmail.com` to an unreachable IPv6 address, and Node prefers IPv6 by default — silent `EHOSTUNREACH`. Fixed with `dns.setDefaultResultOrder("ipv4first")`, scoped to fire only when Gmail is the active provider.
- A test that guards this file against unreviewed network imports correctly flagged the new `nodemailer`/`dns` imports as suspicious — updated its allow-list with the same reasoning already used for Resend's `fetch`, rather than bypassing it.
- **Live-verified**: real email sent and received via direct nodemailer call, then again through the actual running `/api/auth/forgot-password` endpoint with zero errors. 294/294 tests passing.

## Guest invite "Send" button — real bug, root-caused

**Abhishek's report:** clicking Send on a guest link emails *his own* login address, not the address he typed when generating the link.

- Reproduced the exact flow (create guest → generate link → click Send) directly against the backend — worked perfectly, landed in the right inbox.
- The real explanation: **the Share page's "Send"/"Resend" buttons never called the backend at all.** The code literally said so in a comment — a leftover local-only mock from before the real `send-invite` endpoint existed; clicking it just flipped the button to "Sent ✓" with a toast, no network request, ever. Whatever Abhishek saw in his own inbox was one of the test emails sent moments earlier while verifying Gmail delivery, landing at a coincidental time.
- **Fixed properly:**
  - `guestsApi.sendInvite()` added to `lib/api.ts`, calling the real `POST /api/guests/:id/send-invite`.
  - The "Send to guest" button (right after generating a link, when the raw invite URL is still in memory) now actually calls it, with real busy/error states.
  - The roster's per-guest "Resend" button for *older* guests was found to be genuinely impossible to implement honestly — the backend never stores the raw invite link past its one-time create response (only its hash, by design) — so per Abhishek's own follow-up ask, that button was removed entirely rather than left disabled/fake. The roster's existing "sent ..." status text already covers it.

## OTP approval UI — verified, not rebuilt

**Abhishek's question:** after a guest requests access, does the owner actually have a UI to enter the OTP and approve?

- Checked: yes, it already existed on the Share page (guest email, IP, "opened from N devices" warning, 6-digit input, Approve/Deny) — nothing needed building, just verifying.
- Explained the actual flow clearly: the OTP is never shown in the app (that would defeat its purpose) — it's emailed to the **owner's own inbox**, and the owner reads it there and types it in.
- **Live-verified the whole chain** against the real server: guest access request created → shows up correctly in the owner's pending queue with the exact shape the frontend expects → wrong OTP correctly rejected (`401`). Backend's own test suite for this flow: 27/27.
- At Abhishek's request, triggered a **real** request against his own account so a real OTP landed in his actual inbox for him to approve himself end-to-end.

## Frontend bugs found and fixed

- **Blurry photo cards:** every card surface (browse/organize/search/dashboard/guest portal) was serving the **150px** thumbnail stretched to a ~500px card — a 3x upscale. Switched `toPhotoCard()` (`lib/photoCard.ts`) to the 400px thumbnail the worker already generates. No reprocessing needed — the 400px thumbs already existed in S3.
- **Empty thumbnail during HEIC upload:** browsers can't decode HEIC in an `<img>`, so the local preview was blank until tagging finished. Added HEIC/HEIF detection in the upload page with a clean "HEIC" placeholder tile instead of a broken image.
- **Upload icon not floating:** the icon's `animation` referenced a keyframe name (`ps2FloatY`) that doesn't exist anywhere in `globals.css` — CSS silently no-ops on an unknown animation name. Pointed it at the real, already-defined `ps2Float` keyframe instead of adding a duplicate.
- **`frontend 2` rendering slowly with intermittent errors:** root-caused to Turbopack's dev-mode React Server Components module manifest breaking specifically because the directory name contained a space — "Could not find the module... in the React Client Manifest" on nearly every `/v2/*` route, which manifested as slow loads (silent retries) and visible errors. Fixed by renaming `frontend 2` → `frontend-v2` (no space) and clearing the stale `.next` cache. Verified: all 10 `/v2/*` routes clean `200`s, zero manifest errors on repeat.
- **Photo viewer's side panel overlapping on mobile:** a mobile media query was still targeting `.ps2-viewer-info`, a class name from before a refactor that no longer exists in the JSX (now `.ps2v-side`) — so on narrow/mobile screens the panel had no height limit or scroll container at all, and its sections (AI suggestions/notes/action bar) visually collided. Fixed the selector and added `overflow-y: auto`. Also fixed a related cross-origin dev-server warning for testing from a phone on the same LAN.

## GitHub push

- `git push` to `origin` (`abhishekkatiyar2403/PhotoSphere-AI`) failed with a 403 — that account has no write access there (a pre-existing, known condition from earlier in the project).
- Found a second configured remote, `photosphereai` (`photosphereAi/PhotoSphere-AI`), matching Abhishek's own git identity (`photosphereai@gmail.com`). Its `feature/ai-classification` branch had diverged (a Vercel Web Analytics install, unrelated to this session's work).
- Merged cleanly (two straightforward additive conflicts: a new `@vercel/analytics` dependency in `frontend/package.json`, and the generated `package-lock.json` — resolved by re-running `npm install` rather than hand-editing the lockfile). Both frontend and backend typecheck clean after the merge.
- **The actual `git push photosphereai feature/ai-classification` timed out** (`curl 55 Recv failure`) and was not retried before the conversation moved on — **the merge commit exists locally but has not been confirmed pushed.** Worth a retry.

## Real-time push for guest sharing (SSE + Redis pub/sub) — built once, correctly

Abhishek asked for three things without a page reload: the roster's fake Send button gone (done above), the guest portal reflecting permission changes/revokes live, and the owner's Share page auto-showing new access requests. First pass: straightforward interval polling (6-8s). Abhishek then asked two sharp follow-up questions:

1. **"If a guest hasn't opened the link in 4 days, is polling every 8 seconds forever wasteful — what's the right design?"**
   Answered as a staged tradeoff: Tier 1 (pause polling when the tab isn't visible), Tier 2 (exponential backoff with a cap), Tier 3 (replace polling with server push via SSE + Redis pub/sub — zero idle cost, correct at scale). Recommended Tier 1+2 for "cheap now," Tier 3 as a tracked `SCALABILITY_ROADMAP.md` item for later.
2. **"The guest link uses `localhost:3000` — how does a guest on their own phone ever reach that?"**
   Explained this isn't mobile-specific — `localhost` never means anything but "this device." Confirmed `FRONTEND_ORIGIN` is already environment-driven (`routes/guests.ts`), so the fix is just setting it to the real deployed frontend URL once deployment happens — no code change needed. LAN IP or a tunnel (ngrok/Cloudflare Tunnel) as interim options for testing before that.

**Abhishek's call:** implement Tier 3 properly, once, so it never needs redoing at scale. Built:

- `lib/sse.ts` — a shared `publishEvent(channel, data)` / `streamChannel(req, res, channel)` pair built on **Redis pub/sub** (the same Redis BullMQ already runs against), not an in-process EventEmitter — deliberately, so the publisher and a connected client can be on two different horizontally-scaled API instances behind a load balancer and it still works correctly.
- Three channels replacing three polling loops:
  - `sse:owner:<ownerId>` — fires on a new access request (`routes/invites.ts`) — replaces the Share page's roster poll.
  - `sse:guest:<guestUserId>` — fires on permission change / revoke / folders added or removed (`routes/guests.ts`) — replaces the guest portal's "unlocked" poll.
  - `sse:access-request:<requestId>` — fires on approve/deny/OTP-expiry (`routes/accessRequests.ts`) — replaces the guest portal's old "waiting for approval" poll too, for full consistency.
- Frontend: both the Share page and the guest portal page (`src/app/g/[token]/page.tsx`) now hold one open `EventSource` each instead of any `setInterval`. Every event (and every reconnect, via `onopen`) triggers a normal authoritative refetch of the same data the old poll fetched — so nothing relies on trusting an individual push payload, and a brief network drop can't silently lose an update.
- **Live-verified with real `curl -N` SSE connections against the real running server**, not just code review: opened a real guest stream, made a real authenticated permission-change/revoke call, watched the exact event arrive over the wire in real time; same for the owner's stream on a real access request. All three confirmed working via genuine Redis pub/sub, not a fixture.
- Idle cost is now effectively zero: a tab left open for days costs one open connection plus a 15s heartbeat comment (to stop proxies/browsers from timing out an idle stream) — no repeated queries at all.
- 294/294 backend tests passing, both frontend and backend typecheck clean, both dev servers restarted with fresh caches and verified serving.

## Operational notes

- Docker Desktop needed restarting several times this session, including once for a genuine local-image-metadata corruption (`docker images` itself returning "unexpected end of JSON input") — fixed with a clean quit-and-relaunch (not a factory reset; volumes/data untouched), confirmed by the image list coming back clean afterward.
- A stray `next dev` process was found running from a completely separate `/Users/akatiyar/Downloads/frontend 2/` copy outside this repo entirely — stopped alongside the project's own processes when asked to "stop all running servers."

## Where things stand after Day 10

- **CloudFront, native bcrypt, Gmail SMTP, the guest-invite Send button, and full real-time sharing (no polling) are all live, verified, and working.**
- **Open:** the `photosphereai` remote push timed out and hasn't been confirmed successful — retry needed. `frontend-v2` is still a separate, untracked directory alongside the original `frontend/` (Next.js 16 vs. 14, its own `v2` component tree) — not yet folded into the repo as the "real" frontend, if that's the intended direction. Deploying frontend + backend for real (so guest links work from any device, not just this machine) is still pending — flagged as the natural next step once Abhishek wants to tackle it.
- Backend suite green at **294/294**.
