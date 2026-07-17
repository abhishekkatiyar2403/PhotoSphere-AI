# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Note: this repo already has a root `CLAUDE.md` covering the multi-agent orchestration workflow (Master/Planner/Developer/Tester). This file is scoped to the actual application codebase under `/frontend` and `/backend` — read both.

## Commands

All commands below run from the repo root via npm workspaces, unless noted.

```bash
# Install (root, installs both workspaces)
npm install

# Start local infra (Postgres, Redis, MinIO) — must be running before the backend will boot
docker compose up -d
docker compose ps          # confirm all 3 show "healthy"

# Run dev servers (separate terminals)
npm run dev:backend        # -> tsx watch src/server.ts on http://localhost:4000
npm run dev:frontend       # -> next dev -p 3000 on http://localhost:3000
npm run worker -w backend  # -> tsx watch src/worker.ts, consumes the BullMQ photo-processing queue

# Backend (from /backend, or via -w backend from root)
npm run lint -w backend        # eslint src --ext .ts
npm run typecheck -w backend   # tsc --noEmit
npm run test -w backend        # vitest run (all tests)
npm run test -w backend -- auth.smoke     # single test file (vitest filename filter)
npm run test -w backend -- upload.smoke   # upload API fast-path only — does not start the worker
npm run build -w backend       # tsc -p tsconfig.json

# Frontend (from /frontend, or via -w frontend from root)
npm run lint -w frontend
npm run typecheck -w frontend
npm run build -w frontend

# Prisma (run from /backend — schema lives at backend/prisma/schema.prisma)
npx prisma generate
npx prisma migrate dev   # create a new migration — this is now the norm (see note below)
npx prisma migrate deploy # apply existing migrations without prompting (CI/non-interactive)
npx prisma studio
```

**Migrations now exist** (`backend/prisma/migrations/`), starting with `0_baseline_users_sessions` (the original `db push`-only schema, captured as a baseline) and `20260702000000_add_photos_and_processing_jobs` (adds `Photo` and `ProcessingJob`). Auth-era code was originally applied via `prisma db push` with no migration history — don't assume that's still true; new schema changes should go through `prisma migrate dev`, not `db push`, to keep migration history intact going forward.

**Env files:** `backend/.env` and `frontend/.env.local` are gitignored and copied from the root `.env.example`. If they're missing, `cp .env.example backend/.env` (and `frontend/.env.local`) before running anything that touches Postgres/Redis/MinIO.

## Architecture

### Monorepo shape
Two npm workspaces, no shared package: `/backend` (Express API) and `/frontend` (Next.js 14 App Router UI), talking over HTTP with cookies, not a shared code layer. `docker-compose.yml` at the root provides the three local services (Postgres 16, Redis 7, MinIO) — all three are now live-wired: Postgres via Prisma, Redis via BullMQ (`lib/queue.ts`), and MinIO via the AWS S3 SDK (`lib/storage.ts`). The worker (`src/worker.ts`) is a separate Node process from the API — it must be running (`npm run worker -w backend`) for uploaded photos to ever leave `pending` status.

### Session/auth model — read this before touching anything auth-related
Sessions are **opaque tokens, never JWT** — this is a deliberate project-wide rule, not a Week 1 shortcut:
- `backend/src/lib/session.ts` generates a random 32-byte token, sends the **raw** token to the client only as an `httpOnly` cookie (`photosphere_session`), and stores only a **SHA-256 hash** of it in the `sessions` table (`backend/prisma/schema.prisma`).
- Every authenticated request re-validates the hash against Postgres (`getSessionUser`) — there is no signature-based shortcut, which is what makes revocation (`revokeSession`) instant and durable (logout actually invalidates server-side, not just client-side cookie deletion).
- `backend/src/middleware/requireAuth.ts` is the single gate: it reads the cookie, calls `getSessionUser`, and attaches `req.user`. Anything needing auth goes through this, not a bespoke check.
- Cookie flags (`sessionCookieOptions()` in `session.ts`): `secure` is environment-conditional (`NODE_ENV === "production"`), since local Docker Compose is plain HTTP — don't "fix" this to always-on secure or local dev breaks.
- Login intentionally returns the **same generic 401** for "no such user" and "wrong password" to avoid user-enumeration — don't differentiate these error paths.
- `backend/src/lib/asyncHandler.ts` wraps every async route/middleware and forwards rejections to Express's error middleware in `app.ts`. Express 4 does not catch async rejections on its own — any new route handler that's `async` and isn't wrapped in `asyncHandler` will crash the whole process on an unhandled rejection instead of returning a clean error.
- `authRateLimiter` in `backend/src/routes/auth.ts` is a single IP-keyed bucket (5 req / 15 min) shared by **both** `/signup` and `/login`. This is a known, deliberately-flagged tradeoff (see `agents/STATUS.md`), not an oversight — a burst of signups from one IP can transiently lock out a legitimate login from that same IP. Also causes the smoke test suite to occasionally 429 instead of hitting expected statuses when run back-to-back within the rate-limit window.

### Backend request flow
`server.ts` → `app.ts` (`createApp()`: CORS with `credentials: true` scoped to `FRONTEND_ORIGIN`, JSON body parsing, cookie parsing, mounts `/api/auth` and `/api/photos`, global error handler last) → route modules (Zod validation via `lib/validation.ts` → Prisma via `lib/prisma.ts` → domain helpers). New feature routes should follow the same shape (Zod schema → `asyncHandler`-wrapped handler → mounted in `app.ts`).

