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
// with AuditAction in lib/audit.ts.
export const AUDIT_ACTIONS = [
  "share_created",
  "access_requested",
  "access_approved",
  "access_denied",
  "guest_revoked",
  "photo_viewed",
  "photo_downloaded",
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
