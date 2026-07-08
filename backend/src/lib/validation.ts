import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().trim().min(1, "Name is required").max(255),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

// --- specs/ai-classification.md §6-7 ---

// POST /api/collections/:id/folders — manual (custom) folder creation.
export const createFolderSchema = z.object({
  name: z.string().trim().min(1, "Folder name is required").max(255, "Folder name too long"),
});

// PATCH /api/photos/:id — manual move between folders.
export const movePhotoSchema = z.object({
  folderId: z.string().uuid("folderId must be a UUID"),
});

// GET /api/folders/:id/photos — pagination. Non-numeric, negative, or
// over-max values are a 400, not silently clamped.
export const folderPhotosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type MovePhotoInput = z.infer<typeof movePhotoSchema>;
export type FolderPhotosQuery = z.infer<typeof folderPhotosQuerySchema>;

// --- specs/folder-mgmt-download-search.md PART P4 ---

// PATCH /api/folders/:id — rename only (reorder is out of scope, F6). Trimmed;
// empty/whitespace → 400 before any DB write. Collision (@@unique[collectionId,
// name]) is caught as P2002 → 409 in the route, NOT an app pre-check.
export const folderRenameSchema = z.object({
  name: z.string().trim().min(1, "Folder name is required").max(255, "Folder name too long"),
});

// POST /api/folders/:id/merge — merge source A (:id) into target B (targetFolderId).
export const folderMergeSchema = z.object({
  targetFolderId: z.string().uuid("targetFolderId must be a UUID"),
});

export type FolderRenameInput = z.infer<typeof folderRenameSchema>;
export type FolderMergeInput = z.infer<typeof folderMergeSchema>;

// --- specs/trash-system.md ---

// POST /api/photos/bulk-delete — soft-delete many photos at once (PD5,
// reused unchanged: partial-success, per-id result list). Non-empty, max 100
// (house rule: hard cap, not a silent clamp).
export const bulkDeletePhotosSchema = z.object({
  photoIds: z
    .array(z.string().uuid("each photoId must be a UUID"))
    .min(1, "photoIds must not be empty")
    .max(100, "photoIds must not exceed 100"),
});

// GET /api/trash — paginated, per-section limit/offset (same convention as
// folderPhotosQuerySchema/searchQuerySchema — limit > 100 is a 400, not a clamp).
export const trashListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// DELETE /api/trash/:type/:id — :type is exactly "photo" or "folder"; an
// unknown value is a 400 (Zod enum), never silently coerced.
export const trashTypeParamSchema = z.enum(["photo", "folder"]);

// POST /api/folders/:id/restore — FINAL DECISION 4 (specs/trash-system.md):
// on a name collision, the caller may resolve it inline via onConflict.
// `newName` only required/used when onConflict === "rename" (checked in the
// route, since Zod's cross-field refine adds complexity for a 2-branch case
// already validated explicitly in the handler).
export const folderRestoreSchema = z
  .object({
    onConflict: z.enum(["merge", "rename"]).optional(),
    newName: z.string().trim().min(1, "Folder name is required").max(255, "Folder name too long").optional(),
  })
  .optional();

export type BulkDeletePhotosInput = z.infer<typeof bulkDeletePhotosSchema>;
export type TrashListQuery = z.infer<typeof trashListQuerySchema>;
export type TrashTypeParam = z.infer<typeof trashTypeParamSchema>;
export type FolderRestoreInput = z.infer<typeof folderRestoreSchema>;

// POST /api/photos/:id/restore — specs/trash-system.md FINAL DECISION 5,
// REVISED 2026-07-09: the trashed folder is never touched by a single-photo
// restore. `onConflict` here resolves against a LIVE same-named folder found
// in the same collection as the (untouched) trashed folder the photo used to
// belong to — semantically distinct from folderRestoreSchema's "merge"/
// "rename" (there is no merge/rename of the trashed folder happening here at
// all, just where the ONE photo lands).
export const photoRestoreSchema = z
  .object({
    onConflict: z.enum(["existing", "new"]).optional(),
    newName: z.string().trim().min(1, "Folder name is required").max(255, "Folder name too long").optional(),
  })
  .optional();

