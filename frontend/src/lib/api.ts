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

export const photosApi = {
  upload: uploadFile,
  status: (photoId: string) => apiFetch(`/api/photos/${photoId}/status`, { method: "GET" }),
  get: (photoId: string) => apiFetch(`/api/photos/${photoId}`, { method: "GET" }),
};
