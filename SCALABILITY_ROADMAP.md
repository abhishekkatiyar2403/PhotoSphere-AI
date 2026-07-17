# Scalability & Architecture Roadmap

Solution-architecture review of the current backend (2026-07-13), framed around "what breaks first as load grows." Companion to `BACKEND_AUDIT.md` / `AUDIT_FIXES_TRACKER.md` — those two are about *correctness and missing features*, this one is about *what happens to today's correct code once there's more than one server or more than a handful of users*. Same convention: pick items off this list one at a time, tell me which, and we build it like a normal batch.

**Status at a glance:** 2 of 13 items done (#S13, plus #20 which shipped via `AUDIT_FIXES_TRACKER.md`), 11 remaining. Nothing here is urgent for the current single-instance/local-first MVP phase — treat this as a queue to draw from as real usage grows, not a rewrite mandate.

---

## ✅ Done (2026-07-16)

| # | Item | What was done | Files |
|---|---|---|---|
| S13 | CloudFront CDN in front of S3 for image delivery | Private S3 bucket + CloudFront distribution with Origin Access Control, signed **URLs** (not cookies — chosen because access is already permission-checked per-photo per-request, which maps directly onto "one signed URL per object" rather than a broad path-scoped cookie). `getPresignedGetUrl()` in `storage.ts` now branches: CloudFront signed URL when `CLOUDFRONT_DOMAIN` is configured against real S3, direct S3/MinIO presigned URL otherwise (local dev/test unaffected) — every caller (`photoCard.ts` thumbnails, `routes/photos.ts` + `routes/guest.ts` original/thumbnails) picked this up with zero call-site changes. Force-downloads (`getPresignedDownloadUrl`) and the worker's internal classification fetch deliberately stay on direct S3 — CDN is a display-path optimization only. **Live-verified end-to-end**: a real photo's `original.url` and all `thumbnails.*` resolved to `dilznozo49ncr.cloudfront.net` while `download` stayed on the direct S3 host; the signed URL returned `200 image/jpeg`, and the same path with the signature stripped returned `403` — confirming the key group / "Restrict viewer access" enforcement is genuinely active, not just a plausible-looking URL. | `backend/src/lib/storage.ts` (`getPresignedGetUrl` CloudFront branch), `backend/src/lib/validateEnv.ts` (fails fast in prod if `CLOUDFRONT_DOMAIN` is set without `CLOUDFRONT_KEY_PAIR_ID`/`CLOUDFRONT_PRIVATE_KEY`), `backend/package.json` (`@aws-sdk/cloudfront-signer`) |

---

## What's already right (no action needed)

These design choices already pay for themselves at scale and don't need revisiting:

- Swappable-provider pattern (storage/classification/notifications/faces) — swapping in real infra never touched call sites.
- Opaque, DB-hashed tokens everywhere (session/guest/invite/password-reset) — no JWT revocation problem to solve later.
- Async pipeline via BullMQ/Redis — upload response time is already decoupled from classification latency.
- `onDelete: Cascade` relations — account deletion is one query, not a manual fan-out that will rot as the schema grows.
- Structured `pino` logging — already in the right shape to ship to a log aggregator later with zero code change.

---

## Where it breaks first (failure ordering)

Ranked by how little load it takes to hit each ceiling — read top-to-bottom as "this is the order things will actually go wrong in":

| Trigger | What breaks | Why |
|---|---|---|
| **2nd API instance** | Rate limiting (in-memory `express-rate-limit`), worker heartbeat semantics if workers also scale out naively | Per-process state doesn't coordinate across instances — a user could get 2x the intended rate limit by hitting different instances |
| **~50–100 concurrent users** | Rekognition cost curve, `bcryptjs` blocking the event loop under login bursts | Every classification call is a metered external API hit; `bcryptjs` is pure JS and synchronous-per-hash, so concurrent logins queue behind each other |
| **~1k–10k users** | Single Postgres instance for both OLTP and search-ish label queries, single Redis for both queue + cache + rate-limit + heartbeat data, worker doing both fast interactive jobs and slow analysis jobs in one queue | Everything sharing one instance means a spike in one workload (e.g. a big batch reclassify) starves everything else (e.g. a user's single upload) |

---

## 🔧 The one big project: split the worker queue

**Problem:** today's single `photo-processing` queue mixes fast, latency-sensitive jobs (thumbnail generation, a user waiting on their upload to show up) with slow, bulk jobs (batch reclassification, HEIC WASM decode, face re-indexing). One slow job head-of-line-blocks everything behind it.

**Design:** split into two BullMQ queues sharing the existing Redis:
- `interactive` — thumbnailing, single-photo classification, anything a user is actively waiting on. Small concurrency, tight timeout.
- `analysis` — batch reclassify, face-collection rebuilds, anything triggered in bulk or by a cron. Higher concurrency, no user staring at a spinner.

Route jobs at enqueue time based on trigger (single upload → `interactive`; bulk/admin/cron action → `analysis`). Same worker process can run both with separate `Worker` instances and separate concurrency settings, or split into two deployable worker processes later if needed — the queue split is the part that has to happen first either way.

**Bonus, same project:** the WASM HEIC decode path (pure JS libheif, CPU-bound) should run in a `worker_threads` pool rather than inline on the worker's event loop — right now one big HEIC file can stall every other job that same worker process is handling.

- [ ] **#S1** — Split `photo-processing` into `interactive` / `analysis` BullMQ queues, route jobs by trigger type
- [ ] **#S2** — Move WASM HEIC decode onto a `worker_threads` pool instead of the worker's main event loop

---

## 💸 Rekognition cost-scaling plan (staged)

Don't do this all at once — each stage only makes sense once the previous one's ceiling is actually being hit:

- [ ] **#S3** — *(now → ~1k users)* No change needed; metered Rekognition calls are fine at this volume. Just make sure a per-day spend metric exists (see #S12) so we see the curve coming.
- [ ] **#S4** — *(approaching ~1k–10k users)* Swap Rekognition **face search/index** for a self-hosted embedding model + `pgvector` similarity search in Postgres. Rekognition's `DetectFaces`/general classification can stay as-is — it's specifically the per-photo face-collection indexing that scales linearly with photo count and gets expensive.
- [ ] **#S5** — *(if general classification itself becomes the cost driver)* Self-hosted CLIP/YOLO-class model behind the existing `classification/index.ts` swappable-provider interface — this is exactly the abstraction that already exists to make this swap a config change, not a rewrite.

---

## 🗄️ Data-layer roadmap

- [ ] **#S6** — Move rate limiting off in-memory `express-rate-limit` onto `rate-limit-redis` — required the moment there's a 2nd API instance, not before.
- [ ] **#S7** — Redis-backed session-lookup cache in front of the DB session check that runs on every authenticated request.
- [ ] **#S8** — `pg_trgm` + GIN index on photo labels once label search (audit #11) ships — needed for that feature to stay fast past a few thousand photos per user, not before.
- [ ] **#S9** — Monthly partitioning for `audit_log` — it's the one table with no natural cap (grows forever, never pruned like sessions/tokens).
- [ ] **#S10** — PgBouncer in front of Postgres once there's more than one API/worker process — direct per-process connection pools stop working cleanly.
- [ ] **#S11** — Read replica for reporting/analytics-style queries once they start competing with live request traffic on the primary.

---

## 📅 This month (concrete, no external dependencies)

The 6 items worth doing soon, in priority order, none of which need new infra provisioning to start:

1. [ ] **#S12** — Prometheus-style `/metrics` endpoint: queue depth (per queue once split), job latency, Rekognition spend/day. Do this *before* the queue split so there's a before/after comparison.
2. [ ] **#S1** — Split the worker queue (see above) — the single highest-leverage change on this list.
3. [ ] **#S6** — Redis-backed rate limiting — cheap, and removes the single biggest blocker to safely running a 2nd API instance.
4. [x] **#20** *(carried over from `AUDIT_FIXES_TRACKER.md`)* — `bcryptjs` → native `bcrypt` — done, see `AUDIT_FIXES_TRACKER.md` for details.
5. [ ] **#S2** — WASM HEIC decode onto `worker_threads`.
6. [ ] **#S7** — Redis session-lookup cache.

---

## 🔭 Aspirational: what a 100k-user version of this looks like

Not a to-do list — a sanity check that today's choices don't paint us into a corner:

- ~~CloudFront in front of S3 for thumbnails/photo delivery~~ — **done, see #S13** (shipped with signed URLs rather than signed cookies — a better fit for this app's per-photo permission model than originally sketched here).
- `interactive`/`analysis` queues each on their own autoscaled worker fleet.
- Self-hosted face-embedding + classification models (pgvector-backed), Rekognition either gone or fallback-only.
- Postgres: PgBouncer + read replica(s) + partitioned `audit_log`, all already in place from the data-layer roadmap above — nothing new architecturally, just more of it.
- Full metrics/alerting on queue depth and job latency (built in "this month," just monitored more seriously at this scale).

---

## Notes

- Nothing on this file blocks or is blocked by `AUDIT_FIXES_TRACKER.md` — that tracker is features/correctness, this one is load-bearing capacity. They can be worked in any interleaving.
- None of this is urgent for the current local-first MVP phase (Docker Compose, single instance). Treat as a queue to draw from as real traffic shows up, not a rewrite mandate.
- Per CLAUDE.md: no real cloud infra changes (e.g. actually provisioning CloudFront, read replicas, PgBouncer) without Abhishek's explicit go-ahead when the time comes — this file records the *plan*, not standing approval to provision anything.