### Upload pipeline — async by design, read this before touching photo upload/processing
Upload and processing are two separate processes talking through Postgres + Redis, not one request/response cycle:

- **`routes/photos.ts` (`POST /api/photos/upload`)** does the minimum needed to ACK fast: auth check, `uploadRateLimiter` (30/15min, keyed by **session/user**, not IP — a deliberately separate bucket from the auth limiter so upload bursts can't lock a user out of login), content-sniff the file by magic bytes (`lib/fileSniff.ts` — rejects a renamed `.exe`, not just a bad extension), a storage-quota check, write the original to MinIO, create `Photo` + `ProcessingJob` rows, enqueue a BullMQ job, then return **202** (not 201/200 — processing hasn't happened yet) with `{photoId, jobId, status: "pending"}`.
- **`worker.ts`** is the only thing that ever mutates a photo past `pending`. It runs a strict 4-step pipeline per job: thumbnails (Sharp, 150/400/1200px) → EXIF (`exifr`, missing fields are `null`, not an error) → **pHash dedup gate** → classification. Concurrency is capped at 2 jobs in parallel; failed jobs retry up to 3x with exponential backoff before landing in `failed` with the error persisted.
- **The pHash gate is a hard stop, not a soft signal**: `lib/phash.ts` computes a dHash and checks Hamming distance against the uploading user's existing photos (threshold: <10 bits = duplicate). If it's a duplicate, the photo is marked `duplicate` and **`classify()` is never called** — this is the mechanism behind the ground rule "pHash dedup before any Vision API call," not just a cost optimization suggestion. `classification/index.ts` exposes `mockClassifyCallCount`/`resetMockClassifyCallCount()` specifically so tests can assert this short-circuit actually happens.
- **Classification is swappable, not hardcoded**: `classify()` in `lib/classification/index.ts` is a deterministic mock (hashes the file bytes to pick from fixed label sets, same input → same output, useful for testing dedup) standing in for the real Google Vision integration, which is out of scope until explicitly approved. Don't wire a real API call into this file without checking `specs/upload-pipeline.md` and `agents/STATUS.md` first.
- **Storage access is pre-signed URLs only**: `lib/storage.ts` wraps MinIO as a private bucket with no public ACL ever set; `GET /api/photos/:id` returns short-lived (60s TTL) pre-signed GET URLs as JSON, never a raw key or a redirect. This mirrors the auth session model's "never trust a client-held long-lived credential" posture.
- Storage key convention: `{userId}/{photoId}/original.{ext}` and `{userId}/{photoId}/thumb_{size}.jpg` — user-scoped by construction, which is also why dedup only checks within one user's library, not globally.

### Frontend structure
Next.js 14 **App Router**, not Pages Router. `frontend/src/lib/api.ts` is the single fetch wrapper (`apiFetch`) all API calls go through — it always sets `credentials: "include"` (required for the session cookie to round-trip cross-origin between `:3000` and `:4000`) and throws a typed `ApiError` with the HTTP status attached. New API calls should extend `authApi` in this file rather than calling `fetch` directly from a page.

Pages are client-side auth-gated, not server-side: `/dashboard` calls `authApi.me()` on mount and redirects to `/login` if it 401s; `/login` and `/signup` do the inverse (redirect to `/dashboard` if already authenticated). There's no middleware-based route protection yet — if you add server-side auth checks (e.g. Next.js middleware or route handlers), be aware the existing pages don't rely on it.

`frontend/src/components/AuthLayout.tsx` is the shared visual shell for `/login` and `/signup` (split-screen layout: branded left panel + form right panel, collapsing to a stacked header on screens ≤720px). Any change to the auth page look goes through this component, not per-page markup — it was extracted specifically to keep the two pages visually identical.

### Testing
Only backend has automated tests today: `backend/src/__tests__/auth.smoke.test.ts` and `upload.smoke.test.ts` (Vitest + Supertest) drive the real HTTP app against a real Postgres connection — not mocked, and they skip (not fail) DB-dependent assertions with a warning if Postgres isn't reachable, rather than faking a pass. Because of this, `docker compose up -d` must be running before `npm run test -w backend` will exercise the full suite. `upload.smoke.test.ts` deliberately does **not** start the worker — it only verifies the upload route's fast-path (202 response, DB/MinIO writes, content-sniff rejection, ownership check returning 404 not 403); the full 4-step worker pipeline is verified manually against the live stack, not by an automated test yet. Frontend has no automated tests: `frontend/src/app/upload/page.tsx` is an intentionally unstyled proof-of-concept (polls `/api/photos/:id/status` every 2s) to prove the round-trip works, not a finished UI — verification so far has been manual (typecheck/lint/build + Playwright screenshots via the Tester subagent, not committed to the repo).

### Coordination-file layer (context, not code)
Separately from the app code, this repo runs a markdown-driven multi-agent workflow — `specs/`, `reports/`, and `agents/STATUS.md` are the live source of truth for what's been decided/built/tested and are read by the Planner/Developer/Tester subagents on every run. See root `CLAUDE.md` for the full protocol; the short version is: don't guess on ambiguous product decisions in this codebase (session storage backend, TTL policy, password rules, etc.) — check `specs/auth.md` and `agents/STATUS.md` first, since several of those calls were deliberate, discussed tradeoffs, not defaults left unconsidered.
