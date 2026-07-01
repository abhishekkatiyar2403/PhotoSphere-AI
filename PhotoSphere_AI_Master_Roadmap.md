# PhotoSphere AI — Master Engineering Roadmap
> **Vision:** Build the world's most intelligent, privacy-first photo organization and sharing platform that beats Google Photos, Apple Photos, and Dropbox by giving users full ownership, control, and a superior sharing experience.

---

## Table of Contents
1. [Project Philosophy](#1-project-philosophy)
2. [Market Differentiation](#2-market-differentiation)
3. [Full Feature Breakdown](#3-full-feature-breakdown)
4. [System Architecture](#4-system-architecture)
5. [Tech Stack — Every Tool Explained](#5-tech-stack--every-tool-explained)
6. [Database Schema](#6-database-schema)
7. [Phase 1 — MVP (Days 1–90)](#7-phase-1--mvp-days-190)
8. [Phase 2 — Growth (Days 91–180)](#8-phase-2--growth-days-91180)
9. [Phase 3 — Scale (Days 181–365)](#9-phase-3--scale-days-181365)
10. [Phase 4 — Enterprise & Platform (Year 2)](#10-phase-4--enterprise--platform-year-2)
11. [API Design](#11-api-design)
12. [Security Architecture](#12-security-architecture)
13. [AI/ML Pipeline](#13-aiml-pipeline)
14. [Guest Access & OTP Approval System](#14-guest-access--otp-approval-system)
15. [DevOps & Infrastructure](#15-devops--infrastructure)
16. [Monetization Strategy](#16-monetization-strategy)
17. [Competitive Moat](#17-competitive-moat)
18. [90-Day Sprint Plan](#18-90-day-sprint-plan)

---

## 1. Project Philosophy

PhotoSphere AI is built on three non-negotiable principles:

- **Ownership** — users own their data. No training on user photos. No selling metadata.
- **Control** — users decide exactly who sees what, when, and for how long.
- **Intelligence** — AI handles the tedious work so users focus on memories, not management.

These three principles are things Google Photos, Apple Photos, and Dropbox structurally cannot offer because of their own business models. This is the moat.

---

## 2. Market Differentiation

| Feature | Google Photos | Apple Photos | Dropbox | **PhotoSphere AI** |
|---|---|---|---|---|
| AI Organization | ✅ | ✅ | ❌ | ✅ |
| Self-hostable | ❌ | ❌ | ❌ | ✅ |
| Folder-level guest access | ❌ | ❌ | Partial | ✅ |
| Owner OTP approval on access | ❌ | ❌ | ❌ | ✅ |
| Per-user per-folder permissions | ❌ | ❌ | Team plans only | ✅ |
| Audit trail (who viewed/downloaded) | ❌ | ❌ | Business only | ✅ |
| Guest access without full account | ❌ | ❌ | ❌ | ✅ |
| Custom AI categories | ❌ | ❌ | ❌ | ✅ |
| Download watermarking | ❌ | ❌ | ❌ | ✅ |
| WhatsApp/SMS shareable links | ❌ | ❌ | ❌ | ✅ |
| No data used for AI training | ❌ | ✅ | ✅ | ✅ |
| Photographer client portals | ❌ | ❌ | ❌ | ✅ |

---

## 3. Full Feature Breakdown

### Core Features (MVP)
- **Photo Upload** — drag & drop, bulk upload, mobile camera roll import
- **AI Classification** — auto-sort into categories using Vision API
- **Folder Management** — auto-create folders, rename, merge, delete
- **Search** — keyword search across categories and metadata
- **EXIF Extraction** — date, GPS, camera model auto-tagged on ingest
- **Duplicate Detection** — perceptual hashing (pHash) before classification
- **Thumbnail Generation** — multiple resolutions generated on upload

### Sharing & Access Control (MVP)
- **Guest Invite System** — owner creates guest with email, scoped to specific folders
- **Owner OTP Approval** — when guest clicks invite link first time, owner gets OTP + guest details, must approve
- **Folder-level Permissions** — view / download / download-all per guest per folder
- **Access Expiry** — set time-limited access (7 days, 30 days, custom)
- **One-tap Revocation** — owner removes any guest instantly from dashboard
- **Shareable Short Links** — photosphere.app/g/xK92mP — works via WhatsApp, SMS, email
- **Audit Log** — every view, download, and approval logged with timestamp + device

### Advanced Features (Phase 2)
- **Face Recognition** — group photos by person, name people, share by person
- **Smart Albums** — auto-generated albums (e.g., "Summer 2024", "Jake's Birthday")
- **Natural Language Search** — "beach photos where everyone is smiling"
- **Download Watermarking** — invisible steganographic watermark with guest ID
- **Client Portals** — branded portal for photographers to deliver work to clients
- **White-label** — custom domain + logo for professional accounts
- **Mobile App** — iOS + Android for upload, browse, approve guest access
- **Push Notifications** — real-time OTP approval via mobile push

### Enterprise Features (Phase 3+)
- **Team Workspaces** — multiple owners, shared collections, internal RBAC
- **Custom AI Categories** — define your own classification schema (real estate, insurance, medical)
- **API Access** — programmatic upload, classification, permission management
- **Webhook Triggers** — "when photo classified as X, send to Slack / create Jira ticket"
- **SSO / SAML** — enterprise identity integration
- **On-premise Deployment** — Docker + Kubernetes for regulated industries
- **Advanced Analytics** — storage usage, access patterns, popular folders
- **SLA + Support** — 99.9% uptime guarantee, dedicated support

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                              │
│   React Web App    │    Mobile App (iOS/Android)    │  Guest Portal│
└───────────┬─────────────────────┬──────────────────────┬────────┘
            │                     │                      │
            ▼                     ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API GATEWAY (Kong / AWS API GW)             │
│              Rate Limiting │ Auth │ Routing │ Logging            │
└───────────┬─────────────────────┬──────────────────────┬────────┘
            │                     │                      │
    ┌───────▼──────┐    ┌─────────▼──────┐    ┌─────────▼──────┐
    │  Auth Service │    │  Photo Service │    │  Share Service │
    │  (Node.js)   │    │  (Node.js)     │    │  (Node.js)     │
    └───────┬──────┘    └───────┬────────┘    └────────┬───────┘
            │                   │                      │
            ▼                   ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                        MESSAGE QUEUE (BullMQ / SQS)              │
│         Upload Jobs │ Classification Jobs │ Notification Jobs     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  AI Worker Pool │
                    │  (Python/FastAPI)│
                    │  - Preprocess   │
                    │  - Vision API   │
                    │  - pHash dedup  │
                    │  - EXIF extract │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                     ▼
┌──────────────┐  ┌──────────────────┐  ┌─────────────────┐
│  PostgreSQL  │  │   S3 / R2        │  │  Redis Cache    │
│  (primary DB)│  │  (photo storage) │  │  (sessions,     │
│              │  │  Private ACLs    │  │   OTP, queue)   │
└──────────────┘  └──────────────────┘  └─────────────────┘
```

### Key Architecture Decisions

**Async-first:** Every upload triggers a queue job. HTTP response is instant. Classification happens in background. User gets notified when done. Never block a request on AI processing.

**Storage isolation:** Photos live in S3/R2 with private ACLs. No direct URL ever exposed to client. Every image request generates a time-limited pre-signed URL (60 second expiry) after permission check. Even if someone copies a URL, it dies in 60 seconds.

**Microservices-lite:** Three core services (Auth, Photo, Share) that can be deployed independently. Not full microservices chaos — monorepo, shared DB, separated by concern. Easier to start, easy to split later.

**CDN for thumbnails:** Thumbnails served via CloudFront/Cloudflare. Originals only via signed URL through backend. Massive cost and performance difference.

---

## 5. Tech Stack — Every Tool Explained

### Frontend
| Tool | Why |
|---|---|
| **Next.js 14** | SSR for fast first load, App Router, built-in API routes |
| **TypeScript** | Type safety across full stack, fewer runtime bugs |
| **Tailwind CSS** | Fast styling, consistent design system |
| **React Query (TanStack)** | Server state management, auto-refetch, cache |
| **Zustand** | Client state (modals, selections, upload progress) |
| **React Dropzone** | Drag & drop file uploads |
| **Sharp (via API)** | Client-side image preview before upload |

### Backend
| Tool | Why |
|---|---|
| **Node.js + Express** | Fast to build, huge ecosystem, good for I/O heavy work |
| **FastAPI (Python)** | AI worker service — Python is the ML lingua franca |
| **BullMQ** | Job queue for async photo processing (Redis-backed) |
| **Prisma ORM** | Type-safe DB queries, migrations, great DX |
| **Zod** | Runtime schema validation on all API inputs |
| **Multer** | File upload handling middleware |
| **Sharp** | Server-side image resizing and thumbnail generation |

### Database & Storage
| Tool | Why |
|---|---|
| **PostgreSQL** | Relational data (users, folders, permissions) — use the right tool |
| **Redis** | Session store, OTP cache, BullMQ backend, rate limiting |
| **AWS S3 or Cloudflare R2** | R2 has zero egress fees — significant cost saving at scale |
| **CloudFront / Cloudflare CDN** | Thumbnail delivery, global edge caching |

### AI / ML
| Tool | Why |
|---|---|
| **Google Vision API** | Best-in-class classification, $1.50/1000 images, no training needed |
| **AWS Rekognition** | Alternative/fallback, face detection, scene analysis |
| **CLIP (OpenAI)** | Local semantic image-text matching for NL search (Phase 2) |
| **face-api.js / DeepFace** | Face recognition for people grouping (Phase 2) |
| **ExifTool / exifr** | EXIF metadata extraction (date, GPS, camera) |
| **Sharp pHash** | Perceptual hashing for duplicate detection |

### DevOps & Infrastructure
| Tool | Why |
|---|---|
| **Docker + Docker Compose** | Local dev parity, self-hosted deployment option |
| **Kubernetes (EKS/GKE)** | Production orchestration at scale |
| **GitHub Actions** | CI/CD — test, build, deploy on every PR |
| **Terraform** | Infrastructure as code — reproducible environments |
| **Datadog / Grafana** | Monitoring, alerting, dashboards |
| **Sentry** | Error tracking — know before users report |
| **AWS SES / Resend** | Transactional email (invites, OTP, notifications) |
| **Twilio** | SMS OTP delivery to owner |

### Auth & Security
| Tool | Why |
|---|---|
| **Passport.js** | Auth middleware — local, Google OAuth, magic links |
| **bcrypt** | Password hashing |
| **opaque tokens** | Session management (not JWT — need server-side revocation) |
| **Helmet.js** | HTTP security headers |
| **express-rate-limit** | API rate limiting |
| **node-forge / crypto** | OTP generation, token hashing |

---

## 6. Database Schema

```sql
-- USERS
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),           -- null for OAuth users
  name VARCHAR(255),
  plan VARCHAR(50) DEFAULT 'free',      -- free | pro | enterprise
  storage_used_bytes BIGINT DEFAULT 0,
  storage_limit_bytes BIGINT DEFAULT 5368709120, -- 5GB free
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- COLLECTIONS (a user's upload batch / project)
CREATE TABLE collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- FOLDERS (categories within a collection)
CREATE TABLE folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,           -- 'People', 'Travel', custom
  category_type VARCHAR(100),           -- ai_generated | custom
  photo_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PHOTOS
CREATE TABLE photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  collection_id UUID REFERENCES collections(id),
  folder_id UUID REFERENCES folders(id),
  original_filename VARCHAR(500) NOT NULL,
  s3_key VARCHAR(1000) NOT NULL,        -- full S3 object key
  s3_thumbnail_key VARCHAR(1000),       -- thumbnail S3 key
  file_size_bytes BIGINT,
  mime_type VARCHAR(100),
  width INT,
  height INT,
  phash VARCHAR(64),                    -- perceptual hash for dedup
  exif_taken_at TIMESTAMPTZ,           -- from EXIF
  exif_gps_lat DECIMAL(10, 8),
  exif_gps_lng DECIMAL(11, 8),
  exif_camera_make VARCHAR(100),
  exif_camera_model VARCHAR(100),
  ai_classification_status VARCHAR(50) DEFAULT 'pending', -- pending|done|failed
  ai_confidence DECIMAL(5, 4),
  ai_labels JSONB,                      -- raw labels from Vision API
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- GUEST USERS (lightweight — not full accounts)
CREATE TABLE guest_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255),
  name VARCHAR(255),
  created_by UUID REFERENCES users(id), -- the owner who invited them
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- INVITE TOKENS (the shareable link)
CREATE TABLE invite_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash VARCHAR(255) UNIQUE NOT NULL, -- SHA-256 of actual token
  collection_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id),
  max_uses INT,                         -- null = unlimited
  use_count INT DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- FOLDER PERMISSIONS (which guest can access which folder)
CREATE TABLE folder_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_user_id UUID REFERENCES guest_users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  permission_level VARCHAR(50) NOT NULL, -- view | download | download_all
  expires_at TIMESTAMPTZ,
  granted_by UUID REFERENCES users(id),
  revoked_at TIMESTAMPTZ,              -- null = active
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(guest_user_id, folder_id)
);

-- ACCESS REQUESTS (OTP approval flow)
CREATE TABLE access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_token_id UUID REFERENCES invite_tokens(id),
  guest_user_id UUID REFERENCES guest_users(id),
  ip_address INET,
  device_info JSONB,                    -- OS, browser, device type
  location_city VARCHAR(100),
  location_country VARCHAR(100),
  status VARCHAR(50) DEFAULT 'pending', -- pending|approved|denied|expired
  otp_hash VARCHAR(255),               -- hashed OTP sent to owner
  otp_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id)
);

-- GUEST SESSIONS
CREATE TABLE guest_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_user_id UUID REFERENCES guest_users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) UNIQUE NOT NULL,
  ip_address INET,
  user_agent TEXT,
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AUDIT LOG
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type VARCHAR(50) NOT NULL,      -- owner | guest
  actor_id UUID NOT NULL,
  action VARCHAR(100) NOT NULL,         -- view | download | download_all | approve | deny | revoke
  resource_type VARCHAR(50),            -- photo | folder | collection
  resource_id UUID,
  metadata JSONB,                       -- extra context
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PROCESSING JOBS
CREATE TABLE processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id UUID REFERENCES photos(id) ON DELETE CASCADE,
  job_type VARCHAR(100) NOT NULL,       -- classify | thumbnail | phash | exif
  status VARCHAR(50) DEFAULT 'queued', -- queued|processing|done|failed
  attempts INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- KEY INDEXES
CREATE INDEX idx_photos_owner ON photos(owner_id);
CREATE INDEX idx_photos_folder ON photos(folder_id);
CREATE INDEX idx_photos_phash ON photos(phash);
CREATE INDEX idx_photos_exif_date ON photos(exif_taken_at);
CREATE INDEX idx_folder_perms_guest ON folder_permissions(guest_user_id);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);
CREATE INDEX idx_access_requests_status ON access_requests(status, created_at);
```

---

## 7. Phase 1 — MVP (Days 1–90)

**Goal:** Get to first paying customer. Prove the core loop works.

**Definition of Done:** A photographer can upload 500 photos, AI organizes them, they share specific folders with clients via invite link with OTP approval, client downloads photos.

### Week 1–2: Foundation
- [ ] Set up monorepo (Next.js frontend + Node.js backend + Python AI worker)
- [ ] Docker Compose for local dev (PostgreSQL + Redis + MinIO as S3 mock)
- [ ] GitHub Actions CI pipeline (lint + test on every PR)
- [ ] PostgreSQL schema migrations via Prisma
- [ ] Basic auth: signup, login, JWT session (switch to opaque tokens in Week 3)
- [ ] Environment config management (.env, secrets)

### Week 3–4: Photo Upload Pipeline
- [ ] File upload API with Multer (multipart, max 50MB per file)
- [ ] S3/R2 integration — store originals with private ACLs
- [ ] BullMQ job queue setup
- [ ] Sharp thumbnail generation worker (generate 3 sizes: 150px, 400px, 1200px)
- [ ] EXIF extraction on upload (date, GPS, camera)
- [ ] pHash generation for duplicate detection
- [ ] Upload progress tracking via polling endpoint

### Week 5–6: AI Classification
- [ ] Google Vision API integration
- [ ] Category mapping (Vision labels → PhotoSphere folders)
- [ ] Confidence threshold handling (< 60% → "Uncategorized" bucket)
- [ ] Folder auto-creation per collection
- [ ] Retry logic for failed classification jobs
- [ ] Manual reclassification UI (user can move photos between folders)

### Week 7–8: Core UI
- [ ] Dashboard — collection overview, storage usage
- [ ] Folder browser — grid view of photos per category
- [ ] Photo viewer — fullscreen, EXIF info panel
- [ ] Upload flow — drag & drop with progress bar
- [ ] Duplicate detection warning before upload

### Week 9–10: Guest Access + OTP System
- [ ] Guest invite creation (email + folder selection + permissions)
- [ ] Invite token generation and storage
- [ ] Short link generation (photosphere.app/g/[token])
- [ ] Access request flow — capture device/IP/location on link click
- [ ] OTP generation → send to owner via email (SMS in Phase 2)
- [ ] Owner approval dashboard — see pending requests, approve/deny
- [ ] Guest session creation on approval
- [ ] Folder permission enforcement on all photo/folder endpoints
- [ ] Pre-signed URL generation for authorized photo access (60s expiry)
- [ ] Guest view — scoped folder browser, download button
- [ ] One-tap revocation from owner dashboard

### Week 11–12: Audit, Polish, Launch Prep
- [ ] Audit log — record all views, downloads, approvals
- [ ] Owner activity dashboard — see who accessed what, when
- [ ] Email notifications (invite sent, access approved, access expiring)
- [ ] Basic search (by folder, by date, by filename)
- [ ] Error handling, loading states, empty states throughout UI
- [ ] Rate limiting on all APIs
- [ ] Security headers (Helmet.js)
- [ ] Deploy to production (AWS or Railway for MVP)
- [ ] Basic pricing page + Stripe integration (Free / Pro $19/mo)

---

## 8. Phase 2 — Growth (Days 91–180)

**Goal:** 1,000 paying users. Expand features. Build mobile app.

### Features to Build
- [ ] **Face Recognition** — group by person using DeepFace/face-api.js
- [ ] **Smart Albums** — auto-generate by date, location, event clustering
- [ ] **Natural Language Search** — CLIP embeddings for semantic search ("beach with sunset")
- [ ] **Mobile App** — React Native (iOS + Android)
  - Camera roll sync
  - Push notifications for OTP approval
  - One-tap approve/deny on guest access requests
- [ ] **Client Portals** — photographer-branded delivery pages
  - Custom logo/color
  - Client sees professional delivery experience, not raw app
- [ ] **Download Watermarking** — steganographic guest ID embed
- [ ] **SMS OTP** — Twilio integration (faster than email for owner approval)
- [ ] **Bulk Operations** — select multiple photos, move/delete/download
- [ ] **Collection Sharing Templates** — save permission sets for reuse
- [ ] **Guest Self-service** — guest can request access extension

### Infrastructure
- [ ] Move to Kubernetes (EKS) for auto-scaling
- [ ] Redis Cluster for high availability
- [ ] Read replicas for PostgreSQL
- [ ] CDN for thumbnail delivery globally
- [ ] Datadog monitoring + alerting

---

## 9. Phase 3 — Scale (Days 181–365)

**Goal:** $1M ARR. Enterprise accounts. API product.

### Features to Build
- [ ] **Team Workspaces** — multiple owners, shared collections
- [ ] **Custom AI Categories** — user-defined classification schemas
- [ ] **REST API** — programmatic access for B2B integrations
- [ ] **Webhooks** — trigger external actions on classification events
- [ ] **White-label** — custom domain for client portals
- [ ] **Advanced Analytics** — usage dashboards, popular content, access heatmaps
- [ ] **Bulk Import** — Google Photos takeout, iCloud export, Dropbox migration
- [ ] **Video Support** — extend pipeline to video thumbnails + scene classification
- [ ] **SSO / SAML** — enterprise identity (Okta, Azure AD)

### Infrastructure
- [ ] Multi-region deployment (US + EU for GDPR)
- [ ] On-premise Kubernetes chart (Docker Hub publish)
- [ ] SOC 2 Type II compliance process
- [ ] 99.9% SLA infrastructure

---

## 10. Phase 4 — Enterprise & Platform (Year 2)

**Goal:** $10M ARR. Platform play. Vertical SaaS dominance.

- [ ] **Vertical-specific products** — PhotoSphere for Real Estate, for Insurance, for Healthcare
- [ ] **Marketplace** — third-party workflow integrations (Salesforce, HubSpot, ServiceNow)
- [ ] **On-device AI** — local model inference for fully air-gapped enterprise deployments
- [ ] **Data residency** — EU-only, APAC-only storage options
- [ ] **Partner program** — photography studios, real estate agencies as resellers
- [ ] **Acquisition targets** — small photo editing or DAM tools to roll up

---

## 11. API Design

### Core Endpoints (REST)

```
AUTH
POST   /api/auth/signup
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/auth/magic-link

PHOTOS
POST   /api/photos/upload           # multipart, returns job_id
GET    /api/photos/:id              # returns pre-signed URL
DELETE /api/photos/:id

COLLECTIONS
GET    /api/collections             # list user's collections
POST   /api/collections             # create
GET    /api/collections/:id
DELETE /api/collections/:id

FOLDERS
GET    /api/collections/:id/folders
POST   /api/collections/:id/folders # manual folder creation
PATCH  /api/folders/:id             # rename, reorder
DELETE /api/folders/:id

GUEST ACCESS
POST   /api/guests                  # create guest invite
GET    /api/guests                  # list all guests + status
DELETE /api/guests/:id              # revoke access
POST   /api/invites/:token/request  # guest clicks link — creates access_request
POST   /api/access-requests/:id/approve # owner approves with OTP
POST   /api/access-requests/:id/deny

GUEST PORTAL (scoped by session token)
GET    /api/guest/folders           # only permitted folders
GET    /api/guest/folders/:id/photos
GET    /api/guest/photos/:id/download # generates pre-signed URL

AUDIT
GET    /api/audit                   # owner's full activity log
```

---

## 12. Security Architecture

### Layered Security Model

```
Layer 1: Transport     — HTTPS everywhere, HSTS headers
Layer 2: Auth          — opaque session tokens, HttpOnly cookies
Layer 3: Authorization — permission check on every request
Layer 4: Storage       — private S3 ACLs, pre-signed URLs (60s TTL)
Layer 5: OTP Gate      — owner real-time approval for first access
Layer 6: Audit         — immutable log of all actions
Layer 7: Rate Limiting — per-IP and per-user limits
```

### OTP Security Details
- OTP is 6 digits, generated using `crypto.randomInt(100000, 999999)`
- Stored as SHA-256 hash in DB — never plaintext
- Valid for 5 minutes only
- Single-use — invalidated immediately after successful use
- Max 3 wrong attempts → request auto-denied, owner notified
- Owner notified via email (Phase 1) + SMS (Phase 2) + push (Phase 2)

### Pre-signed URL Flow
```
Guest requests photo
→ Backend checks guest_session is valid (not revoked)
→ Backend checks folder_permissions (permission_level ≥ view)
→ Backend logs audit event
→ Backend calls S3 presignUrl(key, expiresIn: 60)
→ Returns 302 redirect to pre-signed URL
→ URL expires in 60 seconds — safe to cache by browser
```

### Data Protection
- All photos encrypted at rest (S3 SSE-S3 or SSE-KMS)
- DB encrypted at rest (RDS encryption)
- No user photo data used for AI model training
- GDPR: delete endpoint removes all data including S3 objects within 30 days
- Passwords: bcrypt with cost factor 12

---

## 13. AI/ML Pipeline

### Classification Pipeline (per photo)

```
1. INGEST
   - Receive S3 upload event
   - Enqueue job in BullMQ

2. PREPROCESS (Sharp)
   - Resize to 1024px max for API submission (cost control)
   - Generate thumbnails (150, 400, 1200px) → upload to S3
   - Extract EXIF metadata

3. DEDUP (pHash)
   - Compute perceptual hash
   - Query DB for existing photos with hamming distance < 10
   - If duplicate found: flag, skip classification, notify owner

4. CLASSIFY (Google Vision API)
   - Submit preprocessed image
   - Receive label annotations with confidence scores
   - Map labels to PhotoSphere categories using priority mapping

5. CATEGORY MAPPING LOGIC
   - "Person", "Face", "People" → People
   - "Tree", "Mountain", "Ocean", "Flower" → Nature
   - "Dog", "Cat", "Bird", "Animal" → Animals
   - "Food", "Meal", "Dish", "Restaurant" → Food
   - "Car", "Truck", "Motorcycle", "Bicycle" → Vehicles
   - "Passport", "Receipt", "Document", "Text" → Documents
   - "Screenshot", "App", "UI" → Screenshots
   - Multi-label: photo gets primary folder + secondary tags
   - Confidence < 60%: → Uncategorized (user reviews)

6. STORE RESULTS
   - Update photos table: folder_id, ai_labels, ai_confidence
   - Update processing_jobs: status = done
   - Emit event → notify frontend via polling endpoint

7. ERROR HANDLING
   - Retry up to 3 times with exponential backoff
   - After 3 failures: status = failed, alert owner
   - Dead letter queue for analysis
```

### Cost Optimization
- pHash dedup before API call: saves ~20-30% API cost (typical duplicate rate)
- Resize before API submission: Vision API costs same for 100px or 4000px
- Cache classification results: same image hash → same result, skip API
- Batch API calls where possible (Vision API supports batch)

---

## 14. Guest Access & Cloud Export System

### Complete Flow Diagram

```
OWNER SIDE                              GUEST SIDE
─────────────────────────────────────────────────────

1. Owner opens "Share" panel
   Selects folders: [People] [Travel]
   Sets permissions: download
   Sets expiry: 30 days
   Enters guest email: sarah@gmail.com
   Clicks "Create Invite"
         │
         ▼
2. System creates:
   - guest_user record
   - invite_token (UUID → hashed)
   - folder_permissions records
   - Short link: /g/xK92mP
         │
         ▼
3. System sends email to sarah@gmail.com:
   "John shared photos with you"
   [View Photos] button → /g/xK92mP
                                              │
                                              ▼
                                    4. Sarah clicks link
                                       System captures:
                                       - IP: 203.x.x.x
                                       - Device: iPhone 14, Safari
                                       - Location: New York, US
                                       - Time: 2:34 PM
                                       Creates access_request (pending)
                                       Sarah sees: "Waiting for approval..."
         │
         ▼
5. Sarah's page detects link is valid → session created → folder permissions activated
         │
         ▼
5a. [EXPORT TO CLOUD] — Sarah (or Owner) clicks "Send to Drive / Dropbox / OneDrive"
   ─────────────────────────────────────────────────────
   📤 Export Folder: "People" (142 photos)

   Choose destination:
   [Google Drive]  [Dropbox]  [OneDrive]  [iCloud Drive]

   Destination folder: /PhotoSphere/Wedding Photos/People
   ─────────────────────────────────────────────────────
         │
    ┌────┴──────────────────┐
    │                       │
    ▼                       ▼
OWNER exports            GUEST exports
any folder to            their permitted
their own cloud          folder to their
storage                  own cloud storage
         │                       │
         ▼                       ▼
    Backend uses            Backend uses
    OAuth token             guest OAuth token
    (Google/Dropbox         (separately connected
    connected by user)      by guest on first use)
         │                       │
         └──────────┬────────────┘
                    ▼
    Photos streamed from S3 → uploaded
    directly to cloud destination
    (never downloaded to browser)
         │
         ▼
                                    7. Sarah's page detects
                                       approval (polling 3s)
                                       Redirects to folder view
                                              │
                                              ▼
                                    8. Sarah sees ONLY:
                                       [People] [Travel]
                                       No other folders visible
                                              │
                                              ▼
                                    9. Sarah downloads photos
                                       Every action logged in
                                       owner's audit trail

OWNER CAN REVOKE ANYTIME:
Dashboard → Guests → [Revoke] next to Sarah
→ guest_session.revoked_at = NOW()
→ Sarah's next request → 403 Forbidden
→ Sarah sees: "Your access has been removed"
```

### Cloud Export Feature — Implementation Details

**Supported Platforms (Phase 1):**
- Google Drive (OAuth 2.0 + Drive API v3)
- Dropbox (OAuth 2.0 + Dropbox API v2)
- OneDrive (OAuth 2.0 + Microsoft Graph API)
- iCloud Drive — via WebDAV (Phase 2, Apple limitations apply)

**How it works technically:**
```
User clicks "Export folder to Google Drive"
→ Check if Google OAuth token exists for user
→ If not: OAuth consent popup → user grants Drive access → token stored (encrypted)
→ Backend enqueues export job (BullMQ)
→ Worker streams each photo: S3 → memory buffer → Google Drive upload API
→ Photos land in: Drive / PhotoSphere / [Collection Name] / [Folder Name] /
→ Progress tracked in DB → user sees live progress bar
→ On completion: user notified with Drive folder link
```

**Key design decisions:**
- **Stream, don't download** — photos go S3 → Drive API directly via server. Never touch the user's browser or device. Handles 10,000 photo exports without memory issues.
- **Resumable uploads** — use Google Drive / Dropbox resumable upload APIs. If export job crashes midway, it resumes from last successful photo.
- **Incremental sync** — track which photos have already been exported (export_log table). Re-running export only uploads new/changed photos. No duplicates in Drive.
- **Guest exports** — guests connect their own cloud account. They only export folders they have permission to access. Backend enforces this before starting the job.

**New API Endpoints:**
```
POST /api/exports/connect/:provider     # OAuth connect (google | dropbox | onedrive)
GET  /api/exports/status/:job_id        # poll export progress
POST /api/folders/:id/export            # trigger export for a folder
POST /api/collections/:id/export        # trigger export for full collection
GET  /api/exports/history               # list past exports with Drive links
```

**New DB table:**
```sql
export_jobs table:
- id UUID
- user_id / guest_user_id
- folder_id
- provider VARCHAR(50)        -- google_drive | dropbox | onedrive
- destination_path TEXT       -- remote folder path
- status VARCHAR(50)          -- queued | running | done | failed
- total_photos INT
- exported_count INT
- remote_folder_url TEXT      -- link to destination folder when done
- started_at / completed_at TIMESTAMPTZ

oauth_tokens table:
- user_id / guest_user_id
- provider VARCHAR(50)
- access_token TEXT (encrypted at rest)
- refresh_token TEXT (encrypted at rest)
- expires_at TIMESTAMPTZ
```

---

## 15. DevOps & Infrastructure

### Environments
```
local    → Docker Compose (PostgreSQL + Redis + MinIO)
staging  → AWS (single instance, same stack as prod)
production → AWS EKS (Kubernetes, multi-node)
```

### CI/CD Pipeline (GitHub Actions)
```
On PR:
  1. Lint (ESLint + Prettier)
  2. Type check (tsc --noEmit)
  3. Unit tests (Jest)
  4. Integration tests (against test DB)
  5. Build Docker image
  6. Security scan (Trivy)
  → All pass → PR can merge

On merge to main:
  1. Build & push Docker image to ECR
  2. Run DB migrations
  3. Deploy to staging
  4. Run smoke tests
  5. Manual approval gate
  6. Deploy to production (rolling update)
```

### Scaling Plan
```
0–1K users:    Single server (Railway / Render) — $50/month
1K–10K users:  AWS ECS (Fargate) — auto-scaling containers
10K–100K users: EKS + RDS + ElastiCache — full cloud native
100K+ users:   Multi-region, read replicas, global CDN
```

---

## 16. Monetization Strategy

### Pricing Tiers

| Plan | Price | Storage | Guests | Features |
|---|---|---|---|---|
| **Free** | $0 | 5 GB | 3 guests | Basic upload + classify |
| **Pro** | $19/mo | 100 GB | Unlimited | All sharing features + audit log |
| **Studio** | $49/mo | 500 GB | Unlimited | Client portals + watermarking + white-label |
| **Enterprise** | Custom | Unlimited | Unlimited | API + SSO + on-premise + SLA |

### Revenue Projections (Conservative)
```
Month 6:  500 Pro users × $19     = $9,500 MRR
Month 12: 2,000 Pro + 200 Studio  = $47,800 MRR (~$570K ARR)
Month 18: 5,000 Pro + 500 Studio  = $119,500 MRR (~$1.4M ARR)
Year 2:   10K Pro + 1K Studio + 
          50 Enterprise ($500 avg) = $263,000 MRR (~$3.1M ARR)
```

### Expansion Revenue
- **Storage add-ons** — $5/month per 100GB extra
- **White-label** — $30/month add-on for custom domain + branding
- **API access** — $99/month for programmatic access
- **Priority processing** — $10/month for instant AI classification vs queue

---

## 17. Competitive Moat

### Why You Win Long-Term

**Network effects:** The more photographers use PhotoSphere, the more clients experience it. Clients who love the guest portal experience tell other photographers. Organic B2B word-of-mouth loop.

**Data moat:** Every manual reclassification a user makes improves their personal classification model. Over time, PhotoSphere knows your specific workflow better than any generic tool. This personalization is impossible to replicate with a fresh account elsewhere.

**Switching cost:** Once a photographer has 10,000 photos organized, audit logs of 50 deliveries, and client portals set up — the cost of switching is enormous. Lock-in that users actually appreciate because the data is theirs.

**Privacy positioning:** As data privacy regulations tighten globally (GDPR, CCPA, and future laws), the "your data never leaves your control" positioning becomes more valuable, not less.

---

## 18. 90-Day Sprint Plan

```
WEEK 1–2:   Foundation & Auth
            ├── Monorepo setup
            ├── DB schema + migrations  
            ├── Auth (signup/login/sessions)
            └── CI/CD pipeline

WEEK 3–4:   Upload Pipeline
            ├── S3 integration
            ├── BullMQ job queue
            ├── Thumbnail generation
            └── EXIF + pHash

WEEK 5–6:   AI Classification
            ├── Vision API integration
            ├── Category mapping
            ├── Folder auto-creation
            └── Retry + error handling

WEEK 7–8:   Core UI
            ├── Dashboard
            ├── Folder browser
            ├── Photo viewer
            └── Upload flow

WEEK 9–10:  Guest Access + OTP
            ├── Invite creation
            ├── Short link generation
            ├── Access request + device capture
            ├── OTP generation + email delivery
            ├── Owner approval dashboard
            ├── Guest session + permissions
            └── Revocation

WEEK 11:    Audit + Security
            ├── Audit log
            ├── Activity dashboard
            ├── Rate limiting
            └── Security headers

WEEK 12:    Launch
            ├── Stripe integration
            ├── Production deploy
            ├── Beta user onboarding
            └── Feedback loops
```

---

## Quick Reference: Tools Summary

```
Frontend:   Next.js 14 + TypeScript + Tailwind + React Query + Zustand
Backend:    Node.js + Express + Prisma + BullMQ + Zod + Multer + Sharp
AI Worker:  Python + FastAPI + Google Vision API + ExifTool
Database:   PostgreSQL (primary) + Redis (cache/queue/sessions)
Storage:    Cloudflare R2 (photos) + CloudFront (thumbnails)
Auth:       Passport.js + bcrypt + opaque session tokens
Email:      AWS SES or Resend
SMS:        Twilio
DevOps:     Docker + GitHub Actions + Terraform + AWS EKS
Monitoring: Datadog + Sentry
Payments:   Stripe
```

---

*Document Version: 1.0 | Created for Claude Code context handoff*
*Next: Run `cat PhotoSphere_AI_Master_Roadmap.md` to load full context*
