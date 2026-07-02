# PhotoSphere AI — Live Status

> Single source of truth for what's happening right now. Every agent reads this first and updates it last. Master Agent owns this file — Planner, Developer, and Tester propose updates, Master reconciles conflicts.

**Last updated:** 2026-07-03 by Master Agent (full orchestration cycle: plan → build → adversarial review/fix → test, AI classification feature. 52/52 Tester pass, 0 bugs. See below.)

---

## Current Phase
Phase 1 — MVP, Week 5–6 (AI Classification), backend complete and tested clean. Auth (Week 1–2) and the upload pipeline (Week 3–4) are shipped and regression-tested clean across three consecutive full runs. The only thing standing between this repo and "Week 5–6 done" is Abhishek's pick on the reclassification-UI wireframe (see Pending Decisions).

## Current Sprint Goal
Turn classification results into organization: category mapping (labels → folders), confidence-threshold bucketing (<60% → Uncategorized), race-safe folder auto-creation, a reclassify/retry path (also the escape hatch for pHash false-positive duplicates), and the minimal endpoints a manual reclassification UI needs. Plus three carried-over hardening items from the 2026-07-02 Tester report: split auth rate-limit buckets, SHA-256 exact-hash dedup pre-pass (fixes the flat-image false-positive), and EXIF exposure on the photo endpoint.

## Ready Spec (from Planner)
`specs/ai-classification.md` — **built.** Adversarially reviewed (3 lenses: scope-discipline, codebase-consistency, testability) before Developer touched it; 10 findings applied in revision, including a real bug the review caught pre-emptively (`ProcessingJob` bookkeeping was keyed by `photoId` via `updateMany`, which would have silently clobbered a photo's pipeline-job row the moment it also got a reclassify-job row — fixed to key by BullMQ job id before any code was written against the old approach). Spec is still untracked/uncommitted in git (Planner's file; Master has not decided whether specs get committed to this repo — flagging as a small process question, not blocking).

## Last Tester Run
**2026-07-03 00:50 — full regression (auth + upload pipeline + AI classification), 52/52 passed, 0 bugs.** Report: `reports/2026-07-03_0050.md`. Run was dispatched 2026-07-02 evening, interrupted mid-run by a session usage limit before any live traffic, and resumed after midnight against the identical commit/stack (noted in the report header) — nothing invalidated by the pause. Headless Playwright + curl/node-fetch (VS Code session, not Cowork live-browser control).

