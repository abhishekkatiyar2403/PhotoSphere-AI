# MR Draft: feature/auth-scaffold (visual swap follow-up commit)

**Title:** feat: swap auth pages to Option B split-screen layout

**Branch:** `feature/auth-scaffold` (local only, not pushed — no GitHub remote connected). Same branch as the original auth scaffold MR (`reports/mr-drafts/feature-auth-scaffold.md`); this is a follow-up commit (`efb5847`) on top of it, not a new branch, since it's a CSS/layout-only change to an already-shipped feature.

## Description

Resolves Pending Decision #6 in `agents/STATUS.md`: Abhishek picked **Option B — Split screen** from the three SVG wireframe options presented for `/signup` and `/login`. This commit swaps the visual layer only:

- Extracted a new shared `frontend/src/components/AuthLayout.tsx` component (previously `/signup` and `/login` each duplicated their own `<main className="auth-page"><div className="auth-card">` wrapper inline — factoring it out was the least-churn way to add the branded panel to both pages without duplicating markup).
- `AuthLayout` renders a left branded panel (`#3057d5` background, "PhotoSphere AI" name + tagline) and a right panel that holds the existing, unmodified form card as `children`.
- `globals.css`: replaced the old centered `.auth-page`/`.auth-card` rules with a flex row split (`.auth-brand-panel` / `.auth-form-panel`), plus a `@media (max-width: 720px)` breakpoint that collapses the branded panel into a compact header bar stacked above the form (tagline hidden, name shrunk) — this was explicitly flagged when Option B was proposed as needing a mobile breakpoint that Option A didn't need.
- `frontend/src/app/signup/page.tsx` and `frontend/src/app/login/page.tsx`: only the outer wrapper swapped from `<main className="auth-page"><div className="auth-card">...</div></main>` to `<AuthLayout><div className="auth-card">...</div></AuthLayout>`. No changes to field markup, state, validation, submit handlers, or API calls.

Does not touch `specs/`, `reports/` (other than this draft and the STATUS.md update), or `design/wireframes/auth.svg` (already the design record from the earlier decision cycle, left as-is).

## Files touched

- `frontend/src/components/AuthLayout.tsx` (new)
- `frontend/src/app/globals.css` (modified — auth layout rules replaced, mobile breakpoint added)
- `frontend/src/app/signup/page.tsx` (modified — wrapper swap only)
- `frontend/src/app/login/page.tsx` (modified — wrapper swap only)
- `agents/STATUS.md` (Pending Decision #6 marked resolved)

## Testing notes

- `cd frontend && npx tsc --noEmit` — clean.
- `cd frontend && npx eslint src/` — clean, 0 errors.
- Both dev servers were already running (backend `:4000`, frontend `:3000`); confirmed still healthy via `curl localhost:3000/login` (200) and `curl localhost:4000/health` (200) before and after the change.
- Confirmed via `curl` that both `/login` and `/signup` HTML responses contain `auth-brand-panel`, `auth-form-panel`, and `auth-card` — i.e. both the branded panel and the (unchanged) form card are present in the DOM on both pages.
- Playwright screenshots taken at desktop (1280x800) and mobile (390x844) viewports for both `/login` and `/signup`:
  - Desktop: full split-screen, left panel shows "PhotoSphere AI" + tagline, right panel shows the unmodified form card — matches `design/wireframes/auth.svg` layout.
  - Mobile: branded panel collapses to a thin blue header bar with just the product name (tagline hidden), form card stacks below at full width — confirms the mobile breakpoint works as intended.
- Backend smoke suite (`cd backend && npm test`): 2/4 pass, 2 fail (`rejects duplicate signup with 409` gets 400, `returns generic 401 for wrong password` gets 429). **Verified this is a pre-existing issue, not a regression from this change** — reproduced identically with the working tree `git stash`ed back to the original Option-A code before this commit. Root cause: all four smoke tests share one Express `authRateLimiter` instance keyed by IP (5 requests / 15 min, per `backend/src/routes/auth.ts`), and the four tests collectively issue 5+ signup/login calls against that one shared bucket within a single `vitest run` process, so the later tests in the file trip the 429 threshold before their own assertions run. This is the same "shared IP-keyed rate-limit bucket" risk already flagged as a non-blocking item in `agents/STATUS.md`'s Open Bugs section from the prior Tester cycle — this run surfaces it as test-order-dependent flakiness in the smoke suite itself, in addition to the previously-flagged product-level concern (a burst of signups locking out a legitimate login from the same IP). Recommend a follow-up ticket to either raise the smoke test's rate limit in test env, mock/reset the limiter between test cases, or split the signup/login buckets — did not fix in this pass since it's outside this ticket's scope (visual layer only) and touches shared auth middleware.

## Definition of done checklist

- [x] Code compiles/lints clean (`tsc --noEmit`, ESLint).
- [x] No migration needed (no schema touched).
- [x] Smoke test suite run — pre-existing 2 failures confirmed unrelated to this change (see Testing notes); not newly introduced or silently skipped.
- [x] STATUS.md updated (Pending Decision #6 resolved).
- [x] MR draft written (this file).
- [x] No secrets committed. No real cloud credentials touched.
