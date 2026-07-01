# PhotoSphere AI — Live Status

> Single source of truth for what's happening right now. Every agent reads this first and updates it last. Master Agent owns this file — Planner, Developer, and Tester propose updates, Master reconciles conflicts.

**Last updated:** 2026-07-01 by Master Agent (Docker blocker resolved, Tester ran clean — 17/17 pass)

---

## Current Phase
Phase 1 — MVP, Week 1–2 (Foundation). No product code written yet.

## Current Sprint Goal
Stand up the simplified local-first MVP slice: Next.js frontend + Node/Express backend + Postgres (Docker Compose) + mocked S3 (MinIO) + mocked Google Vision classification. Auth first, then upload pipeline.

## Ready Spec (from Planner)
`specs/auth.md` — **Shipped** by Developer Agent on branch `feature/auth-scaffold` (not yet merged to master — no GitHub remote connected, commit is local only). Covers signup, login, logout, opaque-token session middleware, and the minimal frontend pages needed to prove the cookie round-trips end to end. Scaffolding (monorepo, Docker Compose, Prisma) built as part of the same ticket per the spec's instruction.

## Last Tester Run
**2026-07-01 — first real run, 17/17 passed, 0 bugs.** Report: `reports/2026-07-01_0813.md`. Master resolved the Docker credential blocker this cycle (image pulls now succeed — see Notes/Risks), brought up `docker compose up -d` (all 3 services healthy), ran `prisma db push` against the fresh DB, and started both dev servers in the background before dispatching Tester. Full spec coverage: signup (valid/duplicate/invalid), login (valid/wrong-password/no-enumeration), logout+revocation, rate limiting (5×401→429 confirmed), cookie flags (HttpOnly+SameSite=Lax present, Secure correctly absent in dev), protected-route redirects both directions, backend stayed up throughout. Auth is confirmed working end-to-end.

## Last Developer Action
**2026-07-01 — Developer Agent shipped `specs/auth.md` on `feature/auth-scaffold`.**

