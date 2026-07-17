# MR Draft — dashboard-stats-and-upload-polish (on `feature/ai-classification`)

**Title:** feat: dashboard stats endpoint + upload flow drag-and-drop/progress polish

**Branch:** `feature/ai-classification` (continuing the existing branch — no new branch cut for this slice)
**Spec:** `specs/dashboard-stats-and-upload-polish.md` — builds only the spec's "Buildable now" scope (dashboard-stats endpoint + upload-page interaction polish). Dashboard page, folder browser, and photo viewer UI are explicitly out of scope (blocked on the reclassification-UI wireframe pick) and were not touched.

## Description

### 1. `GET /api/dashboard` (new, `backend/src/routes/dashboard.ts`)

Single aggregate rollup for the requesting user — total photo count (every status, per Open Question #1's stated default), folder/collection counts, per-collection folder/photo-count breakdown, and storage usage (bytes as strings + a server-computed `usedPercent` capped at 1.0). `requireAuth` + `asyncHandler`, no Zod (GET, no input), every query scoped by `req.user!.id` — no `:id` param on this route, so there's no ownership-mismatch case to get wrong the way `collections.ts`/`folders.ts` have to guard against.

Response shape matches the spec's JSON example exactly:
```json
{
  "storage": { "usedBytes": "1234567", "limitBytes": "5368709120", "usedPercent": 0.02 },
  "totals": { "photoCount": 42, "folderCount": 7, "collectionCount": 1 },
  "collections": [{ "id": "uuid", "name": "My Photos", "isDefault": true, "folderCount": 7, "photoCount": 42 }]
}
```

Notable implementation details:
- Per-collection `photoCount` is counted directly from `Photo` rows scoped to the collection (`prisma.photo.count({ where: { ownerId, collectionId } })`), **not** summed from each folder's `photoCount` counter — stays correct even for a photo with `collectionId` set but `folderId` still null (can't happen today per the worker's atomicity, but the spec calls out getting this right without trusting folder-level counters to always sum).
- `BigInt` storage fields are serialized via `.toString()` — there was no pre-existing BigInt-to-JSON convention anywhere else in the codebase to reuse (checked `routes/photos.ts`'s quota check; it only does BigInt arithmetic server-side, never returns a BigInt in a JSON response), so this endpoint establishes that convention.
- Empty-state (never-uploaded user) returns 200 with `totals: {0,0,0}` and `collections: []`, matching `GET /api/collections`'s existing empty-array convention — never a 404/error.
- Mounted at `/api/dashboard` in `app.ts`.

### 2. Upload flow polish (`frontend/src/app/upload/page.tsx`, `frontend/src/lib/api.ts`)

In-place interaction polish on the existing upload page, not a new screen (spec explicitly argues this doesn't need the SVG-wireframe-options process — page structure unchanged, "add a progress bar" is in the same category as "add validation error text").

- **Drag-and-drop:** the existing `data-testid="upload-result"` box is now also a drop target — `onDragOver`/`onDragLeave` toggle a visual state (dashed blue border + light blue background), `onDrop` populates the same `file` state the `<input type="file">` already populates, so it goes through the exact same `handleUpload` call, same validation, same error handling. No parallel code path. The `<input type="file">` is unchanged (click-to-browse still works).
- **Progress bar:** `photosApi.uploadWithProgress` (new method in `frontend/src/lib/api.ts`, additive — `photosApi.upload` is untouched, still used nowhere else so no other call site needed migration) uses `XMLHttpRequest` instead of `fetch`, per the spec's stated default (zero new dependencies — no fetch-progress polyfill exists in this repo's dependency tree). `xhr.upload.onprogress` drives a `<progress data-testid="upload-progress">` element + percentage readout, shown only while `uploading === true`. `xhr.withCredentials = true` replaces `fetch`'s `credentials: "include"` so the opaque session cookie still round-trips cross-origin. Progress is forced to 100% in the `onload` handler regardless of whether an intermediate `onprogress` event fired, so small/fast files still visibly complete the bar rather than jumping straight to the poll phase with no visual completion. Progress reflects only the upload POST — the existing 2-second `pending → done/duplicate/failed` poll loop is unchanged and untouched.
- No layout/visual redesign beyond what's needed for the drag-over state and the progress bar (a border/background change and a native `<progress>` element) — page remains intentionally minimal per the original upload-pipeline framing.

## Deviations from the spec

None. Built exactly the two "buildable now" items; did not touch the dashboard page, folder browser, or photo viewer (all explicitly deferred in the spec pending the reclassify-UI wireframe pick).

## Testing

**Backend:**
- `npm run typecheck -w backend` — clean, no errors.
- `npm run lint -w backend` — clean, no warnings/errors.
- `NODE_ENV=test npm run test -w backend` — **52/52 passed**, twice back-to-back (re-run for stability, both clean). New file `backend/src/__tests__/dashboard.smoke.test.ts` (5 tests): 401 with no cookie, empty-state shape for a brand-new user, full aggregation correctness after two uploads (one reaching `done` via the live worker, one forced to `failed` via `FORCE_FAIL_`, confirming a failed photo still counts toward `totals.photoCount` per Open Question #1's default), `usedPercent` capping at 1.0 under a code-level over-quota state (no live 5GB fill, matching the existing accepted constraint from the upload-pipeline spec), and cross-user isolation (a second user's dashboard never reflects the first user's data).
  - One self-caught bug during development: the new test file's worker-availability probe was missing, so `workerAvailable` stayed permanently `false` and every worker-dependent assertion silently (and wrongly) skipped regardless of whether the live worker was actually healthy — the live worker was in fact healthy the whole time (confirmed via a direct curl round-trip against the running `:4000` server). Fixed by adding the same `beforeAll` probe-upload pattern `classification.smoke.test.ts` already uses; re-verified the test then genuinely exercises the worker path (took ~7s, not a near-instant skip).

**Frontend:**
- `npm run typecheck -w frontend` — clean, no errors.
- `npm run lint -w frontend` — clean (`✔ No ESLint warnings or errors`).
- Manual verification against the live stack (`:3000`/`:4000`) via a scripted Playwright session (signup → `/upload`):
  - Dragging a file onto the result box: border visibly changed to a dashed blue style during drag-over; dropping populated the file state (Upload button went from disabled to enabled) without touching the `<input>`.
  - Clicked Upload after the drop: a `<progress>` element with `data-testid="upload-progress"` appeared with a live `value` during the request; status subsequently progressed to `done` with labels rendered (`Car, Truck` for the vehicles fixture used) — full round-trip intact.
  - Regression: click-to-browse path (the original `<input type="file">` flow) still uploads successfully end-to-end (`fixture-people.jpg` → `done`); the progress bar correctly disappears once the upload settles (`uploading` returns to `false`).
  - Regression: dropping a renamed fake-executable byte sequence (same repro as the existing MIME-sniff test) still surfaces `"Unsupported or unrecognized file type"` through the drop path — server-side content-sniffing is source-agnostic as expected, no new client-side path bypasses it.

## Files touched

- `backend/src/routes/dashboard.ts` (new)
- `backend/src/app.ts` (mount `/api/dashboard`)
- `backend/src/__tests__/dashboard.smoke.test.ts` (new)
- `frontend/src/app/upload/page.tsx` (drag-and-drop + progress bar)
- `frontend/src/lib/api.ts` (new `photosApi.uploadWithProgress`, XHR-based)

## Not built (per spec's explicit non-goals)

- Dashboard page UI, folder browser, photo viewer — all blocked on Abhishek's reclassify-UI wireframe pick (Pending Decision #0 in `agents/STATUS.md`), unchanged this pass.
- Multi-file/bulk upload, client-side pre-upload duplicate warning — explicitly out of scope per the spec's Non-goals section.
