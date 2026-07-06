# MR: P7 owner audit-log viewer — `/activity` page

**Branch:** `feature/ai-classification` (local only — NOT pushed)
**Commit:** `238a3ee`
**Author:** Abhishek Katiyar (no `Co-Authored-By: Claude` trailer, per standing rule)
**Spec:** `specs/audit-and-polish.md` §A4 / P7 · **Wireframe:** `design/wireframes/audit-viewer.svg` (Option A, already picked)

## Summary

Built the P7 audit-log viewer frontend: a dedicated, owner-authed `/activity`
page with a filter bar over a paginated, newest-first feed, against the
already-built, Tester-verified `GET /api/audit` (41/41). **No backend file was
touched** — the endpoint was consumed exactly as specced.

## Files changed

- **`frontend/src/app/activity/page.tsx`** (new) — the page.
- **`frontend/src/lib/api.ts`** — added the typed `auditApi.list(...)` client +
  `AuditEntry` / `AuditListResponse` / `AuditListParams` / `AuditAction` /
  `AuditActorType` / `AuditMetadata` types, following the existing
  `apiFetch`/`ApiError`/`credentials:"include"` conventions. Query params
  (`limit`/`offset`/`action`/`actorType`/`from`/`to`) assembled via
  `URLSearchParams`, all optional.
- **`frontend/src/app/globals.css`** — added `.activity-*` classes (filter bar,
  actor-toggle pills, feed rows with colored left-edge + icon swatch, OWNER/GUEST
  badges, pagination). Reuses the existing `--color-*` tokens and the shared
  `.organize-topbar` + `.dashboard-topbar-right` nav treatment — no new visual
  language.
- **`frontend/src/app/dashboard/page.tsx`** — added the "Activity" nav link.
- **`frontend/src/app/guests/page.tsx`** — added the "Activity" nav link.

## Nav-entry placement

Per the brief: an "Activity" link beside "Guests" in the **dashboard** top bar,
and — because `/guests` also has a top bar — an "Activity" link added there too
for consistency (the guests top bar previously carried only a title; it now has
a `dashboard-topbar-right` block with the Activity link). The `/activity` page's
own top bar carries **both** Guests and Activity links (Activity marked
`aria-current="page"` + a subtle active style), matching the wireframe's
top-bar with "Guests" and a bold "Activity". All links reuse the existing
`.dashboard-guests-link` treatment — no new nav shell was built.

## How rows are rendered

Each row (from one `AuditEntry`):

- **Colored left-edge + icon swatch by action tone**, per the wireframe palette:
  green (`#3d9a5b` / `#e3f2e8`) for `photo_downloaded` + `access_approved`; blue
  (primary / `#e8eefc`) for `photo_viewed`, `share_created`, `access_requested`;
  red (`#c46b6b` / `#f3e2e2`, plus a red row border + red label) for
  `access_denied` + `guest_revoked`.
- **Human action label:** "Downloaded a photo", "Viewed a photo", "Approved
  access", "Denied access", "Created a share", "Requested access", "Revoked
  guest".
- **OWNER/GUEST badge:** owner blue (`#e8eefc`/`#1b3a9e`), guest amber
  (`#faf1e3`/`#a07a3a`), per the wireframe.
- **Actor:** "you" for owner rows; the guest email for guest rows (from
  `actor.email`, which the backend resolves from `metadata.guestEmail` or a
  lookup); falls back to the actor id if no label resolves.
- **Metadata second line**, resolved from what each choke point captured at
  write time (verified live against the real endpoint) with graceful id
  fallbacks:
  - `share_created` → `shared {folderNames} with {guestEmail} · {permissionLevel}`
    (folder **names** are in metadata; falls back to `folderIds`, then "folders").
  - `access_approved` → `for {guestEmail}`.
  - `access_denied` → `for {guestEmail} · reason: {human reason} ({reason_key})`
    where reason_key ∈ `owner_denied` / `otp_attempts_exceeded` / `otp_expired`.
  - `access_requested` → `{guestEmail} requested access · IP {ipAddress}`.
  - `guest_revoked` → `revoked {guestEmail}`.
  - `photo_viewed` / `photo_downloaded` → `photo in folder {folderId} · IP {ipAddress}`
    — **see deviation below.**
- **Relative timestamp** ("2 min ago", "3 hours ago", "1 day ago") with the
  absolute time in a `title`.

## Filters & pagination

- Action dropdown (All actions + the 7 human-labeled actions), an owner/guest
  actor toggle (All / Owner / Guest pill group), a from/to date range, and an
  **Apply** button. Draft filter state is held separately from applied state, so
  editing a date doesn't refetch until Apply is clicked (matches the wireframe's
  explicit Apply button). `from`/`to` are widened to full-day ISO bounds
  (`T00:00:00.000Z` / `T23:59:59.999Z`) so the "to" day is inclusive.
