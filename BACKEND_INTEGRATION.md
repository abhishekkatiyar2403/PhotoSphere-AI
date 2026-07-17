# PhotoSphere — Backend Integration Guide

> **For the developer (Claude Code):** This document maps the PhotoSphere frontend prototype to the backend it needs. The bundled `PhotoSphere.dc.html` is a **design reference** — a working HTML/JS prototype showing the intended UI, state, and interactions. It currently runs on **hardcoded in-memory arrays and `setTimeout`-simulated async**. Your job is to **replace those mocks with real API calls** in the target codebase, preserving the exact UI behavior described here.
>
> Do not ship the HTML file itself. Recreate/keep the UI in the app's real framework and wire the state described below to real endpoints.

---

## 1. How the prototype is built (so you know what to replace)

- Single component `class Component` (a React-style class). All app state lives in `this.state`.
- **All data is mocked**: a `PHOTOS = [...]` array (18 items), plus `trash`, `notifications`, `guestsList`, etc. seeded in `state`.
- **All async is faked** with `setTimeout` / `setInterval` (uploads animate a fake `progress`; pull-to-refresh waits 1.1s; toasts auto-dismiss).
- Mutations are local `setState` only — nothing persists across reload except a couple of `localStorage` flags (`ps_tour_done`, theme).

**Replacement principle:** every place the prototype mutates `state` optimistically, keep the optimistic update but add a real API call behind it, and reconcile/rollback on failure. Every seeded array becomes a fetch on load.

---

## 2. Core data models

### Photo
The prototype's `PHOTOS[i]` shape (note: the array **index `i` is currently used as the photo ID everywhere** — favorites, folder overrides, deletions, comments, the lightbox `viewer`, uploads. Replace with a stable server `id` and map it through).

```jsonc
{
  "id": "string",              // NEW — replace reliance on array index
  "src": "url",                // full-res / display URL
  "thumbnailUrl": "url",       // recommended addition for grid perf
  "title": "Dusk over the Alps",
  "place": "Chamonix, France", // location / caption
  "folder": "Landscapes",      // server-side folder; UI can override (see moves)
  "tags": ["sunset", "mountains"],
  "date": "2026-06-28",        // ISO; prototype uses "Jun 28, 2026" display strings
  "size": "24.1 MB",           // bytes on server; format client-side
  "big": true,                 // OPTIONAL layout hint (feature-tile). Can be server flag or client heuristic
  "kind": "photo | video",     // videos exist — see VIDEOS map
  "durationLabel": "0:42"      // for videos (prototype hardcodes VIDEOS = {1:"0:42",6:"1:15",11:"0:28"})
}
```

### Folder
Folders are currently just strings derived from `photo.folder`, plus client-side `customFolders`, `folderLabels` (renames), `deletedFolders`, and `photoFolderOverrides` (moves not yet persisted). Consolidate into a real entity:

```jsonc
{
  "id": "string",
  "name": "Landscapes",
  "photoCount": 6,
  "coverPhotoIds": ["..."],    // up to 3 covers shown on folder card
  "createdAt": "iso"
}
```

### User / Account (profile menu)
```jsonc
{
  "id": "string",
  "name": "Alex Rivera",
  "email": "alex@egain.com",
  "avatarInitial": "A",
  "plan": "Pro",               // shown as "Pro" pill / "Pro plan"
  "theme": "dark | light",     // persist per user
  "storageUsedBytes": 0,
  "storageQuotaBytes": 0
}
```

### Comment (per photo)
```jsonc
{ "id": "string", "photoId": "string", "by": "You", "text": "...", "when": "just now", "createdAt": "iso" }
```

### Guest / Share
```jsonc
{
  "id": 1,
  "email": "guest@example.com",
  "status": "pending | active | revoked",
  "lastSeen": "iso",
  "permission": "view | download",
  "folders": ["Uncategorized", "Food"],
  "expiresAt": "iso",          // from shareExpiry ("7" days etc.)
  "linkId": "string"           // shareable link token
}
```

