# PhotoSphere AI

A privacy-first, AI-powered photo organization and sharing platform. Users upload photos, AI automatically classifies and organizes them into folders (People, Nature, Travel, Food, …), and owners can share specific folders with guests under full access control.

**Live frontend:** https://photo-sphere-ai-frontend.vercel.app

## Features

### Upload pipeline
- **Batch uploads (500–1000+ photos)** via presigned S3 multipart uploads — the browser PUTs parts directly to S3 (Uppy), with client-side SHA-256 dedup pre-checks, partial-success handling, and a daily cleanup job for stale upload sessions.
- **Plan-tiered limits** — Free / Pro / Studio tiers with per-plan batch caps (50 / 500 / 1500 photos), storage quotas (5 GB / 100 GB / 500 GB), and BullMQ job priority (Studio processes first). Plan switching via `/settings` (testing only — no billing).
- Async processing worker: thumbnails (Sharp), EXIF extraction, pHash dedup **before** any Vision API call, then AI classification.

### AI organization
- Automatic photo classification on upload with auto-created category folders; face grouping; an `/organize` page for reviewing and reclassifying, with multi-select move/download.
- "Unfiled" handling with per-card reasons and manual move for failed/duplicate photos.

### Browsing & search
- Dashboard with storage/photo/folder stats, `/browse` folder grid, full-screen photo viewer, dedicated `/search` page, and a `/places` view.
- Folder management: rename, merge, delete, download-all (bulk ZIP).

### Sharing & guest access
- Folder-level guest invites with OTP email access, view/download permissions, expiry, and one-tap revocation.
- Guest share pages (`/g`, `/share`), access requests, and a full audit trail (`/activity`) — every view and download logged.

### Trash system
- Soft-delete for photos and folders with a 7-day retention window, dedicated `/trash` page, restore with collision handling, and a daily BullMQ auto-purge job.

### Security architecture
- Opaque session tokens (not JWT), bcrypt (native) password hashing.
- Permission check → pre-signed URL (60 s TTL) for **every** image; raw storage keys are never exposed.
- CloudFront CDN delivery for thumbnails; Zod validation and per-route rate limiting throughout.

## Tech stack

| Layer | Tools |
|---|---|
| Frontend | Next.js 14, TypeScript, React 18, Uppy |
| Backend | Node.js + Express, Prisma ORM, BullMQ, Sharp, Zod |
| Database | PostgreSQL (primary), Redis (sessions, queue) |
| Storage | AWS S3 (MinIO locally), CloudFront CDN |
| Mobile | Capacitor (Android scaffolding in `frontend-v2/`) |

## Repository layout

```
backend/       Express API + BullMQ worker + Prisma schema & migrations
frontend/      Next.js 14 web app
frontend-v2/   Capacitor mobile wrapper (Android scaffolding)
agents/        Multi-agent orchestration (Master / Planner / Developer / Tester)
specs/         Feature specs (spec of record per feature)
reports/       Dated tester reports + MR drafts
design/        SVG wireframes (the design record — no Figma)
scripts/       Cron runners for the tester/developer agents
```

## Getting started (local development)

Prerequisites: Node 18+, Docker.

```bash
# 1. Start infrastructure (Postgres, Redis, MinIO)
docker compose up -d

# 2. Install dependencies (npm workspaces)
npm install

# 3. Apply database migrations
cd backend && npx prisma migrate deploy && cd ..

# 4. Run the stack (separate terminals)
npm run dev:backend      # API on :4000
npm run worker -w backend  # BullMQ processing worker
npm run dev:frontend     # Next.js on :3000
```

Backend configuration lives in `backend/.env` (see Prisma/S3/Redis settings there). Tests always run against local MinIO regardless of the configured bucket.

## Testing

```bash
npm run test:backend   # vitest — smoke + regression suites against real local Postgres/Redis/MinIO
```

## Development process

This repo is built by a four-role agent system (Master, Planner, Developer, Tester) coordinated through `agents/STATUS.md`, specs in `specs/`, and dated reports in `reports/` — see [CLAUDE.md](CLAUDE.md) for the protocol, and `PhotoSphere_AI_Master_Roadmap.md` for the full roadmap.