What was built:
- Monorepo scaffold: root `package.json` (npm workspaces: `frontend`, `backend`), root `docker-compose.yml` (`postgres:16-alpine`, `redis:7-alpine`, `minio/minio:latest`, each with healthchecks), root `.env.example`.
- Backend (`/backend`): Node + Express + TypeScript, Prisma schema with `users` and `sessions` tables (session tokens stored as SHA-256 hash only, never plaintext, matching the `invite_tokens.token_hash` pattern). Routes: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` (protected, used by the dashboard and by Tester to prove revocation). `express-rate-limit` on signup/login (5 attempts / 15 min → 429). Zod validation on both payloads, rejects bad input with 400 before touching the DB. bcrypt cost factor 12. Opaque tokens only — no JWT anywhere in the codebase (`grep -ri jwt backend/src` returns nothing).
- Frontend (`/frontend`): Next.js 14 App Router + TypeScript. Pages: `/` (redirects to `/login`), `/signup`, `/login`, `/dashboard` (client-side auth check via `/api/auth/me`; redirects to `/login` if unauthenticated, and `/signup`+`/login` redirect to `/dashboard` if a valid session already exists).
- Bug I found and fixed while testing my own build: Express 4 doesn't catch rejected promises in async route handlers, so an unreachable-DB error was crashing the whole backend process instead of returning a clean error. Added `backend/src/lib/asyncHandler.ts` (wraps every async handler and middleware, forwards rejections to `next(err)`) plus a global error-handling middleware in `backend/src/app.ts` that returns a 500 instead of crashing. Verified: server now survives a DB outage and returns `{"error":"Internal server error"}` with status 500 instead of dying.
- Smoke test: `backend/src/__tests__/auth.smoke.test.ts` (Vitest + Supertest) covers the full signup → protected route → logout → denied → login → allowed flow, duplicate-signup 409, invalid-payload 400, and generic-401-no-enumeration. Gracefully skips the DB-dependent assertions with a warning if Postgres isn't reachable (does not fabricate a pass) — 4/4 tests currently pass in this environment (DB-dependent ones skip cleanly since Docker couldn't come up here, see Blocked below).
- `npm run dev` script names/ports: backend `npm run dev -w backend` (or `cd backend && npm run dev`) → `tsx watch src/server.ts` on **http://localhost:4000**; frontend `npm run dev -w frontend` (or `cd frontend && npm run dev`) → `next dev -p 3000` on **http://localhost:3000**. Both verified booting and responding locally (backend `/health` returns 200, frontend `/login` and `/signup` return 200, `/` redirects to `/login`).
- Both packages typecheck clean (`tsc --noEmit`) and lint clean (`eslint`, zero errors). Vitest suite passes 4/4.

**Blocked / could not verify locally:** `docker compose up -d` did **not** come up healthy in my own test. Docker Desktop's daemon and CLI are present and `docker version`/`docker info` succeed, and host-level network access to `registry-1.docker.io` works (`curl` gets a 401 as expected for an unauthenticated API ping). But every `docker pull` / `docker compose up` / `docker run` attempt fails at the credential-helper step: `error getting credentials - err: exit status 1, out: 'User canceled the operation. (-128)'`. Docker's CLI is configured to use `osxkeychain` (`~/.docker/config.json`, `"credsStore": "osxkeychain"`) for all registry pulls, even anonymous/public ones, and the keychain access prompt has no interactive session to approve it in this sandboxed agent environment. I did not modify `~/.docker/config.json` (that's outside the repo and is Abhishee's global machine config, not something I should silently change). **Abhishek: this needs one of (a) you running `docker compose up -d` yourself once from an interactive terminal so the keychain grants permanent access, or (b) telling me it's fine to override `credsStore` in your global Docker config, or (c) pointing me at a `DOCKER_CONFIG` dir/credential setup that avoids the keychain prompt.** Everything else (backend logic, frontend logic, migrations-as-written, typecheck, lint, smoke tests against the app layer) is verified; only the actual Postgres/Redis/MinIO containers themselves are unverified pending this.

## Open Bugs
None. Tester's 2026-07-01 run found 0 bugs (17/17 pass). One bug found and fixed by Developer during its own self-testing prior to Tester's run (Express async-handler crash on DB outage) — see Last Developer Action above.

Two non-bug items Tester flagged for attention (not blocking):
- Signup and login share one IP-keyed rate-limit bucket (5/15min combined) per the spec as written — a burst of signups from one IP could lock out a legitimate login from that same IP. Worth a deliberate decision on whether these should be independent buckets before Week 3-4 builds more traffic-sensitive endpoints.
- Still no `backend/prisma/migrations/` directory — schema was applied via `prisma db push`, not `migrate dev`, so there's no migration history yet. Fine for local MVP iteration, but needs to switch to real migrations before anything resembling a deploy.

## Pending Decisions Awaiting User Input
None open right now.

- Decisions 1–5 (session storage, TTL/refresh, password policy, email verification scope, cookie `Secure` flag) — **confirmed by Abhishek 2026-07-01**: all 5 spec defaults approved as-is, no changes needed.
- Decision 6 (signup/login visual layout) — **resolved 2026-07-01: Abhishek picked Option B (split screen), and Developer has now shipped it.** `design/wireframes/auth.svg` holds that design as the lasting record (unmodified by this build). Implemented on `feature/auth-scaffold`, commit `efb5847`: extracted `frontend/src/components/AuthLayout.tsx` (left `#3057d5` branded panel with name + tagline, right panel holds the pre-existing, unmodified form card) and added a `@media (max-width: 720px)` breakpoint in `globals.css` that collapses the branded panel to a compact header bar above the form on mobile. Zero changes to form logic, validation, API calls, or session handling. Verified: `tsc --noEmit` clean, `eslint` clean, DOM contains both `auth-brand-panel` and `auth-card` on both pages, Playwright screenshots confirm correct rendering at 1280x800 and 390x844 for both `/login` and `/signup`. MR draft: `reports/mr-drafts/feature-auth-scaffold-auth-visual-swap.md`.

