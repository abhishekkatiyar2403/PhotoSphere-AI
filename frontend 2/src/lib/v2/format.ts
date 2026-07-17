// Shared display formatting for the v2 (PhotoSphere redesign) screens.
// Same rules as the classic dashboard page's local helpers, factored out
// because both the app shell (storage widget) and the v2 pages need them.

export function formatBytes(raw: string | number): string {
  const bytes = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  const formatted = exponent === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${units[exponent]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function plural(n: number, noun: string): string {
  return `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;
}
