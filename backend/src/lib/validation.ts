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