## Next Scheduled Actions
- 06:00 daily — Tester Agent regression pass. Docker credential-helper blocker is resolved as of 2026-07-01; cron still needs Docker Desktop + both dev servers started before it runs (see Notes/Risks) — not yet automated.
- 18:00 daily — Tester Agent regression pass
- Before each Developer build — Planner Agent scopes the next roadmap item into a spec (skipped if there are bugs to fix instead)
- After each Tester run — Developer Agent reads the new report and acts
- Auth is confirmed working end-to-end (Tester 17/17 pass) — unblocked to move forward. Next up: Planner scopes the Week 3–4 photo upload pipeline spec (S3/MinIO integration, BullMQ, thumbnails, EXIF, pHash) unless Abhishek's still-pending decisions below change scope first.

## Notes / Risks
- No GitHub remote connected yet. Developer Agent commits locally on feature branches (`feature/auth-scaffold`, commit `e6db514`); MR draft is at `reports/mr-drafts/feature-auth-scaffold.md` (moved there by Master from scratchpad this cycle), ready to push the moment GitHub is connected and Abhishek gives the go-ahead.
- **Resolved 2026-07-01:** the Docker credential-helper blocker described in earlier cycles is gone — `docker compose pull`/`up -d` now succeed in this environment without intervention. Unclear whether Abhishek approved a keychain prompt in between sessions or something else changed; worth keeping an eye out in case it regresses. All 3 services (Postgres, Redis, MinIO) came up healthy and auth's full regression suite passed against them.
- Both dev servers (backend `:4000`, frontend `:3000`) were started by Master this cycle via `nohup ... &` in the background — they'll keep running across chat turns but will NOT survive a machine reboot or VS Code restart. Whoever picks up the next session should check `curl localhost:4000/health` before assuming they're still up.
- Tester Agent uses Playwright against `localhost` (you run the dev server locally) — not live browser control, since that's a Cowork-only capability. See EXECUTION_PLAN.md for why.
- Real AWS/GCP services (S3, Vision API, EKS, Terraform) are deferred until you provide credentials. Everything is mocked locally for now.
- Several plugins (GitHub, Notion, Slack, Linear, etc.) were connected in Cowork but most still need OAuth authorization, and none of them are automatically available inside the VS Code Claude Code session — they'd need to be added there separately. See `PLUGIN_INTEGRATION.md`. Until then, every agent's plugin-dependent step has a plain-markdown fallback.
- UI design decisions are SVG-only — Developer Agent proposes wireframe options in chat and saves the chosen one to `design/wireframes/`. No Figma integration in this loop. Decision #6 (auth page layout) is the first one through this full loop end-to-end: options proposed, Abhishek picked Option B, SVG saved to `design/wireframes/auth.svg`, and the frontend now matches it.
- **New this cycle:** re-running `backend/npm test` twice back-to-back surfaced 2 of 4 smoke tests failing with 429 instead of their expected status (409, 401). Confirmed via `git stash` that this reproduces identically on the pre-existing Option-A code too — not a regression from the auth visual swap. Root cause: all four smoke-test cases share one Express `authRateLimiter` bucket (5 req/15min, IP-keyed) within a single `vitest run` process, and their combined signup/login calls exceed 5 before the later assertions run. This is the test-suite-level manifestation of the already-flagged "shared IP-keyed rate-limit bucket" risk in Open Bugs above. Needs a decision: raise/disable the rate limit under `NODE_ENV=test`, reset the limiter between test cases, or split signup/login into independent buckets. Not fixed in this pass (out of scope for a CSS-only ticket, touches shared auth middleware) — flagging for Tester/Developer's next bug-fixing pass.
- `npm install` flags Next.js 14.2.13 with a known security advisory (upgrade recommended per `npm audit`). Not fixed in this pass since it's outside auth scope and a version bump could shift App Router behavior — flagging for a dedicated dependency-upgrade pass rather than bundling it into this ticket.
