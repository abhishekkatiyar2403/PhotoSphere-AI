// Small typed localStorage helpers shared by the features that fall back to
// local-only persistence while their backend endpoint doesn't exist yet
// (see featureFlags.ts) - Favorites, Comments, and photo rename.

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, quota) - the feature just won't
    // persist across reloads this session, nothing to surface to the user.
  }
}
