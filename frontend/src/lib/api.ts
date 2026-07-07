const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;
  // The full parsed JSON error body, when present — added for the trash
  // system's restore-collision 409, whose payload carries
  // conflictingFolderId/conflictingFolderName alongside `error: "conflict"`.
  // Every earlier call site only ever read `.message`/`.status`, so this is
  // purely additive.
  body: Record<string, unknown> | null;
  constructor(message: string, status: number, body: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include", // required so the opaque session cookie round-trips
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(body?.error ?? "Request failed", res.status, body ?? null);
  }

  return body;
}

export const authApi = {
  signup: (input: { email: string; password: string; name: string }) =>
    apiFetch("/api/auth/signup", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
  logout: () => apiFetch("/api/auth/logout", { method: "POST" }),
  me: () => apiFetch("/api/auth/me", { method: "GET" }),
};

// Bare-bones upload/poll/preview round-trip only - deliberately unstyled per
// specs/upload-pipeline.md (the polished upload UI is Week 7-8 scope).
async function uploadFile(file: File) {
  const res = await fetch(`${API_BASE_URL}/api/photos/upload`, {
    method: "POST",
    credentials: "include",
    body: (() => {
      const form = new FormData();
      form.append("file", file);
      return form;
    })(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body?.error ?? "Upload failed", res.status);
  }
  return body as { photoId: string; jobId: string; status: string };
}

// XMLHttpRequest-based upload (specs/dashboard-stats-and-upload-polish.md
// "Upload flow polish" Open Question 4 default): fetch has no native
// upload-progress signal, so this is a transport-layer-only swap scoped to
// this one call site. Same request (POST /api/photos/upload, multipart
// "file" field, credentials/cookie behavior) and same response contract as
// uploadFile above - onProgress is purely additive.
function uploadFileWithProgress(
  file: File,
  onProgress?: (fractionComplete: number) => void,
): Promise<{ photoId: string; jobId: string; status: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/photos/upload`);
    // XHR's equivalent of fetch's credentials: "include" - required so the
    // opaque session cookie round-trips cross-origin, same as apiFetch.
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (!onProgress) return;
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      let body: unknown = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        body = {};
      }
      const parsed = body as { error?: string; photoId?: string; jobId?: string; status?: string };
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(parsed as { photoId: string; jobId: string; status: string });
      } else {
        reject(new ApiError(parsed?.error ?? "Upload failed", xhr.status));
      }
    };

    xhr.onerror = () => {
      reject(new ApiError("Upload failed", 0));
    };

    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

// Full photo detail (GET /api/photos/:id) - the shape the Photo viewer needs
// on top of what a grid card already has: full-resolution original.url and
// the exif object. specs/week7-8-dashboard-browser-viewer.md confirmed this
// exact shape against the live route (no new backend field needed).
export type PhotoDetail = {
  id: string;
  status: "pending" | "processing" | "done" | "duplicate" | "failed";
  originalFilename: string;
  original: { url: string; expiresInSeconds: number };
  thumbnails: Record<string, string>;
  exif: {
    takenAt: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    cameraMake: string | null;
    cameraModel: string | null;
  };
  folder: { id: string; name: string } | null;
  collectionId: string | null;
};

// Trash system (specs/trash-system.md). Single photo soft-delete returns
// { deleted, photoId, folderId, deletedAt, purgeAt } / 409 if the photo's
// folder is live-shared (T2, reversed — same posture as folder-level F1).
export type DeletePhotoResponse = {
  deleted: true;
  photoId: string;
  folderId: string | null;
  deletedAt: string;
  purgeAt: string;
};

// Bulk soft-delete (max 100 ids) — partial success. A uniform "not_found"
// reason covers not-owned/nonexistent/already-trashed/blocked-by-live-share;
// the backend deliberately does not distinguish which (see routes/photos.ts).
export type BulkDeletePhotosResponse = {
  deleted: string[];
  failed: { id: string; reason: "not_found" }[];
};

// Photo restore auto-cascades into restoring an also-trashed folder first; if
// that hits an unresolved name collision, the call REJECTS with an ApiError
// (status 409, .body carrying the SAME conflict shape a folder-restore 409
// does: { error: "conflict", conflictingFolderId, conflictingFolderName }) —
// same as foldersApi.restore's collision. Callers catch it via ApiError, not
// a discriminated return value.
export type PhotoRestoreResult = {
  restored: true;
  id: string;
  folderId: string | null;
  folder: { id: string; name: string } | null;
};

export type RestoreConflictBody = { error: "conflict"; conflictingFolderId: string; conflictingFolderName: string };

export function isRestoreConflict(err: unknown): err is ApiError & { body: RestoreConflictBody } {
  return err instanceof ApiError && err.status === 409 && err.body?.error === "conflict";
}

export const photosApi = {
  upload: uploadFile,
  uploadWithProgress: uploadFileWithProgress,
  status: (photoId: string) => apiFetch(`/api/photos/${photoId}/status`, { method: "GET" }),
  get: (photoId: string): Promise<PhotoDetail> => apiFetch(`/api/photos/${photoId}`, { method: "GET" }),
  move: (photoId: string, folderId: string) =>
    apiFetch(`/api/photos/${photoId}`, { method: "PATCH", body: JSON.stringify({ folderId }) }),
  reclassify: (photoId: string) =>
    apiFetch(`/api/photos/${photoId}/reclassify`, { method: "POST" }),
  remove: (photoId: string): Promise<DeletePhotoResponse> =>
    apiFetch(`/api/photos/${photoId}`, { method: "DELETE" }),
  bulkDelete: (photoIds: string[]): Promise<BulkDeletePhotosResponse> =>
    apiFetch("/api/photos/bulk-delete", { method: "POST", body: JSON.stringify({ photoIds }) }),
  restore: (photoId: string): Promise<PhotoRestoreResult> =>
    apiFetch(`/api/photos/${photoId}/restore`, { method: "POST" }),
};

// Trash page (design/wireframes/trash-page.svg, Option A — dedicated /trash
// page). GET /api/trash lists both sections in one paginated-per-section
// response; DELETE /api/trash/:type/:id purges one item now (skips the
// 7-day wait); DELETE /api/trash empties everything.
export type TrashPhotoItem = {
  id: string;
  originalFilename: string;
  folderId: string | null;
  deletedAt: string;
  purgeAt: string;
  daysRemaining: number;
};

export type TrashFolderItem = {
  id: string;
  name: string;
  categoryType: "ai_generated" | "custom";
  photoCount: number;
  deletedAt: string;
  purgeAt: string;
  daysRemaining: number;
};

export type TrashListResponse = {
  photos: TrashPhotoItem[];
  photoTotal: number;
  folders: TrashFolderItem[];
  folderTotal: number;
  limit: number;
  offset: number;
};

export type FolderRestoreResult =
  | { restored: true; id: string; name: string; categoryType: "ai_generated" | "custom"; photoCount: number }
  | { merged: true; targetFolderId: string; photosMoved: number; targetPhotoCount: number };

export const trashApi = {
  list: (params: { limit?: number; offset?: number } = {}): Promise<TrashListResponse> => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return apiFetch(`/api/trash${q ? `?${q}` : ""}`, { method: "GET" });
  },
  purgeOne: (type: "photo" | "folder", id: string): Promise<{ purged: true; type: string; id: string }> =>
    apiFetch(`/api/trash/${type}/${id}`, { method: "DELETE" }),
  emptyAll: (): Promise<{ emptied: true; photosDeleted: number; foldersDeleted: number }> =>
    apiFetch("/api/trash", { method: "DELETE" }),
};

// Organize page (specs/ai-classification.md §6 - reclassification UI,
// design/wireframes/reclassify-ui.svg Option A). Thin wrappers around the
// already-shipped collections/folders endpoints - same apiFetch/ApiError
// conventions as authApi/photosApi above.
export const collectionsApi = {
  list: (): Promise<{ collections: { id: string; name: string; isDefault: boolean; createdAt: string }[] }> =>
    apiFetch("/api/collections", { method: "GET" }),
};

export type Folder = {
  id: string;
  name: string;
  categoryType: "ai_generated" | "custom";
  photoCount: number;
  createdAt: string;
};

// Folder rename/merge/delete (specs/folder-mgmt-download-search.md PART P4,
// design/wireframes/folder-mgmt.svg - Option A). Thin wrappers on the live,
// Tester-verified backend (routes/folders.ts). Same apiFetch/ApiError shape:
// - rename: 200 (updated folder) / 409 name-collision / 400 empty / 404.
// - merge:  200 / 409 shared-with-guest (F1) / 400 self-or-cross-collection /
//           404. On 200 the source folder is removed and its photos live in
//           the target; the caller refreshes the tree + counts.
// - remove: 200 { deleted, photosOrphaned } / 409 shared-with-guest (F1) / 404.
//           On 200 the folder's photos become Unfiled (folderId = null) - they
//           are NOT deleted - so the caller refreshes the tree + Unfiled count.
export type RenamedFolder = {
  id: string;
  name: string;
  categoryType: "ai_generated" | "custom";
  photoCount: number;
  collectionId: string;
};

export type MergeFolderResponse = {
  merged: true;
  targetFolderId: string;
  photosMoved: number;
  targetPhotoCount: number;
};

// Response shape REVISED by specs/trash-system.md — the old `photosOrphaned`
// field is GONE (nothing is orphaned anymore; the folder + its photos move to
// Trash together, recoverable for 7 days). See DELETE /api/folders/:id in
// routes/folders.ts.
export type DeleteFolderResponse = { deleted: true; deletedAt: string; purgeAt: string };

export const foldersApi = {
  list: (collectionId: string): Promise<{ folders: Folder[] }> =>
    apiFetch(`/api/collections/${collectionId}/folders`, { method: "GET" }),
  create: (collectionId: string, name: string): Promise<Folder> =>
    apiFetch(`/api/collections/${collectionId}/folders`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  rename: (id: string, name: string): Promise<RenamedFolder> =>
    apiFetch(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  merge: (id: string, targetFolderId: string): Promise<MergeFolderResponse> =>
    apiFetch(`/api/folders/${id}/merge`, {
      method: "POST",
      body: JSON.stringify({ targetFolderId }),
    }),
  remove: (id: string): Promise<DeleteFolderResponse> =>
    apiFetch(`/api/folders/${id}`, { method: "DELETE" }),
  restore: (id: string, onConflict?: "merge" | "rename", newName?: string): Promise<FolderRestoreResult> =>
    apiFetch(`/api/folders/${id}/restore`, {
      method: "POST",
      body: JSON.stringify({ onConflict, newName }),
    }),
};

// Bulk "download all" (specs/folder-mgmt-download-search.md PART P5). Both
// endpoints STREAM a zip with Content-Disposition: attachment - the browser
// should SAVE the file, so this is deliberately NOT an apiFetch (which reads
// the body into JS): it returns the absolute, credentialed URL the caller
// navigates/anchors the browser to (a normal authenticated GET the browser
// saves). credentials ride via the same-origin cookie on a top-level
// navigation / an <a> click. The owner endpoint uses the owner session cookie;
// the guest endpoint uses the guest-session cookie - both round-trip
// automatically on a browser navigation to API_BASE_URL, exactly as
// credentials:"include" does for apiFetch.
export const downloadAllApi = {
  ownerFolderUrl: (folderId: string): string =>
    `${API_BASE_URL}/api/folders/${folderId}/download-all`,
  guestFolderUrl: (folderId: string): string =>
    `${API_BASE_URL}/api/guest/folders/${folderId}/download-all`,
};

export type FolderPhoto = {
  id: string;
  originalFilename: string;
  status: "pending" | "processing" | "done" | "duplicate" | "failed";
  aiLabels: string[];
  aiConfidence: number | null;
  // Additive fields (backend change, see routes/folders.ts's PHOTO_CARD_SELECT/
  // toPhotoCard) - only meaningful when status === "duplicate".
  duplicateOfPhotoId: string | null;
  dedupMethod: "sha256" | "phash" | null;
  thumbnailUrl: string | null;
};

type FolderPhotosResponse = { photos: FolderPhoto[]; total: number; limit: number; offset: number };

export const folderPhotosApi = {
  list: (folderId: string, params: { limit: number; offset: number }): Promise<FolderPhotosResponse> =>
    apiFetch(`/api/folders/${folderId}/photos?limit=${params.limit}&offset=${params.offset}`, {
      method: "GET",
    }),
};

// GET /api/photos/unfiled (backend addition - see routes/photos.ts for the
// gap this closes: failed/duplicate photos have folderId: null and are
// otherwise invisible to any folder listing). User-scoped, NOT
// collection-scoped, so it works even before the user has ever had a
// collection created (bug fix, reports/2026-07-03_0731.md "New Failures"
// [High] - a brand-new user whose very first photo fails/dedupes before any
// collection exists had no way to reach it, since GET /api/collections
// returned [] and the old collection-scoped
// GET /api/collections/:id/unfiled-photos required a collection id that
// didn't exist yet).
export const unfiledPhotosApi = {
  list: (params: { limit: number; offset: number }): Promise<FolderPhotosResponse> =>
    apiFetch(`/api/photos/unfiled?limit=${params.limit}&offset=${params.offset}`, { method: "GET" }),
};

// Dashboard stats (GET /api/dashboard, backend/src/routes/dashboard.ts).
// storage byte values are returned as STRINGS deliberately - BigInt is not
// JSON-serializable, so the server stringifies them; the client parses them
// to Number for human-readable formatting (see the dashboard page's
// formatBytes). usedPercent is a pre-computed float 0-1 (server does the
// BigInt->float math so the client never touches BigInt division).
export type DashboardStats = {
  storage: {
    usedBytes: string;
    limitBytes: string;
    usedPercent: number;
  };
  totals: {
    photoCount: number;
    folderCount: number;
    collectionCount: number;
  };
  collections: {
    id: string;
    name: string;
    isDefault: boolean;
    folderCount: number;
    photoCount: number;
  }[];
};

export const dashboardApi = {
  get: (): Promise<DashboardStats> => apiFetch("/api/dashboard", { method: "GET" }),
};

// --- Guest Access + OTP (specs/guest-access-otp.md) ---
// Two client "contexts" on the same apiFetch/ApiError/credentials:"include"
// conventions as everything above: an OWNER context (guestsApi,
// accessRequestsApi - requireAuth-gated, same cookie as authApi) and a GUEST
// context (invitesApi, guestPortalApi - requireGuest-gated, a distinct
// httpOnly cookie the browser stores automatically once
// GET /api/invites/requests/:id/status sets it - see Day3.md's G7 note).

export type PermissionLevel = "view" | "download" | "download_all";

// Owner: create a share (POST /api/guests).
export type CreateGuestInput = {
  guestEmail: string;
  guestName?: string;
  folderIds: string[];
  permissionLevel: PermissionLevel;
  expiresInDays?: number;
};

export type CreateGuestResponse = {
  guestId: string;
  inviteToken: string;
  inviteUrl: string;
  expiresAt: string | null;
};

export type GuestListItem = {
  id: string;
  email: string;
  name: string | null;
  status: "pending" | "active" | "revoked" | "expired";
  permissionLevel: PermissionLevel | null;
  folders: { id: string; name: string }[];
  lastAccessAt: string | null;
  createdAt: string;
};

export const guestsApi = {
  create: (input: CreateGuestInput): Promise<CreateGuestResponse> =>
    apiFetch("/api/guests", { method: "POST", body: JSON.stringify(input) }),
  list: (): Promise<{ guests: GuestListItem[] }> => apiFetch("/api/guests", { method: "GET" }),
  revoke: (guestId: string): Promise<{ ok: true }> =>
    apiFetch(`/api/guests/${guestId}`, { method: "DELETE" }),
};

// Owner: the OTP-approval queue (GET/POST /api/access-requests).
export type AccessRequestStatus = "pending" | "approved" | "denied" | "expired";

export type AccessRequestItem = {
  id: string;
  status: AccessRequestStatus;
  guest: { id: string; email: string; name: string | null };
  ipAddress: string | null;
  deviceInfo: { userAgent: string | null } | null;
  createdAt: string;
  resolvedAt: string | null;
};

export const accessRequestsApi = {
  list: (status: AccessRequestStatus | "all" = "pending"): Promise<{ requests: AccessRequestItem[] }> =>
    apiFetch(`/api/access-requests?status=${status}`, { method: "GET" }),
  approve: (requestId: string, otp: string): Promise<{ status: "approved" }> =>
    apiFetch(`/api/access-requests/${requestId}/approve`, {
      method: "POST",
      body: JSON.stringify({ otp }),
    }),
  deny: (requestId: string): Promise<{ status: "denied" }> =>
    apiFetch(`/api/access-requests/${requestId}/deny`, { method: "POST" }),
};

// Guest (public, unauthenticated token entry - POST /api/invites/:token/request
// and the status poll). credentials:"include" here is load-bearing: it's how
// the browser both sends and (on the status poll, once approved) STORES the
// httpOnly guest-session cookie the backend sets directly on this response -
// see Day3.md's G7 handoff note. No Authorization header, no raw token ever
// held in JS - the cookie round-trips invisibly to the caller.
export type InviteRequestResponse =
  | { requestId: string; status: "pending" }
  | { status: "already_approved" };

export type InviteStatusResponse = { status: AccessRequestStatus | "already_approved" };

export const invitesApi = {
  request: (token: string): Promise<InviteRequestResponse> =>
    apiFetch(`/api/invites/${token}/request`, { method: "POST" }),
  status: (requestId: string): Promise<InviteStatusResponse> =>
    apiFetch(`/api/invites/requests/${requestId}/status`, { method: "GET" }),
};

// Guest portal (guest-session cookie required - GET /api/guest/*).
export type GuestFolder = {
  id: string;
  name: string;
  photoCount: number;
  permissionLevel: PermissionLevel;
};

export type GuestPhotoDetail = {
  id: string;
  originalFilename: string;
  original: { url: string; expiresInSeconds: number };
  thumbnails: Record<string, string>;
  exif: {
    takenAt: string | null;
    gpsLat: number | null;
    gpsLng: number | null;
    cameraMake: string | null;
    cameraModel: string | null;
  };
  folderId: string | null;
};

export const guestPortalApi = {
  folders: (): Promise<{ folders: GuestFolder[] }> => apiFetch("/api/guest/folders", { method: "GET" }),
  folderPhotos: (
    folderId: string,
    params: { limit: number; offset: number },
  ): Promise<FolderPhotosResponse> =>
    apiFetch(`/api/guest/folders/${folderId}/photos?limit=${params.limit}&offset=${params.offset}`, {
      method: "GET",
    }),
  photo: (photoId: string): Promise<GuestPhotoDetail> =>
    apiFetch(`/api/guest/photos/${photoId}`, { method: "GET" }),
  download: (photoId: string): Promise<{ download: { url: string; expiresInSeconds: number } }> =>
    apiFetch(`/api/guest/photos/${photoId}/download`, { method: "GET" }),
};

// --- Owner activity log (specs/audit-and-polish.md §A4, GET /api/audit) ---
// The owner-scoped, append-only, list-only audit trail powering the /activity
// page (design/wireframes/audit-viewer.svg - P7 Option A). requireAuth-gated,
// same owner cookie as authApi; the response carries NO image data / no
// pre-signed URLs - only ids + metadata captured at write time. Same
// apiFetch/ApiError/credentials:"include" conventions as every group above.

export type AuditAction =
  | "share_created"
  | "access_requested"
  | "access_approved"
  | "access_denied"
  | "guest_revoked"
  | "photo_viewed"
  | "photo_downloaded";

export type AuditActorType = "owner" | "guest";

// metadata is whatever the choke point captured at write time (see the
// backend's logAudit calls). It's deliberately loose - the page reads known
// keys defensively (folderNames, folderName, guestEmail, permissionLevel,
// reason, folderId) and falls back to ids when a label is absent (append-only
// history can outlive the resource it describes).
export type AuditMetadata = Record<string, unknown> | null;

export type AuditEntry = {
  id: string;
  actorType: AuditActorType;
  actor: { id: string; email?: string };
  action: AuditAction;
  resourceType: string | null;
  resourceId: string | null;
  metadata: AuditMetadata;
  ipAddress: string | null;
  createdAt: string;
};

export type AuditListResponse = {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
};

export type AuditListParams = {
  limit?: number;
  offset?: number;
  action?: AuditAction;
  actorType?: AuditActorType;
  from?: string; // ISO date
  to?: string; // ISO date
};

export const auditApi = {
  list: (params: AuditListParams = {}): Promise<AuditListResponse> => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));
    if (params.action) qs.set("action", params.action);
    if (params.actorType) qs.set("actorType", params.actorType);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const q = qs.toString();
    return apiFetch(`/api/audit${q ? `?${q}` : ""}`, { method: "GET" });
  },
};

// --- Basic search (specs/folder-mgmt-download-search.md PART P6,
// design/wireframes/search.svg - Option A: dedicated /search page). Owner-
// scoped GET /api/search over the caller's own library by filename substring,
// createdAt date range, folder, and category. Same apiFetch/ApiError shape;
// results are photo cards with pre-signed 60s thumbnails (never a raw key) -
// the SAME FolderPhoto/{photos,total,limit,offset} shape as
// GET /api/folders/:id/photos, so the /search grid reuses the existing card.
// A bare search (no filters) returns the whole library newest-first (S6). A
// bad limit/date/category → 400 (surfaced as an ApiError). folderId accepts a
// real folder UUID, the reserved literal "unfiled" (folderId = null photos),
// or is omitted for "all folders".

// The 8 categories the backend accepts (matched against the owner's own folder
// names, S1). Kept as a const tuple so the /search dropdown and the type stay
// in lockstep. "unfiled" is a folderId literal, not a category.
export const SEARCH_CATEGORIES = [
  "People",
  "Nature",
  "Animals",
  "Food",
  "Vehicles",
  "Documents",
  "Screenshots",
  "Uncategorized",
] as const;

export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export type SearchParams = {
  q?: string;
  from?: string; // ISO date (YYYY-MM-DD accepted by the backend)
  to?: string; // ISO date
  folderId?: string; // a folder UUID, or the literal "unfiled"
  category?: SearchCategory;
  limit?: number;
  offset?: number;
};

export type SearchResponse = {
  photos: FolderPhoto[];
  total: number;
  limit: number;
  offset: number;
};

export const searchApi = {
  search: (params: SearchParams = {}): Promise<SearchResponse> => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.folderId) qs.set("folderId", params.folderId);
    if (params.category) qs.set("category", params.category);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));
    const q = qs.toString();
    return apiFetch(`/api/search${q ? `?${q}` : ""}`, { method: "GET" });
  },
};