- **Auth regression (15/15):** full baseline re-verified, plus the new split rate-limit buckets confirmed live at exact production numbers — signup 429 at the 6th in-window request, login 429 at the 11th, fully independent of each other and of uploads. **This is the first run with zero rate-limit-induced workarounds**, after two consecutive prior runs needed a benign backend restart mid-suite.
- **Upload pipeline regression (16/16):** full baseline re-verified. Two items graduate from "code-reviewed only" to **live-verified for the first time**: EXIF fields (new `exif` object on `GET /api/photos/:id`) and exact `attempts=3`/`errorMessage` on forced failure (new `job` object on the status endpoint) — both were open testability gaps in the 2026-07-02 report, both closed by this build.
- **AI classification (21/21):** every `[Tester-live]` acceptance criterion in the spec passed — all 7 category mappings, folder reuse + photoCount reconciliation, Uncategorized via both unmappable labels and the new `FORCE_LOWCONF_` test hook, a genuine concurrency race (two simultaneous uploads into a brand-new category → exactly one folder row), pagination validation, PATCH move, all four reclassify paths (rescue a `failed` photo, rescue a `duplicate` photo, 409-while-in-progress, its own independent 30/15min rate bucket), cross-user 404 isolation and 401s across all six new endpoints, and the full job/dedup observability surface.
- **Flat-image false positive (2026-07-02 finding) — confirmed fixed.** Re-ran the exact red/blue flat-rectangle repro: both process independently to `done`; a byte-identical re-upload correctly resolves `duplicate` via `dedupMethod: "sha256"`.
- **Not independently live-verifiable (unchanged constraints, not failures):** storage-quota 413 (impractical without DB access to shrink the 5GB default), worker kill/restart durability (can't manage Abhishek's local processes from this session). Plus 8 items explicitly out-of-scope by the spec's own verification legend (`[Developer-verified]`/code-review-only: 0.60 threshold boundary, `file_sha256` DB state, mock call-counter, double `npm test` run, fresh-DB migration replay, offline classification, DB-level bookkeeping half, and — separately — the reclassification UI itself, correctly not built). Developer's MR draft (`reports/mr-drafts/feature-ai-classification.md`) records verification for all of these.
- **Two housekeeping notes from Tester:** a stale duplicate `tsx watch src/server.ts` process is running alongside the live one (benign, only one can bind :4000, worth killing next time someone's at the machine); and a methodology note for future Testers — derive companion test-image expectations from your own generated bytes via the real `classify()`, not from the fixtures README's table (the mock is byte-deterministic, so a differently-encoded "gray image" won't match another session's).

Prior baseline for comparison: 2026-07-02 04:50 run, 28/28, first to test the upload pipeline; found the flat-image pHash issue now fixed. 2026-07-01 run, 17/17, auth only.

## Last Developer Action
**2026-07-02/03 — Developer Agent shipped the AI-classification organizing layer on `feature/ai-classification`** (branched off `feature/upload-pipeline` @ `74d1f4b`), through a build → adversarial-review → fix → re-verify loop before Tester ever touched it. Five commits: `8f1f065`, `5b8d304`, `97b69a1`, `0395096`, `27afa75`.

**What was built** (full detail in `reports/mr-drafts/feature-ai-classification.md`):
- Schema: `Collection`/`Folder` Prisma models via a real migration (`20260702090917_add_collections_folders_classification`, extending the migration history that started with commit `74d1f4b`), plus `photos.file_sha256` and `photos.dedup_method`.
- Pure `categoryMapping.ts` module (sibling of the classification provider, not part of it — keeps the future real-Vision swap-in a one-file change) implementing the roadmap's label→folder priority table.
- Worker: race-safe folder auto-creation (lazy default "My Photos" collection, find-or-create with P2002 catch-and-refetch), confidence bucketing (<0.60 strict → Uncategorized), a new `reclassify` job type, and a `FORCE_LOWCONF_` test hook (mirrors the existing `FORCE_FAIL_` pattern) since the mock's real confidence range can never otherwise exercise the Uncategorized path.
- Six new endpoints (`GET /api/collections`, `GET`/`POST /api/collections/:id/folders`, `GET /api/folders/:id/photos`, `PATCH /api/photos/:id`, `POST /api/photos/:id/reclassify`) plus additive fields on the existing photo endpoints (`exif`, `folderId`, `collectionId`, `dedupMethod`, `job`), all under the existing `requireAuth`/`asyncHandler`/Zod/404-not-403 conventions.
- Carry-over hardening: `authRateLimiter` split into independent `signupRateLimiter` (5/15min/IP) and `loginRateLimiter` (10/15min/IP), both relaxed under `NODE_ENV=test`; SHA-256 exact-hash dedup pass ahead of pHash; EXIF exposed on `GET /api/photos/:id`.
- 3 SVG wireframe proposals for the reclassification UI at `design/wireframes/proposals/reclassify-ui-option-{a,b,c}.svg` — **not built**, correctly left blocked per the UI-decision protocol.
- A genuinely pre-existing bug found and fixed along the way: `auth.smoke.test.ts`'s duplicate-signup test used an email address invalid under the current Zod regex, so both signups 400'd and the 409 path was never actually exercised — confirmed pre-existing at `74d1f4b` before fixing.

**Two real concurrency bugs were caught before they ever reached Tester**, via an adversarial code-review pass (3 lenses: correctness, security/ownership, testability) followed by independent skeptic verification of every finding, then a second gap-closing round after the first fix proved incomplete:
1. **Circular/mutual duplicate-marking.** The new SHA-256 exact-dedup pass matched *any* same-user same-hash row regardless of whether it had finished processing — two quick uploads of the same file could each mark the other as the duplicate (A→B and B→A simultaneously), permanently losing both copies from the organized library. First fix (constrain the SHA-256 pass to strictly-older, non-duplicate candidates) closed that path but a second adversarial pass found the *same* hole survived through the pHash near-dup phase, which had none of the new exclusions. Final fix applies the same strictly-older-and-non-duplicate constraint to both phases, extracts both candidate queries into a single `lib/dedup.ts` module with the invariant documented at the top, and a max-effort skeptic then tried, and failed, to construct any interleaving (serial, concurrent, retried, reclassify-mixed) that produces a cycle. **One narrower, non-cyclic edge case remains and is accepted, not fixed:** under a specific concurrent race (uploading a re-encoded copy and a byte-identical copy of that re-encode at nearly the same time), a duplicate can end up pointing at another duplicate rather than the canonical original — chains stay finite and acyclic (no data loss, no stuck state), and reclassify still rescues either photo. Not reproduced in Tester's live run. Flagged below as a pending decision rather than spending a fourth fix round on it.
2. **Reclassify double-enqueue race.** `POST /api/photos/:id/reclassify`'s terminal-state check and its enqueue were four non-atomic steps, so concurrent requests (e.g. a double-clicked button) could all pass the guard and create duplicate jobs, corrupting folder photo-counts. Fixed with a single atomic conditional `UPDATE ... WHERE status NOT IN (pending, processing)` as the sole arbiter — confirmed closed by independent re-verification, including compensation logic so a Redis hiccup during enqueue can't strand a photo in `pending` forever.

Also hardened along the way: folder `photoCount` reconciliation was vulnerable to stale reads under concurrent moves/reclassifies (now Serializable-isolated with automatic retry), and 7 additional test coverage gaps the review surfaced (multi-category label priority, the exact flat-image repro as a permanent regression test, concurrent new-category folder creation, EXIF assertions, reclassify rate-limiter independence, and a from-scratch offline-classification test proving no code path can reach the network). Final suite: **47/47, twice back-to-back**, plus Tester's independent 52/52.

**Process note:** the session hit its usage limit three separate times mid-cycle (once during planning, twice during the developer build/fix/test chain). Each time, work already completed was preserved — either because the underlying agent had simply paused and could be resumed with full context, or because a capacity probe confirmed the limit had cleared before relaunching. No work was lost or duplicated; flagging only because it added real wall-clock time to this cycle and may recur.

## Open Bugs
None. Tester's 2026-07-03 full-regression run found 0 bugs (52/52 pass, auth + upload pipeline + AI classification). Prior runs also clean (28/28 on 2026-07-02, 17/17 on 2026-07-01).

Non-bug items flagged for attention (not blocking):
- **Duplicate-of-a-duplicate chain edge case** (new, this cycle — see "Last Developer Action" #1 above). Accepted trade-off, not reproduced live, no data loss; revisit only if it shows up in practice or someone wants the fourth fix layer built.
- **Stale duplicate `tsx watch src/server.ts` process** (new, Tester's 2026-07-03 report) — benign, cleanup whenever convenient.
- Signup/login shared rate-limit bucket — **resolved this cycle.** Split into independent buckets, confirmed by two consecutive clean Tester runs with zero workarounds needed (see Last Tester Run). No longer an open item.
- pHash flat-image false positive — **resolved this cycle.** SHA-256 exact-pass fix confirmed by Tester's exact repro. No longer an open item.
- EXIF testability gap — **resolved this cycle.** `exif` object now on `GET /api/photos/:id`, live-verified. No longer an open item.
- `npm install` still flags Next.js 14.2.13's known security advisory — still deferred to a dedicated dependency-upgrade pass, not bundled into any feature ticket (carried forward, unchanged).
- `specs/ai-classification.md` is untracked in git — small process question for Abhishek/Master on whether specs should be committed going forward (not urgent).

## Pending Decisions Awaiting User Input

**Carried forward, now resolved (for the record):** auth spec decisions 1–5 confirmed 2026-07-01; auth visual layout (Option B) resolved 2026-07-01, shipped; upload-pipeline's 7 flagged assumptions (file types, thumbnail layout, mock classification shape, pre-signed URL delivery, upload rate-limit numbers, storage quota scope, duplicate-detection scope) were all built on stated defaults with no veto received — treating as implicitly accepted since two full regression cycles have passed on them without objection.

**New this cycle — the one item actually blocking further work:**

0. **Reclassification UI — wireframe pick needed to close out Week 5–6.** Three SVG options at `design/wireframes/proposals/reclassify-ui-option-{a,b,c}.svg`:
   - **Option A — Sidebar folder tree + thumbnail grid.** Folder counts always visible, per-card "Move to…" dropdown, inline folder creation, scales naturally into the Week 7–8 folder browser. Highest build effort; sidebar needs a collapse behavior on narrow screens. **Developer's recommendation.**
   - **Option B — Single-list triage table with inline folder selects.** Cheapest to build, densest info per row (labels/confidence/status/dedup reason all visible), fits a "correction tool" framing well. Feels like an admin table, not a photo product; mostly throwaway once Week 7–8's real folder browser ships.
   - **Option C — Folder cards + minimal grid + modal-based actions.** Cleanest browsing surface, most mobile-friendly, one place for all photo detail. Every action costs an extra click to open the modal — slow for the bulk-correction use case this tool exists for.
   
   Everything the UI needs from the backend (folder lists with counts, folder photos with pre-signed thumbnails, move, create-folder, reclassify+poll) is already built and live-verified. Once you pick, the chosen SVG becomes `design/wireframes/reclassify-ui.svg` and Developer builds the page against these already-shipped endpoints — should be fast, this is the last piece of Week 5–6.

**New this cycle — 10 flagged assumptions from `specs/ai-classification.md`, none blocking (Developer proceeded on stated defaults, all shipped and tested), worth explicit confirmation or veto:**

1. **Default collection semantics.** One per-user default "My Photos" collection, created lazily by the worker at first folder assignment, `@@unique([ownerId, name])`. Side effect: user collections can't duplicate names later.
2. **Mapping-table aliases.** Added Landscape/Nature/Outdoor as Nature aliases beyond the roadmap's literal table (fixture-only change, provider untouched). Veto if the mapping table must stay roadmap-verbatim.
3. **"Secondary tags" scope.** Primary folder is real; secondary tags remain the existing raw `aiLabels` array, no separate tags table yet.
4. **Reclassify clears the duplicate verdict.** Reclassifying a `duplicate` photo clears `duplicateOfPhotoId`/`dedupMethod` — the deliberate escape hatch for pHash/sha256 false positives. Veto if duplicates should stay locked until a delete/merge flow exists.
5. **Reclassify rate limiter numbers.** Own per-user bucket, 30/15min, independent of upload's and auth's. Numbers open to veto.
6. **Auth rate-limit split numbers.** Signup 5/15min/IP, login 10/15min/IP, both relaxed under `NODE_ENV=test`. Confirmed working by two clean Tester runs — numbers open to veto if you'd prefer different values.
7. **pHash flat-image fix approach.** SHA-256 exact-hash first pass + skip pHash comparison when either hash is the degenerate all-zeros value. Accepted residual: two near-identical-but-not-byte-identical flat photos (e.g. two shots of the same blank wall) will no longer dedup against each other. Confirmed working by Tester's exact repro.
8. **Manual folder creation pulled into this pass.** `POST /api/collections/:id/folders` (create-only) shipped now since the reclassification UI needs move targets; rename/merge/delete stay deferred to Week 7–8.
9. **Low-confidence test hook.** `FORCE_LOWCONF_` filename hook (forces confidence to 0.42) rather than widening the mock's real confidence range, to avoid destabilizing every other classification test.
10. **Job/dedup observability fields.** `GET /api/photos/:id/status` now exposes internal job bookkeeping (`type`, `status`, `attempts`, `errorMessage`) and `dedupMethod` to the client — added mid-cycle so these paths could be Tester-verified at all, rather than staying permanent "code-review only" gaps. Veto if internal job state shouldn't be client-visible.

None of these block further work — all ten defaults are already built, shipped, and passed a full regression cycle. Flagging per protocol; treat silence past this point as implicit acceptance, same as the upload-pipeline batch above.

## Next Scheduled Actions
- 06:00 daily — Tester Agent regression pass (Docker/dev-server prerequisites unchanged, see Notes/Risks — still not automated via cron in this environment).
- 18:00 daily — Tester Agent regression pass.
- **Next up, once Abhishek picks a wireframe:** Developer Agent builds the reclassification UI page against the already-shipped backend, then a short Tester pass covering just that page (everything else this cycle is already fully regressed).
- If no wireframe pick arrives first: Planner Agent scopes the next roadmap item (Week 7–8 Core UI is next in the roadmap, but likely blocked on the same UI-decision protocol given its scope) rather than leaving Developer idle.

## Notes / Risks
- **GitHub remote is now connected** (`origin` → `https://github.com/abhishekkatiyar2403/PhotoSphere-AI.git`) — this supersedes the "no GitHub remote connected yet" note from earlier cycles. Nothing has been pushed from any agent this cycle; all work remains local-only on feature branches pending Abhishek's explicit go-ahead per the ground rules. Current unpushed branches: `feature/upload-pipeline` (shipped, tested), `feature/ai-classification` (shipped, tested, 5 commits ahead of `feature/upload-pipeline`).
- Both dev servers (backend `:4000`, frontend `:3000`) plus the worker (`npm run worker -w backend`) have been running continuously since at least 2026-07-02 and were confirmed healthy throughout this cycle (40+ hours Docker uptime). They will not survive a machine reboot or VS Code restart — check `curl localhost:4000/health` before assuming they're up in a future session. Tester's 2026-07-03 report also flags a stale duplicate `tsx watch src/server.ts` process worth killing.
- Docker Compose (Postgres/Redis/MinIO) has been stable and healthy across this entire cycle — no recurrence of the earlier credential-helper blocker.
- Real AWS/GCP services (S3, Vision API, EKS, Terraform) remain fully deferred — this cycle's classification work went to considerable lengths to keep that boundary airtight (dependency-graph checks, stubbed-network tests) precisely because "swap in real Vision" is meant to stay a one-file change whenever it's approved.
- UI design decisions stay SVG-only, no Figma. This cycle produced the second full pass through that protocol (three proposals in chat/`design/wireframes/proposals/`, awaiting Abhishek's pick) — see Pending Decision #0 above.
- MR draft for this cycle's work: `reports/mr-drafts/feature-ai-classification.md` (comprehensive — includes the full adversarial-review/fix history, not just a build summary).
