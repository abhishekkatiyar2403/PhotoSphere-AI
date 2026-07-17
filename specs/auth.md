# Spec — Auth (Signup / Login / Sessions)

**Roadmap source:** PhotoSphere_AI_Master_Roadmap.md § 7 (Phase 1 — MVP, Week 1–2: Foundation) and § 18 (90-Day Sprint Plan, Week 1–2)
**Status:** draft
**Written by:** Planner Agent, 2026-07-01

## Problem

Nothing has been scaffolded yet — no monorepo, no Docker Compose, no Prisma schema, no running services. Before any auth code can exist, the local-first MVP skeleton has to exist. Once it does, PhotoSphere AI needs a way for a user (the "owner" role in the roadmap's data model) to create an account, log in, and maintain a session — every other Phase 1 feature (uploads, folders, guest sharing) depends on `users.id` and a valid session existing first.

This spec covers both: (1) the one-time scaffolding prerequisite, and (2) the actual auth feature. Developer should treat scaffolding as part of this ticket, not a separate one — there is no prior ticket that did it.

## Goals

- Stand up the local dev skeleton: Docker Compose (Postgres, Redis, MinIO — MinIO unused by this spec but stood up now since Week 3–4 needs it and Compose is one file), Next.js 14 (App Router, TypeScript) frontend, Node/Express + Prisma backend, `.env.example` for config.
- Prisma schema for `users` (per roadmap § 6, auth-relevant columns only for now — `id`, `email`, `password_hash`, `name`, `plan` default `free`, `storage_used_bytes` default 0, `storage_limit_bytes` default 5368709120, `created_at`, `updated_at`).
- A `sessions` table (not in the roadmap's § 6 schema as written — the roadmap schema omits it, so this spec adds it; see Open Questions) holding opaque session tokens, per the project's ground rule of opaque tokens over JWT, so sessions can be revoked server-side instantly.
- Signup: email + password + name → creates user, hashes password with bcrypt (cost factor 12, per roadmap § 12), creates a session, returns session cookie.
- Login: email + password → verifies bcrypt hash, creates a new session, returns session cookie.
- Logout: invalidates the current session server-side (deletes/marks revoked in DB — this is exactly why opaque tokens were chosen).
- Session middleware: every authenticated Express route checks the opaque token against the `sessions` table (not a JWT signature check) and attaches the user to `req`.
- Basic API input validation with Zod on signup/login payloads (email format, password length).
- Rate limiting on `/api/auth/login` and `/api/auth/signup` (per roadmap § 12 Layer 7 — brute-force protection), using `express-rate-limit`.

## Non-goals (explicitly out of scope for this pass)

- OAuth / Google login / Passport.js strategies beyond local — roadmap lists Passport.js generally but Week 1–2 scope is "basic auth," not social login.
- Magic-link login (`POST /api/auth/magic-link` is in the roadmap's API list but is not a Week 1–2 item).
- Email verification flow (no Resend/SES integration yet — email/SMS providers aren't wired into the local MVP per CLAUDE.md's mocked-services approach). Signup creates an active, usable account immediately.
- Password reset / forgot-password flow — not in Week 1–2 scope, will be its own spec later.
- Guest users / guest sessions / OTP approval (`guest_users`, `guest_sessions`, `access_requests` tables) — that's Week 9–10 scope, a separate spec.
- Any UI polish beyond a functional signup/login form — no design-system pass, no SVG wireframe needed for this since it's a plain, low-decision form (single input stack, no layout ambiguity worth a design review). If Developer disagrees and sees real layout ambiguity, escalate per CLAUDE.md's UI decision process instead of guessing.
- CI/CD (GitHub Actions) — listed under the same roadmap week but is infra plumbing independent of auth logic; can ship in a follow-up pass without blocking auth. Flagged as deferred, not forgotten.
- Rate limiting / security headers beyond the two auth endpoints — full Helmet.js + global rate limiting is Week 11 scope per roadmap; this spec only covers the auth-endpoint-specific limiting called out above since brute-forcing login is directly relevant to this feature.

## Scope for this sprint

**Prerequisite scaffolding (build once, part of this ticket):**
- Monorepo layout: `/frontend` (Next.js 14 + TypeScript), `/backend` (Node + Express + Prisma), `/docker-compose.yml` at root.
- `docker-compose.yml` services: `postgres`, `redis`, `minio` (minio started but not integrated into any route yet — just available for Week 3–4).
- Prisma initialized against the Postgres container, one migration containing `users` and `sessions` tables.
- `.env.example` with `DATABASE_URL`, `REDIS_URL`, `SESSION_TOKEN_TTL_HOURS` (or similar), `MINIO_*` placeholders (unused this pass but documented so Week 3–4 doesn't need a second scaffolding pass).
- Backend boots with `npm run dev` (or equivalent) on a fixed local port; frontend boots separately via `npm run dev`.

**Auth feature (this pass):**
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- Session-check middleware usable by future protected routes
- Minimal frontend pages: `/signup`, `/login`, and a placeholder authenticated `/dashboard` route that redirects unauthenticated visitors to `/login` (just enough to prove the session cookie round-trips end to end — dashboard content itself is Week 7–8 scope).

**Deferred to later passes:** everything listed under Non-goals above.

## Acceptance criteria

- [ ] `docker-compose up` brings up Postgres, Redis, and MinIO containers successfully with no manual steps beyond copying `.env.example` to `.env`.
- [ ] `npx prisma migrate dev` (or equivalent) creates `users` and `sessions` tables matching this spec's schema.
- [ ] `POST /api/auth/signup` with a new valid email + password (min 8 chars) + name returns 201, creates a `users` row with a bcrypt hash (never plaintext) in `password_hash`, creates a `sessions` row, and sets an HttpOnly, Secure-in-prod session cookie containing the opaque token (not a JWT — verifiable by decoding the cookie value and confirming it is not a valid JWT structure).
- [ ] `POST /api/auth/signup` with an already-registered email returns 409 and does not create a duplicate `users` row.
- [ ] `POST /api/auth/signup` with an invalid email format or password under 8 characters returns 400 with a Zod validation error, before touching the DB.
- [ ] `POST /api/auth/login` with correct credentials returns 200, creates a new `sessions` row, sets the session cookie.
- [ ] `POST /api/auth/login` with incorrect password or unknown email returns 401 with a generic "invalid credentials" message (no user-enumeration leak distinguishing "no such user" from "wrong password").
- [ ] `POST /api/auth/login` is rate-limited (e.g. max 5 attempts per IP per 15 minutes) and returns 429 once exceeded.
- [ ] `POST /api/auth/logout` invalidates the session server-side (row deleted or `revoked_at` set) such that the same cookie can no longer authenticate a subsequent request, and clears the cookie client-side.
- [ ] A protected test route (or the `/dashboard` page's data call) rejects requests with no cookie, an expired session, or a revoked session with 401 — proving revocation is enforced server-side (the entire point of opaque tokens over JWT).
- [ ] Session tokens are stored in the DB only as a hash (e.g. SHA-256), never in plaintext, matching the same pattern the roadmap uses for `invite_tokens.token_hash` — the raw token only ever lives in the cookie.
- [ ] Visiting `/dashboard` while unauthenticated redirects to `/login`; visiting `/login` or `/signup` while already authenticated redirects to `/dashboard`.
- [ ] No real cloud credentials, Stripe keys, or JWT libraries appear anywhere in the auth implementation.

## Success signal

Tester Agent can run through: fresh signup → cookie set → hit a protected endpoint (succeeds) → logout → hit the same protected endpoint with the old cookie (fails with 401) → login again → succeeds again. Tester also confirms `docker-compose up` from a clean clone gets a new contributor to a working `npm run dev` on both frontend and backend with zero manual DB/Redis/MinIO setup steps beyond `.env` copy and running the Prisma migration. Password hashes and session tokens are inspected directly in Postgres to confirm neither plaintext passwords nor plaintext tokens are ever persisted.

## Open questions

Posted to `agents/STATUS.md` under Pending Decisions — the following are genuine ambiguities, not silently resolved:

1. **Session storage: DB-only vs. DB + Redis-backed cache.** The roadmap's § 6 schema only defines a Postgres `guest_sessions` table (for guests) and never defines an owner `sessions` table at all — the "opaque token in DB" rule is stated in prose (§ 12, Project Instruction) but no owner-session schema exists to copy. Redis is available in this stack for "sessions, OTP cache, queue" per § 5. **Assumption made for this spec (flagged, not hidden):** sessions live in Postgres as the source of truth (so revocation is durable and simple to query/audit), with no Redis session cache layer in this first pass — Redis read-through caching for session lookups can be added later purely as a performance optimization once there's an actual latency problem to justify it. If Abhishek wants Redis-backed sessions from day one instead, that changes the implementation (not the API contract) and should be confirmed before Developer builds.
2. **Session TTL and refresh behavior.** Roadmap doesn't specify how long an owner session lives or whether it auto-refreshes on activity. **Assumption:** fixed 7-day TTL from creation, no sliding refresh in this pass (simplest to reason about and test). Confirm if a "remember me" / sliding-session behavior is actually wanted before Week 7–8 dashboard work depends on session lifetime assumptions.
3. **Password policy beyond minimum length.** Roadmap says nothing about complexity rules. **Assumption:** 8-character minimum only, no complexity regex, matching typical modern guidance (length over complexity) and keeping the MVP simple. Flag if Abhishek wants stricter rules.
4. **Email verification.** Explicitly deferred (see Non-goals) rather than guessed into existence — no Resend/SES account exists yet per CLAUDE.md, and the roadmap doesn't gate MVP signup on it. Confirm this is acceptable before Phase 1 "launch prep" (Week 11–12) — if verified email turns out to be a real requirement before then, it needs its own spec.
5. **Cookie flags for local dev over plain HTTP.** `Secure` cookies require HTTPS; local Docker Compose dev is plain HTTP. **Assumption:** `Secure` flag is environment-conditional (off in `NODE_ENV=development`, on otherwise), `HttpOnly` and `SameSite=Lax` always on. Flag this so Tester doesn't fail a check by comparing against production cookie flags in a local run.