export type PhotoRestoreInput = z.infer<typeof photoRestoreSchema>;

// --- specs/folder-mgmt-download-search.md PART P6 (basic search) ---

// S1: the known AI categories. `category` is matched against the photo's FOLDER
// NAME (the AI-generated folders ARE named for their category) — no new column,
// no new index. An unknown value → 400 (Zod enum). Raw-Vision-label search is
// DEFERRED (labels aren't in a queryable per-photo column this pass).
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

// The reserved literal for folderId that selects photos with folderId = null
// (S3). A real folderId is a UUID; "unfiled" is the one non-UUID accepted value.
export const UNFILED_FOLDER_LITERAL = "unfiled";

// GET /api/search — owner-scoped. All filters via query (S1–S7 defaults):
//  - q: substring on originalFilename, case-insensitive (Prisma contains +
//    mode insensitive = SQL ILIKE, S4). Trimmed; empty → treated as absent.
//  - from/to: ISO date, range on createdAt (S2, upload time). Invalid date is a
//    400 (Zod); from > to is a 400 (checked in the route, needs both parsed).
//  - folderId: a UUID (restrict to that folder, 404 if not owned) OR the literal
//    "unfiled" (folderId = null photos) — S3.
//  - category: a known-category enum, matched against the caller's folder name
//    (S1). Unknown value → 400.
//  - limit/offset: same shape as folderPhotosQuerySchema; limit > 100 → 400
//    (the house rule, not a clamp).
export const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  folderId: z
    .union([z.string().uuid("folderId must be a UUID"), z.literal(UNFILED_FOLDER_LITERAL)])
    .optional(),
  category: z.enum(SEARCH_CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

// --- specs/guest-access-otp.md §5 ---

export const PERMISSION_LEVELS = ["view", "download", "download_all"] as const;

// POST /api/guests — owner creates a share (folder-scoped, decision G3).
export const createGuestSchema = z.object({
  guestEmail: z.string().trim().toLowerCase().email("Invalid email format"),
  guestName: z.string().trim().min(1).max(255).optional(),
  folderIds: z.array(z.string().uuid("folderId must be a UUID")).min(1, "At least one folder is required"),
  permissionLevel: z.enum(PERMISSION_LEVELS),
  // Optional grant expiry in days; capped at a year to keep the value sane.
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});

// GET /api/access-requests — optional status filter (default 'pending').
export const accessRequestsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "denied", "expired", "all"]).default("pending"),
});

// POST /api/access-requests/:id/approve — owner submits the OTP.
export const approveAccessRequestSchema = z.object({
  otp: z.string().trim().regex(/^\d{6}$/, "OTP must be a 6-digit code"),
});

export type CreateGuestInput = z.infer<typeof createGuestSchema>;
export type AccessRequestsQuery = z.infer<typeof accessRequestsQuerySchema>;
export type ApproveAccessRequestInput = z.infer<typeof approveAccessRequestSchema>;

// --- specs/audit-and-polish.md §A4 ---

// The enumerated audit actions (specs/audit-and-polish.md §A2). Keep in sync
// with AuditAction in lib/audit.ts. Note: this list pre-existed WITHOUT
// folder_merged/folder_deleted/folder_downloaded (a pre-existing gap, not
// introduced by this pass) — the trash-system actions below are added for
// GET /api/audit's ?action= filter since "I recovered/purged something" is
// exactly the kind of thing an owner would want to filter their trail by.
export const AUDIT_ACTIONS = [
  "share_created",
  "access_requested",
  "access_approved",
  "access_denied",
  "guest_revoked",
  "photo_viewed",
  "photo_downloaded",
  "photo_deleted",
  "photo_restored",
  "folder_restored",
  "photo_permanently_deleted",
  "folder_permanently_deleted",
  "trash_emptied",
] as const;

// GET /api/audit — owner-scoped, paginated, filterable (specs/audit-and-polish
// .md §A4, AP6). Same pattern as accessRequestsQuerySchema/folderPhotosQuery.
// `from`/`to` accept an ISO date/datetime; an invalid value is a 400 (Zod),
// never silently ignored. All filters optional; `limit`/`offset` bounded.
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorType: z.enum(["owner", "guest"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;
