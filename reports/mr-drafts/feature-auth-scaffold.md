# MR Draft: feature/auth-scaffold

**Title:** feat: scaffold monorepo + Docker Compose + Prisma, ship auth (signup/login/logout/sessions)

**Branch:** `feature/auth-scaffold` (local only, not pushed — no GitHub remote connected)

## Description

Implements `specs/auth.md` in full, including the prerequisite scaffolding it calls in-scope: monorepo layout (`/frontend`, `/backend`), root `docker-compose.yml` (Postgres, Redis, MinIO), Prisma schema (`users`, `sessions`), and `.env.example`.

Auth feature: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` (protected), opaque-token session middleware (SHA-256 hashed in DB, raw token only in an HttpOnly/SameSite=Lax/environment-conditional-Secure cookie — never a JWT), bcrypt cost-12 password hashing, Zod validation, express-rate-limit on signup/login (5/15min). Minimal frontend: `/`, `/signup`, `/login`, `/dashboard` (client-side auth-gated via `/api/auth/me`).

Also fixes a bug found during self-testing: Express 4 async route handlers don't forward promise rejections automatically, so a DB outage was crashing the whole backend process. Added `backend/src/lib/asyncHandler.ts` + a global error-handling middleware.

## Files touched (all new except `.gitignore`, `agents/STATUS.md`)

- `docker-compose.yml`, `.env.example`, `package.json` (root workspaces), `package-lock.json`, `.gitignore` (added `*.tsbuildinfo`)
- `backend/package.json`, `backend/tsconfig.json`, `backend/.eslintrc.json`
- `backend/prisma/schema.prisma`
- `backend/src/app.ts`, `backend/src/server.ts`
- `backend/src/lib/prisma.ts`, `backend/src/lib/session.ts`, `backend/src/lib/validation.ts`, `backend/src/lib/asyncHandler.ts`
- `backend/src/middleware/requireAuth.ts`
- `backend/src/routes/auth.ts`
- `backend/src/__tests__/auth.smoke.test.ts`
- `frontend/package.json`, `frontend/tsconfig.json`, `frontend/.eslintrc.json`, `frontend/next.config.js`, `frontend/next-env.d.ts`
- `frontend/src/app/layout.tsx`, `frontend/src/app/globals.css`, `frontend/src/app/page.tsx`
- `frontend/src/app/signup/page.tsx`, `frontend/src/app/login/page.tsx`, `frontend/src/app/dashboard/page.tsx`
- `frontend/src/lib/api.ts`
- `agents/STATUS.md` (Developer's status update section)

## Testing notes

- `cd backend && npx tsc --noEmit` — clean.
- `cd frontend && npx tsc --noEmit` — clean.
- `cd backend && npx eslint src --ext .ts` — clean, 0 errors.
- `cd frontend && npx eslint .` — clean, 0 errors.
- `cd backend && npx vitest run` — 4/4 pass. DB-dependent assertions inside the smoke test skip gracefully (with a console warning, not a fabricated pass) since Postgres wasn't reachable in this sandboxed session — see Blocked note below.
- Manually booted both dev servers locally:
  - `cd backend && npm run dev` → listens on `http://localhost:4000`, `GET /health` → 200, `POST /api/auth/signup` with valid payload → clean 500 (DB unreachable, not a crash — confirms the asyncHandler fix), `POST /api/auth/signup` with invalid payload → 400 with Zod field errors, before any DB call.
  - `cd frontend && npm run dev` → listens on `http://localhost:3000`, `GET /` → 302 to `/login`, `GET /login` → 200, `GET /signup` → 200, `GET /dashboard` → 200 (client-side redirect logic present, unverified end-to-end pending DB).

**Blocked:** `docker compose up -d` could not be verified in this environment — every `docker pull`/`docker compose up`/`docker run` fails at the macOS Keychain credential-helper step (`error getting credentials ... User canceled the operation (-128)`), which has no interactive session to approve in this sandboxed agent run. Host network to `registry-1.docker.io` itself works fine (confirmed via `curl`). Full DB-backed acceptance criteria (session persistence, revocation-on-logout enforced against real Postgres, migration applying cleanly) are implemented and code-reviewed correct but not yet run against live containers. See `agents/STATUS.md` "Last Developer Action" for the three unblock options proposed to Abhishek.

## Definition of done checklist

- [x] Code compiles/lints clean (`tsc --noEmit`, ESLint) — both packages.
- [ ] Migration applied cleanly on a fresh Docker Compose stack — **blocked**, see above.
- [x] Smoke test exists (`backend/src/__tests__/auth.smoke.test.ts`) — passes locally; DB-dependent assertions skip (not fabricated) pending Docker fix.
- [x] STATUS.md updated.
- [x] MR draft written (this file).
- [x] No secrets committed. No real cloud credentials touched. No JWT library anywhere (`grep -ri jwt backend/src` → no matches).
