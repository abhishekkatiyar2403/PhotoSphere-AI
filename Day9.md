# Day 9

Covers everything since `Day8.md` — the biggest single stretch of the project so far, and the one where the app stopped being a mock: real AWS S3 storage, real Resend email, real Amazon Rekognition classification, a first (paused) production-deploy attempt on Railway/Vercel, and then a long manual-testing loop with Abhishek's real photos that surfaced and fixed **eight** real bugs (`Bugs.md` #11–#18) — ending with a classification engine that's been rebuilt twice over and a first push to the new `photosphereAi` GitHub account (commit `0f9a732`).

## What Day 9 covered, in one sentence

Wired the three swappable subsystems (storage, email, classification) to their real providers behind explicit opt-in env vars; attempted the first production deployment (paused at Railway's free-plan resource limit, at Abhishek's call); then ran a tight test-with-real-photos → report-bug → root-cause → fix → reclassify loop that took classification from "everything lands in Nature" to confidence-weighted dominance scoring, face-recognition-based per-person folders, and dynamic category creation from Rekognition's own taxonomy — plus real fixes to HEIC handling, the photo viewer, EXIF, storage-quota accounting, and trash-aware dedup along the way.

## Deployment attempt (Vercel + Railway) — paused, not failed

- **Target architecture:** Vercel (frontend) + Railway (two backend services — `photosphere-api` and `photosphere-worker` — sharing one Postgres + one Redis plugin), real AWS S3 for storage, Resend for email.
- **Code prep that shipped regardless of the pause** (all still correct for any future deploy):
  - `backend/scripts/start.js` — one `SERVICE_ROLE`-driven launcher (web runs `prisma migrate deploy` then the API; worker just runs the worker), since Railway's CLI can't set per-service start commands.
  - `backend/package.json` — `postinstall: prisma generate` and an `ioredis` overrides entry, both root-caused by reproducing Railway's exact isolated-install outside npm workspace hoisting.
  - Cross-site cookies: session + guest-session cookies switch to `sameSite: "none"` in production (Vercel and Railway are different domains; `lax` cookies never ride along on cross-site fetches).
  - CORS generalized from one hardcoded origin to a list (`FRONTEND_ORIGIN` + `MOBILE_DEV_ORIGIN` + `EXTRA_ALLOWED_ORIGINS`).
- **Why it's paused:** after several rounds of misleading builder errors, a trivial hello-world test deploy surfaced the real cause — **Railway's free-plan resource provision limit**. Abhishek explicitly chose "Not right now — pause the Railway deploy" rather than adding billing. Nothing is broken; it resumes whenever he does.

## Real providers wired in (the mock era ends)

All three follow the same pattern: explicit opt-in env var, mock stays the default, and **Vitest always forces the mock** (`process.env.VITEST` guard — NODE_ENV proved unreliable because the shared `.env`'s own `NODE_ENV=development` clobbered vitest's default, empirically confirmed when 25+ tests started firing real billed API calls).

- **S3** (`lib/storage.ts`): active when `AWS_S3_BUCKET` is set. Bucket `photosphere-ai-prod`, region `eu-north-1` (corrected from an initial wrong `us-east-1` via the bucket's 301 redirect header). Real buckets are verified, never auto-created.
- **Resend** (`lib/notifications/index.ts`): active when `RESEND_API_KEY` + `RESEND_FROM_EMAIL` are set; raw `fetch` POST, no SDK added. OTP-exposure test surfaces correctly return null under the real provider.
- **Rekognition** (`lib/classification/index.ts`): active only under explicit `CLASSIFICATION_PROVIDER=rekognition`, with its own `REKOGNITION_REGION` (`us-east-1`) deliberately decoupled from S3's region. IAM set up step-by-step with Abhishek through the console (including correcting his "free tier = only one policy" misconception — policies aren't limited that way; the existing one was edited instead).

## The manual-testing loop — eight real bugs, all root-caused (Bugs.md #11–#18)