### Notification
```jsonc
{ "id": "string", "text": "...", "when": "2h ago", "createdAt": "iso", "read": false }
```

### Trash item
```jsonc
{ "id": "string", "src": "url", "title": "...", "kind": "Photo | Folder · 4 photos", "deletedAt": "iso", "daysUntilPurge": 28 }
```

---

## 3. Suggested REST API

Adapt verbs/paths to the target codebase's conventions (GraphQL, tRPC, etc. are fine — the contract is what matters).

### Auth  (screen: Login / Sign up / Forgot password)
State involved: `authView` (`"login" | "signup" | "forgot"`), `signupName/Email/Password`, `forgotEmail`. Handlers `goLogin`, sign-out.

- `POST /auth/login` → `{ email, password }` → `{ user, token }`. On success set `view: "dashboard"`.
- `POST /auth/signup` → `{ name, email, password }` → `{ user, token }`.
- `POST /auth/forgot-password` → `{ email }` → `202`. UI just confirms "reset link sent".
- `POST /auth/logout` (profile menu **Sign out** → returns to Login view).
- `GET /auth/me` → current `user` (drives avatar initial, name, email, plan, theme on load).

### Photos & Library  (screen: Dashboard / Browse)
State: `PHOTOS`, `favorites[]`, `browseSort` (`"newest"` etc.), `chip` (active folder filter), `q` (search text).

- `GET /photos?folder=&sort=newest&q=` → `Photo[]` (replaces the `PHOTOS` seed). Support sort values used by `browseSort` and folder filter via `chip`.
- `GET /photos/:id` → single photo (lightbox / `viewer`).
- `PATCH /photos/:id` → rename title (`photoTitles`/`renamingPhoto` flow), edit metadata.
- `POST /photos/:id/favorite` / `DELETE /photos/:id/favorite` → toggles `favorites`. **Currently `toggleFavorite(i)` just mutates local array — make it call this.**
- `PATCH /photos/:id/move` → `{ folderId }` (replaces `photoFolderOverrides` / `movePhoto`).
- `DELETE /photos/:id` → soft-delete to trash (replaces `deletePhotoToTrash` + `deletedPhotoIdx`).

### Upload  (button: bottom-center on mobile, top-bar on desktop; handler `goUpload`)
The prototype fakes progress with `setInterval`. Real flow:

1. `POST /uploads/presign` (or direct multipart) → get upload targets.
2. Upload each file (PUT to storage / multipart), reporting **real** progress to replace the simulated `u.progress`/`u.speed` per-item bars.
3. `POST /photos` to finalize metadata → returns created `Photo`.
- Keep the existing per-file progress UI (`state.uploads = [{ name, progress, speed }]`); feed it XHR/fetch progress events instead of the timer.

### Folders  (Dashboard folder cards / organize)
- `GET /folders` → `Folder[]`.
- `POST /folders` → `{ name }` (replaces `createNewFolder` / `customFolders`).
- `PATCH /folders/:id` → rename (replaces `folderLabels` / `renamingFolder`).
- `DELETE /folders/:id` → (replaces `deletedFolders`).
- `POST /folders/:id/merge` → `{ targetId }` (replaces `mergeFolders`).

### Search / Command palette  (⌘K, handler `goSearch`)
- `GET /search?q=` → `{ photos: Photo[], folders: Folder[] }`. The palette currently filters the local `PHOTOS` array on `title + place + tags`; point it at this endpoint (debounced). Keep keyboard nav (↑/↓/Enter/Esc) client-side.

### Comments  (lightbox)
- `GET /photos/:id/comments` → `Comment[]` (replaces `photoComments[i]`).
- `POST /photos/:id/comments` → `{ text }` (replaces the `commentDraft` submit).

### Sharing & Guests  (share sheet)
State: `shareSelectedFolders`, `shareGuestEmail`, `sharePermission`, `shareExpiry`, `guestsList`.
- `GET /shares/guests` → `Guest[]`.
- `POST /shares` → `{ folderIds, email, permission, expiryDays }` → `{ guest, linkId }`. Drives the "link created / copied / sent" toasts (`freshLinkId`, `freshLinkCopied`, `freshLinkSent`).
- `PATCH /shares/:id` → change permission/folders.
- `POST /shares/:id/revoke` → sets `status: "revoked"`.

