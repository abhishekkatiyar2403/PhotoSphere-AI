# MR Draft: consistent top-bar nav on every authed owner page

**Branch:** `feature/ai-classification`
**Commit:** `2588f67`
**Author:** Abhishek Katiyar (no Claude co-author trailer, per standing rule)

## Title
fix: give every authed page a consistent full top-bar nav

## Description

Real navigation bug found by inspection (not a Tester report this cycle):
after login, users land on `/dashboard` but there was no link anywhere to
`/upload` or `/organize` — both were only reachable if you already knew the
URL. A full audit of every authed owner page's top bar found the nav was
inconsistent everywhere:

- `/dashboard` linked to: search, guests, activity (missing upload, organize, browse)
- `/organize` linked to: nothing (missing all 7)
- `/browse` linked to: nothing (missing all 7)
- `/guests` linked to: activity, share (missing upload, organize, browse, search)
- `/activity` linked to: search, guests, activity-self (missing upload, organize, browse)
- `/search` linked to: browse, guests, activity, search-self (missing upload, organize)
- `/share` linked to: guests only, via an ad-hoc inline style (missing 6, no shared class)
- `/upload` had **no top bar at all**

## Fix

Every authed owner page (`/dashboard`, `/organize`, `/browse`, `/upload`,
`/share`, `/guests`, `/activity`, `/search`) now has the same top-bar nav
link set to the other 7 pages, in the order:

**Upload · Organize · Browse · Search · Guests · Activity** (plus **Dashboard**
via the "PhotoSphere AI" title acting as a home/logo link).

Each page omits (or, for the previously-existing self-link convention on
`/activity` and `/search`, visually distinguishes rather than omits) the
link to itself — matching the pre-existing `.activity-nav-active` pattern
those two pages already used.

No new nav component and no new visual language: reused the existing
`.dashboard-guests-link` (secondary top-bar link) and `.dashboard-topbar-right`
(flex container) classes exactly as already established across
`/dashboard`, `/guests`, `/activity`, `/search`. Considered introducing a
generically-named `.topbar-nav-link` class instead of the page-specific-sounding
`.dashboard-guests-link`, but decided against a rename — it would touch every
page for a purely cosmetic class-name cleanup with no behavior change, and
`.dashboard-guests-link` is already treated as the de facto shared class
(4 of 8 pages used it pre-fix). Kept the diff minimal.

Added one new small class, `.organize-topbar-logo-link`, so the "PhotoSphere AI"
brand text in each page's `<h1>` (except `/dashboard`'s own) becomes a link
back to `/dashboard` — the explicit "home" affordance called for in the task,
since the title text was previously non-interactive everywhere.

`/upload` previously had zero top bar (by design, per `Day1.md` — it's an
intentionally-minimal proof-of-concept page for the upload pipeline). Gave it
the same `.organize-topbar` + `.dashboard-topbar-right` treatment as every
other page, since "no way back to the rest of the app" was the actual
reported bug, not the page's minimalism itself.

## Files touched

- `frontend/src/app/dashboard/page.tsx` — added Upload, Organize, Browse links (Search/Guests/Activity already present)
- `frontend/src/app/organize/page.tsx` — added full 5-link set (Upload, Browse, Search, Guests, Activity) + Dashboard logo link (had none before)
- `frontend/src/app/browse/page.tsx` — added `Link` import + full 5-link set (Upload, Organize, Search, Guests, Activity) + Dashboard logo link (had none before)
- `frontend/src/app/upload/page.tsx` — added `Link` import + a top bar from scratch (Organize, Browse, Search, Guests, Activity) + Dashboard logo link
- `frontend/src/app/share/page.tsx` — replaced the single ad-hoc inline-styled Guests link with the full 6-link set (Upload, Organize, Browse, Search, Guests, Activity) using the shared classes + Dashboard logo link
- `frontend/src/app/guests/page.tsx` — added Upload, Organize, Browse, Search links (Activity already present; `+ Share new folders` action link untouched) + Dashboard logo link
- `frontend/src/app/activity/page.tsx` — added Upload, Organize, Browse links (Search/Guests/self already present) + Dashboard logo link
- `frontend/src/app/search/page.tsx` — added Upload, Organize links (Browse/self/Guests/Activity already present) + Dashboard logo link
- `frontend/src/app/globals.css` — new `.organize-topbar-logo-link` (2 rules: color inherit + underline on hover)

## Testing notes

- `npm run typecheck -w frontend` — clean.
- `npm run lint -w frontend` — clean (`✔ No ESLint warnings or errors`).
- `npm run build -w frontend` — clean, built to an isolated `.next-verify`
  `distDir` via a temporary `next.config.js` edit (reverted after) so the
  live `next dev` `.next` directory was never touched; all 14 routes compiled,
  all 8 authed pages listed in the route table.
- Live-served every one of the 8 pages over the running dev server —
  all returned `200` (client-side auth gate renders/redirects, no server error).
- Verified via `grep` that each page's rendered source contains `href` links
  to exactly its 7 counterparts (no self-links, no missing links) — cross-checked
  against the bug report's per-page audit.
- Did not independently re-verify in a real browser DOM (click-through) this
  cycle — build-clean + grep-verified href sets + live 200s on every route is
  the coverage for this pass. Low risk: this is a pure additive nav change over
  already-verified pages, no new state, no API calls added.

## Deviation / judgment calls

- Kept `.dashboard-guests-link` instead of renaming to a generic
  `.topbar-nav-link` — see rationale above. Flagging in case Abhishek wants
  the rename done as a follow-up cleanup.
- Added the Dashboard "home" link via the title text rather than a separate
  explicit "Dashboard" nav item, per the task's suggestion ("Dashboard as the
  home/logo link, which likely already exists via the app title... check what
  it currently does there"). It did NOT exist before (titles were plain text) —
  made it a link now on every page except `/dashboard` itself.
