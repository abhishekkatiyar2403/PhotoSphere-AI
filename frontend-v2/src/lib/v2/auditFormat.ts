// Shared audit-entry formatting - originally lived only in the Activity
// page; extracted so the Notifications bell can render the exact same
// copy/tone for the exact same real auditApi.list() data.
import type { AuditAction, AuditEntry } from "@/lib/api";

export type ActionTone = "green" | "blue" | "red";

export const ACTION_META: Record<AuditAction, { label: string; tone: ActionTone }> = {
  photo_downloaded: { label: "Downloaded a photo", tone: "green" },
  photo_viewed: { label: "Viewed a photo", tone: "blue" },
  access_approved: { label: "Approved access", tone: "green" },
  access_denied: { label: "Denied access", tone: "red" },
  share_created: { label: "Created a share", tone: "blue" },
  access_requested: { label: "Requested access", tone: "blue" },
  guest_revoked: { label: "Revoked guest", tone: "red" },
};

export const ACTION_FILTER_OPTIONS: { value: AuditAction; label: string }[] = [
  { value: "share_created", label: "Created a share" },
  { value: "access_requested", label: "Requested access" },
  { value: "access_approved", label: "Approved access" },
  { value: "access_denied", label: "Denied access" },
  { value: "guest_revoked", label: "Revoked guest" },
  { value: "photo_viewed", label: "Viewed a photo" },
  { value: "photo_downloaded", label: "Downloaded a photo" },
];

const DENY_REASON_LABEL: Record<string, string> = {
  owner_denied: "you denied it",
  otp_attempts_exceeded: "too many wrong codes",
  otp_expired: "the code expired",
};

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function metaStr(md: Record<string, unknown> | null, key: string): string | undefined {
  if (!md) return undefined;
  const v = md[key];
  return typeof v === "string" ? v : undefined;
}

function metaStrArray(md: Record<string, unknown> | null, key: string): string[] | undefined {
  if (!md) return undefined;
  const v = md[key];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}

export function actorLabel(entry: AuditEntry): string {
  if (entry.actorType === "owner") return "you";
  return entry.actor.email ?? metaStr(entry.metadata as Record<string, unknown> | null, "guestEmail") ?? entry.actor.id;
}

export function detailLine(entry: AuditEntry): string {
  const md = entry.metadata as Record<string, unknown> | null;
  const ip = entry.ipAddress ? ` · IP ${entry.ipAddress}` : "";

  switch (entry.action) {
    case "photo_downloaded":
    case "photo_viewed": {
      const folderName = metaStr(md, "folderName");
      const folderId = metaStr(md, "folderId");
      const folderLabel = folderName ?? (folderId ? `folder ${folderId}` : null);
      const where = folderLabel ? ` in ${folderLabel}` : "";
      return `photo${where}${ip}`;
    }
    case "access_approved": {
      const email = metaStr(md, "guestEmail") ?? entry.actor.email;
      return email ? `for ${email}${ip}` : `access request${ip}`;
    }
    case "access_denied": {
      const email = metaStr(md, "guestEmail") ?? entry.actor.email;
      const reasonKey = metaStr(md, "reason");
      const reasonLabel = reasonKey ? (DENY_REASON_LABEL[reasonKey] ?? reasonKey) : undefined;
      const reason = reasonKey ? ` · reason: ${reasonLabel} (${reasonKey})` : "";
      const who = email ? `for ${email}` : "access request";
      return `${who}${reason}${ip}`;
    }
    case "share_created": {
      const email = metaStr(md, "guestEmail");
      const folderNames = metaStrArray(md, "folderNames") ?? metaStrArray(md, "folderIds");
      const perm = metaStr(md, "permissionLevel");
      const folders = folderNames && folderNames.length > 0 ? folderNames.join(", ") : "folders";
      const withWho = email ? ` with ${email}` : "";
      const level = perm ? ` · ${perm}` : "";
      return `shared ${folders}${withWho}${level}`;
    }
    case "access_requested": {
      const email = metaStr(md, "guestEmail") ?? entry.actor.email;
      return email ? `${email} requested access${ip}` : `access requested${ip}`;
    }
    case "guest_revoked": {
      const email = metaStr(md, "guestEmail");
      return email ? `revoked ${email}${ip}` : `revoked a guest${ip}`;
    }
    default:
      return ip.trim() ? ip.replace(/^ · /, "") : "";
  }
}