- **#11 — iPhone Live Photos failed to decode:** libheif (bundled by sharp) hard-caps HEIC `iref` references at 16; real Live Photos carry 45+. Fixed with a macOS `sips` fallback decoder feeding one shared decoded buffer to thumbnails/pHash/classification. *Disclosed gap: sips is macOS-only — Linux production would still fail these files.*
- **#12 — No viewer preview + "Date taken: Unknown" for HEIC:** viewer now prefers pipeline JPEG thumbnails over the raw HEIC original (non-Safari browsers can't render HEIC at all); EXIF gets a `sips -g all` fallback since `exifr` (even at latest 7.1.3) has zero HEIC container support. *No GPS via sips — date/camera only.*
- **#13 — Temples, animals, and rivers all in one "Nature" folder:** the mock-era label table didn't know real Rekognition vocabulary, and Nature outranked Animals. Expanded the table, added an Architecture category, re-ranked priorities.
- **#14 — Storage counter never decreased + trash blocked re-uploads:** permanent purge now decrements `storageUsedBytes` (it was increment-only forever); both dedup queries now exclude trashed photos (`deletedAt: null`), so a photo you threw away can't block re-uploading it. Also answered: uploads are one-file-per-request, 50MB cap, no count limit (frontend parallelizes 3 at a time).
- **#15 — Scene photos hijacked by one "Person" label / river photo hijacked by a 55% "Shark":** replaced first-match-wins with **confidence-weighted dominance scoring** — every label above a 75% per-label floor votes for its category weighted by its own confidence (Rekognition's per-label confidences now flow through), scenery labels count half. Plus the headline feature Abhishek asked for: **face-based People folders** (`lib/classification/faces.ts`, one Rekognition face collection per owner) — 2+ faces → "Group", one face → stable "Person N" per real person, no clear face → plain "People", every failure path degrading gracefully. Needed five more IAM actions, which Abhishek added.
- **#16 — Street scene in "Person 1":** one incidental passer-by generates six near-synonymous People labels. Fixed with a face-**prominence** gate (bounding-box area ≥ ~1.5% of frame) — a tiny background face now *rejects* the People verdict entirely and the photo re-ranks to its next real category (that photo: Architecture).
- **#17 — Electronics products stuck in Uncategorized:** Rekognition labeled them perfectly; our table just had no Electronics vocabulary. Fixed twice over: Electronics as a curated category, **plus dynamic category creation** — Rekognition's own per-label taxonomy ("Technology and Computing", previously thrown away) now names an auto-created folder whenever nothing curated matches. New kinds of photos mint new categories instead of dying in Uncategorized (observed live minting "Tools" and "Weapons and Military").
- **#18 — Utensils and couches in one folder:** #17's taxonomy map had lumped three taxonomy branches into one "Home" bucket. Split into first-class **Kitchen** and **Furniture** categories, and a documented granularity rule — one taxonomy branch = one folder, never merged — so the pattern can't recur.

## New UX: "why is this photo here?"

Abhishek asked for Unfiled/Uncategorized photos to explain themselves. Every photo card and the viewer's info panel now carry a `reason` (computed server-side in `lib/photoCard.ts` from the photo's own stored labels/confidence via the same `rankCategories` the worker uses): failed → the actual error + "use Reclassify", duplicate → matched-by-what + "use Not a duplicate?", orphaned → which deleted folder it came from, Uncategorized → "confidence too low (X%)" or "these labels matched no category", each with the next action.

## Operational work

- **Zombie-worker root cause:** intermittent job weirdness traced to 8+ stale worker processes dating back days (`pkill` by wrapper-name never killed the real child processes) all racing on one BullMQ queue with stale config. The restart procedure is now kill-by-exact-PID + verify zero listeners, used for every restart since.
- **Bulk reclassify** (`backend/scripts/bulk-reclassify.ts`): re-sorts the whole library under new rules, mirroring the API's atomic claim; deliberately skips duplicates (a bulk pass shouldn't quietly overturn dedup verdicts).
- **The 116-vs-7 discovery:** that bulk pass exposed that the automated test suite runs against the same dev database Abhishek tests in — **114 leftover `@example.com` test users**. Deleted with his double-confirmed sign-off (`scripts/cleanup-test-users.ts`), leaving exactly his two real accounts. *(Standing hygiene item: the test suite should get an isolated database.)*
- **MinIO→S3 migration** (`scripts/migrate-minio-to-s3.ts`): 6 of his real photos predated the S3 switch and had become unreachable (their bytes lived only in local MinIO). Copied additively into the real bucket with his approval, then reclassified clean.

## Pushed

Everything above went up as **`0f9a732`** on `feature/ai-classification` to the new **`photosphereAi/PhotoSphere-AI`** repo (89 files; secret-scanned before commit; `.railway*/` and `.agents/` newly gitignored since pulled Railway config can carry credentials). Push to the old `origin` repo was denied (403 — the `photosphereAi` account has no write access there); flagged to Abhishek with the two ways to fix it if he wants it mirrored.

## Where things stand after Day 9

- **Classification is genuinely good now** and verified against his real library: Person 1/Person 2/Group folders working, Electronics/Kitchen/Furniture/Architecture all correct, dynamic categories minting themselves for anything new.
- **Open/deferred:** Railway deploy paused (his call, needs billing); Linux/production HEIC gap (#11/#12's sips fallback is macOS-only); Android emulator + Xcode still pending from Day 8; test-suite database isolation worth doing after the 114-test-user discovery; GPS not recoverable from HEIC via sips.
- Backend suite green at **200/200** (one known flaky rate-limiter timeout under full-suite load, passes in isolation — pre-existing, documented in Bugs.md #6).
