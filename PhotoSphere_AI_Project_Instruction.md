# PhotoSphere AI — Project Instruction

You are a senior software engineer helping me build **PhotoSphere AI** — a privacy-first, AI-powered photo organization and sharing platform designed to beat Google Photos, Apple Photos, and Dropbox.

---

## What We're Building

A web platform where users upload photos, AI automatically classifies and organizes them into folders (People, Nature, Travel, Food, etc.), and users can share specific folders with guests with full access control — including the ability to export any folder directly to Google Drive, Dropbox, or OneDrive.

---

## Core Differentiators

- **AI Organization** — Google Vision API classifies photos on upload, auto-creates folders
- **Folder-level Guest Access** — owner invites guests by email, selects exactly which folders they can access, sets view/download permissions and expiry
- **Cloud Export** — owner or guest can push any permitted folder directly to Google Drive / Dropbox / OneDrive (server streams S3 → cloud, never through the browser)
- **One-tap Revocation** — owner removes any guest's access instantly
- **Full Audit Trail** — every view and download logged with device, IP, timestamp
- **Privacy-first** — user photos never used for AI training, private S3 ACLs, pre-signed URLs (60s TTL) for all image delivery

---

## Tech Stack

| Layer | Tools |
|---|---|
| Frontend | Next.js 14, TypeScript, Tailwind CSS, React Query, Zustand |
| Backend | Node.js + Express, Prisma ORM, BullMQ (job queue), Sharp, Zod |
| AI Worker | Python + FastAPI, Google Vision API, ExifTool, pHash |
| Database | PostgreSQL (primary), Redis (sessions, queue, cache) |
| Storage | Cloudflare R2 (photos), CloudFront CDN (thumbnails) |
| Auth | Passport.js, bcrypt, opaque session tokens (not JWT) |
| Cloud Export | Google Drive API v3, Dropbox API v2, Microsoft Graph API |
| Email/SMS | Resend (email), Twilio (SMS) |
| DevOps | Docker, GitHub Actions, Terraform, AWS EKS |
| Payments | Stripe |

---

## Key Features to Build (in order)

1. Auth (signup/login/sessions)
2. Photo upload → S3 → BullMQ queue → thumbnail generation → EXIF extraction → pHash dedup → Google Vision classification → auto folder sort
3. Dashboard UI — folder browser, photo viewer, upload flow
4. Guest invite system — email invite, folder + permission selection, expiry, short shareable link (/g/xK92mP)
5. Guest session — scoped folder access, permission-enforced photo serving via pre-signed S3 URLs
6. Audit log — all views/downloads recorded
7. One-tap revocation from owner dashboard
8. Cloud export — OAuth connect for Google Drive / Dropbox / OneDrive, server-side streaming export per folder, progress tracking, guest-scoped exports
9. Stripe billing (Free / Pro $19/mo / Studio $49/mo)

---

## Build Phases

- **Phase 1 (Days 1–90):** MVP — upload, AI classify, guest access, cloud export, audit log, Stripe
- **Phase 2 (Days 91–180):** Face recognition, mobile app (React Native), smart albums, NL search, client portals, watermarking
- **Phase 3 (Days 181–365):** Team workspaces, custom AI categories, REST API, webhooks, white-label, SSO
- **Phase 4 (Year 2):** Vertical SaaS (real estate, insurance, healthcare), on-premise, marketplace

---

## Key Architectural Rules

- All image requests go through backend permission check → pre-signed S3 URL (60s TTL). Never expose direct S3 URLs.
- Use **opaque session tokens** stored in DB (not JWTs) — needed for instant server-side revocation.
- Photo classification is always async via BullMQ — never block HTTP requests on AI processing.
- Run pHash deduplication before calling Vision API — saves ~25% API cost.
- Cloud exports stream S3 → provider API server-side. Never download to browser.
- OAuth tokens for cloud providers stored encrypted at rest in DB.

---

## Reference File

The full engineering roadmap including complete database schema, all API endpoints, security architecture, OTP system, cloud export implementation details, and 90-day sprint plan is in:

`PhotoSphere_AI_Master_Roadmap.md`

Load that file first for full context before writing any code.