- Offset-based pagination (`PAGE_SIZE = 25`): "Showing X–Y of {total}" +
  Previous/Next, disabled at the ends. Applying a filter resets to offset 0.

## Loading / empty / error (P3 discipline)

- Loading indicator on fetch (`activity-loading`).
- Non-crashing empty state: "No activity yet — activity appears here once you
  share folders and guests start viewing/downloading."
- Inline error on a failed fetch (`activity-error`).
- The fetch effect uses the `cancelled`-flag stale-response guard (same pattern
  as `/organize` / `/dashboard`); a 401 during fetch redirects to `/login`.

Filter state is local component state (not URL params), so the page uses **no**
`useSearchParams` and needs **no** Suspense boundary — it builds as a static
route.

## Verification

1. `npm run typecheck -w frontend` — **clean.**
2. `npm run lint -w frontend` — **clean** (`✔ No ESLint warnings or errors`).
3. `npm run build -w frontend` (real `next build`) — **clean**; `/activity`
   present, built as a static `○` route (100 kB First Load JS), all 12 routes
   compiled, no Suspense/route issue.

**Live check (run):** with the Docker stack up (Postgres/Redis/MinIO healthy)
and the backend on `:4000`, restarted `next dev` fresh and confirmed
`GET /activity` compiles and serves `200`. Seeded 5 audit rows (+ an owner
session) via Prisma covering all four row shapes, then hit `GET /api/audit`
directly: it returns the exact `{ entries, total, limit, offset }` shape the
page consumes, newest-first; `?action=photo_downloaded` → 1 row,
`?actorType=owner` → 3 owner rows (filters narrow correctly); no session → 401
(drives the `/login` redirect). The real data maps cleanly onto the page's
`detailLine`/`actorLabel` logic (guest download → "photo in folder f-nature · IP
203.0.113.9" + GUEST badge + client@example.com; denied → "for studio@bride.co ·
reason: too many wrong codes (otp_attempts_exceeded)"; share → "shared Nature
with client@example.com · download"). Seeded owner + 5 audit rows deleted
afterward; throwaway seed/cleanup scripts removed; `git status backend/` clean.

## Note on the build / dev-server interaction

`next dev` was live on the shared `.next` at the start. The production build
was run while dev was up; to avoid leaving a mixed dev/prod `.next` manifest
(the failure mode the brief warns about), I stopped `next dev`, wiped `.next`,
and restarted dev fresh for the live check. No corrupted manifest persists.

## Deviations from the wireframe (flagged)

1. **View/download rows show "photo in folder {folderId}", not "photo in
   {folderName}".** The wireframe shows "photo in Nature", but the
   `photo_viewed` / `photo_downloaded` choke points (`backend/src/routes/guest.ts`)
   capture only `metadata.folderId` — **no folder name**. Per the brief's "fall
   back gracefully to ids if absent" instruction, the page renders the folder id
   rather than fabricating a name or doing an extra per-row lookup. **This is a
   backend metadata gap, not a bug** — flagging it rather than modifying the
   (Tester-verified) backend: if the "who viewed which folder" differentiator
   should read as a folder name, the fix is to have those two `logAudit` calls
   also capture `folderName` (additive, one line each), which would then surface
   automatically here with no frontend change.
   **RESOLVED (follow-up commit): the backend now captures `folderName`** on both
   `photo_viewed` and `photo_downloaded` — each handler's existing `photo`
   `findUnique` gained `include: { folder: { select: { name: true } } }` and the
   metadata became `{ folderId, folderName: photo.folder?.name ?? null }`
   (additive only; auth/404/pre-signed/fire-and-forget flow all untouched;
   backend suite 85/85, no test change needed). NEW audit rows now carry the name;
   old rows keep just the id. **Note: the `/activity` frontend still only reads
   `metadata.folderId` for these rows (`detailLine` in `frontend/src/app/activity/page.tsx`,
   lines 112–118) — it does NOT yet read `folderName`.** The frontend needs a
   separate additive edit (prefer `metadata.folderName` with an id fallback) for
   the name to actually render; that edit was intentionally NOT made in this
   backend-only follow-up.
2. **Page size is 25, not the wireframe's illustrative 5.** The wireframe's
   "Showing 1–5 of 42" was a mockup convenience; 25/page is a sensible real
   default and the "Showing X–Y of {total}" text is fully dynamic.
3. **Guests top bar gained a nav container.** It previously had only a title;
   adding the Activity link there (for cross-page consistency, as the brief
   requested) required introducing the `dashboard-topbar-right` block. Purely
   additive.
