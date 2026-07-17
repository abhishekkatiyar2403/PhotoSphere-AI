# PhotoSphere — Claude Code Build Prompts

Copy each prompt into Claude Code, in order. Do **Setup** first, then one screen at a time, verifying each against `PhotoSphere-standalone.html` open in a browser before moving on.

Fill in the `[bracketed]` blanks once at the top and reuse them.

- **Stack:** `[e.g. Next.js + TypeScript + Tailwind]`
- **API base URL:** `[e.g. https://api.myapp.com]`
- **Auth scheme:** `[e.g. Bearer JWT in Authorization header]`
- **Schema/OpenAPI file (if any):** `[path or URL]`

---

## 0. Setup

> Read `PhotoSphere-standalone.html` and `BACKEND_INTEGRATION.md` in this repo. `PhotoSphere-standalone.html` is the pixel-perfect visual reference; `BACKEND_INTEGRATION.md` is the API + state contract. I want to recreate this UI in **[STACK]** and wire it to my backend at **[API BASE URL]** using **[AUTH SCHEME]**.
>
> First, without writing feature code yet: scaffold the project structure, set up the design tokens (colors, fonts, spacing, radii, shadows) exactly as used in the standalone file, add a global light/dark theme via `data-theme` on `<body>` with accent `#E8A15C`, and create an API client that attaches auth and handles 401 → redirect to login. Confirm the plan before building screens.

---

## 1. Auth (Login / Sign up / Forgot password)

> Recreate the Login, Sign up, and Forgot-password views from `PhotoSphere-standalone.html` exactly — the split-screen photo collage, the animated tagline, fonts, and spacing. Wire to `POST /auth/login`, `POST /auth/signup`, `POST /auth/forgot-password`, and `GET /auth/me`. On success go to the dashboard. Keep `authView` switching client-side.

---

## 2. App shell + responsive layout

> Build the app shell: left sidebar (desktop) with logo, nav (Browse, Search, Upload), and the profile block at the bottom. Reproduce the exact **≤760px mobile behavior**: hide the sidebar, move the **profile/account menu to a round avatar button in the top-right of the top bar**, and put the primary **Upload action as the accent button in the bottom-center tab bar**. Match the top bar (search field + ⌘K hint). Use `window.innerWidth <= 760` as the breakpoint, matching the reference.

---

## 3. Library / Dashboard

> Build the Dashboard and Browse grid exactly as in the reference (masonry-style grid, feature tiles for `big` photos, folder cards with up-to-3 covers). Load from `GET /photos?folder=&sort=&q=` and `GET /folders`. Implement sort (`browseSort`) and folder-chip filtering. Add pagination/infinite scroll. **Replace the prototype's use of array index as photo ID with real server IDs.** Add loading skeletons and error toasts (reuse the existing toast pattern).

---

## 4. Lightbox / photo viewer

> Recreate the full-screen lightbox: swipe/keyboard nav (←/→/Esc), the edit sliders (brightness/contrast/saturation as live preview), favorite toggle, rename, and comments. Wire favorite to `POST/DELETE /photos/:id/favorite`, rename to `PATCH /photos/:id`, comments to `GET/POST /photos/:id/comments`. Decide with me whether slider edits persist via `PATCH /photos/:id`.

---

## 5. Upload

> Recreate the upload flow and its per-file progress bars. Replace the simulated `setInterval` progress with **real** upload progress: `POST /uploads/presign` → upload to storage with progress events feeding the existing `uploads[]` UI → `POST /photos` to finalize. Preserve the exact look of the progress UI.

---

## 6. Folders / organize

> Implement create, rename, delete, move-photo, and merge-folders against `POST/PATCH/DELETE /folders`, `PATCH /photos/:id/move`, and `POST /folders/:id/merge`. Use optimistic updates with rollback on failure. Match the folder menus and organize UI from the reference.

---

## 7. Search / command palette

> Wire the ⌘K command palette and the search view to `GET /search?q=` (debounced). Keep keyboard nav (↑/↓/Enter/Esc) client-side. Match the palette styling and result rows exactly.

---

## 8. Sharing & guests

> Build the share sheet and guests list against `GET /shares/guests`, `POST /shares`, `PATCH /shares/:id`, `POST /shares/:id/revoke`. Reproduce the folder-selection, permission (view/download), expiry, and the link created/copied/sent toasts.

---

## 9. Notifications, Trash, Account

> Wire the bell to `GET /notifications` + mark-read; Trash to `GET /trash` + restore/permanent-delete; and the profile menu items: **Manage plan**, **Account settings** (real routes when ready), **Export my sphere** → `POST /account/export`, **Switch theme** → persist via `PATCH /account`, **Sign out** → `POST /auth/logout`. Storage panel → `GET /account/storage`.

---

## 10. Final pass

> Compare every screen side-by-side with `PhotoSphere-standalone.html` at both desktop and 375px-wide mobile. Fix any spacing, color, font, animation, or responsive drift. Confirm all mocked data and `setTimeout` async from the prototype are gone and replaced with real API calls, and that optimistic updates roll back on error.