### Notifications  (bell)
- `GET /notifications` → `Notification[]` (replaces seeded `notifications`).
- `POST /notifications/read` (bulk or per-id) → mark read.
- Note: `showToast()` currently also **prepends a synthetic notification** for every toast. Decide whether toasts should create real notifications server-side or stay client-only.

### Trash
- `GET /trash` → `TrashItem[]` (replaces seeded `trash`).
- `POST /trash/:id/restore` → (replaces `lastRecovered` flow).
- `DELETE /trash/:id` → permanent delete.

### Account / Profile menu
The menu items **Manage plan** (`openManagePlan`) and **Account settings** (`openAccountSettings`) currently just show "coming soon" toasts — wire to real routes/pages when those exist.
- `GET /account/storage` → storage used/quota (storage panel `storageOpen`).
- **Export my sphere** (`exportSphere`) → `POST /account/export` → kicks off an export job; poll or email a download link.
- **Switch theme** (`toggleTheme`) → `PATCH /account` `{ theme }` (persist per user; prototype only toggles `body[data-theme]` + local state).

---

## 4. State → source-of-truth summary

Replace-on-load (currently seeded constants): `PHOTOS`, `notifications`, `guestsList`, `trash`, `VIDEOS`.

Persist-on-mutate (currently local `setState` only): `favorites`, `photoFolderOverrides`, `customFolders`, `folderLabels`, `deletedFolders`, `deletedPhotoIdx`, `photoTitles`, `photoComments`, `theme`, share/guest changes, notification read state.

Pure UI / keep client-side (do NOT send to backend): `view`, `authView`, `viewer`, `isMobile`, `moreSheetOpen`, `profileMenuOpen`, `bellOpen`, `folderMenuOpen`, `moveMenuOpenIdx`, `paletteOpen/Query/Index`, `tourStep`, `ptr/refreshing` (pull-to-refresh), `editB/editC/editSat` (non-destructive preview sliders — decide if edits should be saved via `PATCH /photos/:id`), `introDone`, `downloadToast`, all `*Open`/`*Draft`/`selectMode` flags.

---

## 5. Responsive behavior the backend does not change (but you must preserve)

- Breakpoint: **`window.innerWidth <= 760`** sets `isMobile`.
- **Mobile:** profile/account menu is a round avatar button in the **top-right** of the top bar; the primary **Upload** action is the accent button in the **bottom-center** tab bar (top-bar upload is hidden via `topbarUploadDisplay`).
- **Desktop:** profile lives in the left sidebar; Upload is a top-bar button.
- Mobile also has pull-to-refresh, swipe-to-dismiss lightbox, and a bottom sheet — these are pure client interactions.

---

## 6. Cross-cutting concerns to implement

- **Auth token** on every request; 401 → bounce to Login (`view: "login"`).
- **Optimistic updates + rollback** for favorite, move, rename, delete, share-revoke (prototype is optimistic with no rollback — add it).
- **Pagination / infinite scroll** for `GET /photos` (prototype loads all 18 at once).
- **Debounce** search input to `GET /search`.
- **Real upload progress** wired into the existing `uploads[]` progress UI.
- **Error + loading states**: the prototype has none. Add spinners/skeletons for library load and error toasts (reuse the existing `showToast` mechanism).
- **Image sizing**: serve `thumbnailUrl` for grids, full `src` only in the lightbox.

---

## 7. Files in this bundle

- `PhotoSphere.dc.html` — the full frontend prototype (design + behavior reference). Search it for the handler and `state` names quoted above to see exact intended behavior.
- `support.js` — runtime for the prototype (needed only to run the HTML locally for reference; not part of your backend work).

To preview the reference locally, serve the folder and open `PhotoSphere.dc.html` in a browser.
