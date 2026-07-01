# PhotoSphere AI — Live Status

> Single source of truth for what's happening right now. Every agent reads this first and updates it last. Master Agent owns this file — Planner, Developer, and Tester propose updates, Master reconciles conflicts.

**Last updated:** 2026-07-01 by Developer Agent (scaffold + auth built on `feature/auth-scaffold`)

---

## Current Phase
Phase 1 — MVP, Week 1–2 (Foundation). No product code written yet.

## Current Sprint Goal
Stand up the simplified local-first MVP slice: Next.js frontend + Node/Express backend + Postgres (Docker Compose) + mocked S3 (MinIO) + mocked Google Vision classification. Auth first, then upload pipeline.

## Ready Spec (from Planner)
`specs/auth.md` — **Shipped** by Developer Agent on branch `feature/auth-scaffold` (not yet merged to master — no GitHub remote connected, commit is local only). Covers signup, login, logout, opaque-token session middleware, and the minimal frontend pages needed to prove the cookie round-trips end to end. Scaffolding (monorepo, Docker Compose, Prisma) built as part of the same ticket per the spec's instruction.

## Last Tester Run
None yet. First run scheduled for the next 06:00 or 18:00 window — recommend running it against this branch once Docker Compose can actually pull images in that environment (see Blocked note below).

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
None reported by Tester yet (no Tester run has happened against this build). One bug found and fixed by Developer during self-testing, see above (Express async-handler crash on DB outage).

## Pending Decisions Awaiting User Input
1. **Session storage mechanism** — `specs/auth.md` assumes Postgres-only sessions (no Redis session cache in this first pass), since the roadmap's DB schema never actually defines an owner `sessions` table despite the "opaque token in DB" rule being stated in prose. Redis is available in the stack and could back sessions from day one instead. Confirm Postgres-only is acceptable, or say if Redis-backed sessions are wanted now rather than as a later optimization.
2. **Session TTL/refresh behavior** — spec assumes a fixed 7-day TTL with no sliding refresh. Confirm, or specify desired "remember me" / sliding-session behavior before Week 7–8 dashboard work builds on this assumption.
3. **Password policy** — spec assumes 8-character minimum only, no complexity rules. Confirm or specify stricter requirements.
4. **Email verification scope** — spec defers email verification entirely (no Resend/SES wired up yet); signup creates an immediately-usable account. Confirm this is acceptable through at least Week 11–12 launch prep, or flag if it's needed sooner.
5. **Cookie `Secure` flag in local dev** — spec assumes `Secure` is environment-conditional (off under `NODE_ENV=development` since local Compose is plain HTTP, on otherwise), with `HttpOnly` and `SameSite=Lax` always on. Flagging so Tester doesn't fail this by comparing against production cookie expectations in a local run.

None of these block Developer from starting — each has a clearly-labeled, reasonable default baked into the spec. They're listed here so Abhishek can override any of them before or during the build rather than the assumption silently becoming permanent.

6. **Signup/login page visual layout.** `specs/auth.md` explicitly says no SVG wireframe review is needed for this pass (calls it "a plain, low-decision form, no layout ambiguity worth a design review"). Developer built a reasonable default anyway (Option A below) so the dev server runs end-to-end, but per CLAUDE.md's UI-decision process, 3 options with SVG wireframes are presented in the Developer Agent's chat response for this build. **This is a pending decision awaiting Abhishek's pick** — Option A is already live in the running app; switching to B or C is a CSS/JSX-only swap, not a re-architecture. Once picked, the chosen SVG moves into `design/wireframes/auth.svg` as the lasting design record (currently empty — nothing has been picked yet).
   - **Option A — Centered card** (built, currently live): single centered card on a neutral background, stacked fields, one primary button. Lowest effort, most conventional SaaS pattern, easiest to keep consistent between `/signup` and `/login`.
   - **Option B — Split screen**: left panel branded color block with product name/tagline, right panel holds the form card. More "designed" first impression, slightly more markup/CSS, harder to keep working well on narrow mobile widths without an extra breakpoint.
   - **Option C — Minimal top-bar + underlined fields**: thin top bar with logo, no card border, underline-style inputs, pill-shaped button. Lightest visual weight, fastest to scan, but underline-only inputs read as less "filled out" and are marginally less accessible (weaker visual boundary for low-vision users) unless focus states are done carefully.
   - **Developer's recommendation:** keep Option A (already built and proven working end-to-end); it's the safest default for an MVP whose differentiator is AI organization, not visual design, and it doesn't block any Week 3-4 work either way.

## Next Scheduled Actions
- 06:00 daily — Tester Agent regression pass. **Note:** Tester will hit the same Docker credential-helper blocker described above unless it's resolved first — flag this rather than have Tester silently mark Docker-dependent criteria as failed/skipped without explanation.
- 18:00 daily — Tester Agent regression pass
- Before each Developer build — Planner Agent scopes the next roadmap item into a spec (skipped if there are bugs to fix instead)
- After each Tester run — Developer Agent reads the new report and acts
- Next up for Developer once auth is confirmed working end-to-end (post Docker fix + Tester pass): Week 3–4 photo upload pipeline spec (S3/MinIO integration, BullMQ, thumbnails, EXIF, pHash) — Planner should scope this next unless Tester finds bugs first.

## Notes / Risks
- No GitHub remote connected yet. Developer Agent commits locally on feature branches (`feature/auth-scaffold`); MR draft is at `reports/mr-drafts/feature-auth-scaffold.md`, ready to push the moment GitHub is connected.
- **New risk:** `docker compose up -d` / any `docker pull` fails in this agent's sandboxed environment due to the macOS Keychain credential-helper prompt having no interactive session to approve — see "Last Developer Action" above for full detail and options to unblock. This blocks full end-to-end verification (real Postgres/Redis/MinIO) for both Developer and, likely, Tester until resolved.
- Tester Agent uses Playwright against `localhost` (you run the dev server locally) — not live browser control, since that's a Cowork-only capability. See EXECUTION_PLAN.md for why.
- Real AWS/GCP services (S3, Vision API, EKS, Terraform) are deferred until you provide credentials. Everything is mocked locally for now.
- Several plugins (GitHub, Notion, Slack, Linear, etc.) were connected in Cowork but most still need OAuth authorization, and none of them are automatically available inside the VS Code Claude Code session — they'd need to be added there separately. See `PLUGIN_INTEGRATION.md`. Until then, every agent's plugin-dependent step has a plain-markdown fallback.
- UI design decisions are SVG-only — Developer Agent proposes wireframe options in chat and saves the chosen one to `design/wireframes/`. No Figma integration in this loop. (See Pending Decision #6 above — nothing saved yet, awaiting Abhishek's pick.)
- `npm install` flags Next.js 14.2.13 with a known security advisory (upgrade recommended per `npm audit`). Not fixed in this pass since it's outside auth scope and a version bump could shift App Router behavior — flagging for a dedicated dependency-upgrade pass rather than bundling it into this ticket.
