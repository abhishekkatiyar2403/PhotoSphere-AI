const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
    throw new ApiError(body?.error ?? "Request failed", res.status);
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

export const photosApi = {
  upload: uploadFile,
  uploadWithProgress: uploadFileWithProgress,
  status: (photoId: string) => apiFetch(`/api/photos/${photoId}/status`, { method: "GET" }),
  get: (photoId: string) => apiFetch(`/api/photos/${photoId}`, { method: "GET" }),
  move: (photoId: string, folderId: string) =>
    apiFetch(`/api/photos/${photoId}`, { method: "PATCH", body: JSON.stringify({ folderId }) }),
  reclassify: (photoId: string) =>
    apiFetch(`/api/photos/${photoId}/reclassify`, { method: "POST" }),
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

export const foldersApi = {
  list: (collectionId: string): Promise<{ folders: Folder[] }> =>
    apiFetch(`/api/collections/${collectionId}/folders`, { method: "GET" }),
  create: (collectionId: string, name: string): Promise<Folder> =>
    apiFetch(`/api/collections/${collectionId}/folders`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
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

// GET /api/collections/:id/unfiled-photos (backend addition - see
// routes/collections.ts for the gap this closes: failed/duplicate photos
// have folderId: null and are otherwise invisible to any folder listing).
export const unfiledPhotosApi = {
  list: (collectionId: string, params: { limit: number; offset: number }): Promise<FolderPhotosResponse> =>
    apiFetch(
      `/api/collections/${collectionId}/unfiled-photos?limit=${params.limit}&offset=${params.offset}`,
      { method: "GET" },
    ),
};
