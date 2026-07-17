"use client";

// Activity page (specs/audit-and-polish.md §A4 / P7,
// design/wireframes/audit-viewer.svg - Option A: a dedicated /activity page
// with its own top-bar entry). A full filter bar (action dropdown / owner-vs-
// guest actor toggle / from-to date range + Apply) over a paginated,
// newest-first feed of the owner's audit trail (GET /api/audit). Each row: a
// colored left edge by action, the human action label, an OWNER/GUEST badge,
// the actor ("you" for owner rows, the guest email for guest rows), a
// metadata second line resolved from what the choke point captured at write
// time (folder names, permission level, deny reason, IP), and a relative
// timestamp.
//
// Owner-only, authed - same client-side gate pattern as
// /dashboard/organize/guests (authApi.me() on mount -> /login on 401). Filter
// state is local component state (not URL params) - no useSearchParams here,
// so no Suspense boundary is needed.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ApiError,
  AuditAction,
  AuditActorType,
  auditApi,
  AuditEntry,
  authApi,
} from "@/lib/api";
import UiV2Banner from "@/components/UiV2Banner";

const PAGE_SIZE = 25;

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// ---- Action presentation: human label + which color family the left edge /
// icon swatch use, per the wireframe palette. approve/download = green,
// view/share/created/requested = blue, denied = red. ----
type ActionTone = "green" | "blue" | "red";

const ACTION_META: Record<AuditAction, { label: string; tone: ActionTone }> = {
  photo_downloaded: { label: "Downloaded a photo", tone: "green" },
  photo_viewed: { label: "Viewed a photo", tone: "blue" },
  access_approved: { label: "Approved access", tone: "green" },
  access_denied: { label: "Denied access", tone: "red" },
  share_created: { label: "Created a share", tone: "blue" },
  access_requested: { label: "Requested access", tone: "blue" },
  guest_revoked: { label: "Revoked guest", tone: "red" },
};

// The action-filter dropdown options ("All actions" + the 7, human-labeled).
const ACTION_FILTER_OPTIONS: { value: AuditAction; label: string }[] = [
  { value: "share_created", label: "Created a share" },
  { value: "access_requested", label: "Requested access" },
  { value: "access_approved", label: "Approved access" },
  { value: "access_denied", label: "Denied access" },
  { value: "guest_revoked", label: "Revoked guest" },
  { value: "photo_viewed", label: "Viewed a photo" },
  { value: "photo_downloaded", label: "Downloaded a photo" },
];

// Human labels for the access_denied reason captured in metadata.reason.
const DENY_REASON_LABEL: Record<string, string> = {
  owner_denied: "you denied it",
  otp_attempts_exceeded: "too many wrong codes",
  otp_expired: "the code expired",
};

function timeAgo(iso: string): string {
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

// Read a string metadata key defensively (metadata is loose JSON).
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

// The actor label: "you" for owner rows, the resolved guest email for guest
// rows (backend prefers metadata.guestEmail, falls back to a lookup), else the
// actor id as a last resort.
function actorLabel(entry: AuditEntry): string {
  if (entry.actorType === "owner") return "you";
  return entry.actor.email ?? metaStr(entry.metadata as Record<string, unknown> | null, "guestEmail") ?? entry.actor.id;
}

// The metadata second line for a row, resolved from what the choke point
// captured at write time, with graceful id fallbacks (append-only history can
// outlive the resource it names).
function detailLine(entry: AuditEntry): string {
  const md = entry.metadata as Record<string, unknown> | null;
  const ip = entry.ipAddress ? ` · IP ${entry.ipAddress}` : "";

  switch (entry.action) {
    case "photo_downloaded":
    case "photo_viewed": {
      // Prefer the folder name (captured at write time on newer rows); fall
      // back to the id for older rows written before folderName was captured
      // (append-only history can outlive the resource it names).
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
      const reasonLabel = reasonKey ? DENY_REASON_LABEL[reasonKey] ?? reasonKey : undefined;
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

export default function ActivityPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  // Applied filters (drive the fetch) vs. draft filters (edit in the bar until
  // Apply is clicked). Keeping them separate means typing a date doesn't
  // refetch until Apply, matching the wireframe's explicit Apply button.
  const [draftAction, setDraftAction] = useState<AuditAction | "">("");
  const [draftActor, setDraftActor] = useState<AuditActorType | "">("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");

  const [action, setAction] = useState<AuditAction | "">("");
  const [actor, setActor] = useState<AuditActorType | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- Auth gate (same pattern as /dashboard, /organize, /guests) ----
  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  // ---- Feed fetch, re-run whenever the APPLIED filters or offset change.
  // Guarded with a `cancelled` flag so a slow response can't clobber a newer
  // one (same stale-response guard as /dashboard, /organize). ----
  useEffect(() => {
    if (checking || !user) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await auditApi.list({
          limit: PAGE_SIZE,
          offset,
          action: action || undefined,
          actorType: actor || undefined,
          // Bound the range to the whole day for the "to" date (inclusive).
          from: from ? `${from}T00:00:00.000Z` : undefined,
          to: to ? `${to}T23:59:59.999Z` : undefined,
        });
        if (cancelled) return;
        setEntries(res.entries);
        setTotal(res.total);
      } catch (err) {
        if (cancelled) return;
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load activity");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checking, user, action, actor, from, to, offset, router]);

  const applyFilters = useCallback(() => {
    setAction(draftAction);
    setActor(draftActor);
    setFrom(draftFrom);
    setTo(draftTo);
    setOffset(0); // any filter change resets to the first page
  }, [draftAction, draftActor, draftFrom, draftTo]);

  async function handleLogout() {
    await authApi.logout();
    router.replace("/login");
  }

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_SIZE, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <main className="activity-page">
      <div className="organize-topbar">
        <h1>
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="activity-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Activity
        </h1>
        <div className="dashboard-topbar-right">
          <UiV2Banner href="/activity/v2" />
          <Link href="/upload" className="dashboard-guests-link" data-testid="activity-upload-link">
            Upload
          </Link>
          <Link href="/organize" className="dashboard-guests-link" data-testid="activity-organize-link">
            Organize
          </Link>
          <Link href="/browse" className="dashboard-guests-link" data-testid="activity-browse-link">
            Browse
          </Link>
          <Link href="/search" className="dashboard-guests-link" data-testid="activity-search-link">
            Search
          </Link>
          <Link href="/guests" className="dashboard-guests-link" data-testid="activity-guests-link">
            Guests
          </Link>
          <Link
            href="/activity"
            className="dashboard-guests-link activity-nav-active"
            aria-current="page"
            data-testid="activity-activity-link"
          >
            Activity
          </Link>
          <Link href="/trash" className="dashboard-guests-link" data-testid="activity-trash-link">
            Trash
          </Link>
          <Link href="/settings" className="dashboard-guests-link" data-testid="activity-settings-link">
            Settings
          </Link>
          <span>{user.name}</span>
          <button type="button" className="dashboard-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>

      <div className="activity-content">
        <div className="activity-head">
          <h2>Activity log</h2>
          <span className="activity-head-sub">who did what to your photos, newest first</span>
        </div>

        {/* Filter bar */}
        <form
          className="activity-filters"
          data-testid="activity-filters"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <label className="activity-filter-field">
            <span className="activity-filter-label">ACTION</span>
            <select
              className="activity-select"
              data-testid="activity-filter-action"
              value={draftAction}
              onChange={(e) => setDraftAction(e.target.value as AuditAction | "")}
            >
              <option value="">All actions</option>
              {ACTION_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <div className="activity-filter-field">
            <span className="activity-filter-label">ACTOR</span>
            <div className="activity-actor-toggle" role="group" aria-label="Filter by actor">
              {([
                { value: "", label: "All" },
                { value: "owner", label: "Owner" },
                { value: "guest", label: "Guest" },
              ] as const).map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  data-testid={`activity-actor-${opt.value || "all"}`}
                  className={`activity-actor-pill${draftActor === opt.value ? " activity-actor-pill-active" : ""}`}
                  aria-pressed={draftActor === opt.value}
                  onClick={() => setDraftActor(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <label className="activity-filter-field">
            <span className="activity-filter-label">FROM</span>
            <input
              type="date"
              className="activity-date"
              data-testid="activity-filter-from"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(e) => setDraftFrom(e.target.value)}
            />
          </label>

          <label className="activity-filter-field">
            <span className="activity-filter-label">TO</span>
            <input
              type="date"
              className="activity-date"
              data-testid="activity-filter-to"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(e) => setDraftTo(e.target.value)}
            />
          </label>

          <button type="submit" className="activity-apply" data-testid="activity-apply">
            Apply
          </button>
        </form>

        {/* Feed */}
        {loading && <p className="organize-empty" data-testid="activity-loading">Loading activity…</p>}

        {error && !loading && (
          <p className="share-error" data-testid="activity-error">
            {error}
          </p>
        )}

        {!loading && !error && entries.length === 0 && (
          <p className="organize-empty" data-testid="activity-empty">
            No activity yet — activity appears here once you share folders and guests start viewing/downloading.
          </p>
        )}

        {!loading && !error && entries.length > 0 && (
          <>
            <ul className="activity-feed" data-testid="activity-feed">
              {entries.map((entry) => {
                const meta = ACTION_META[entry.action] ?? { label: entry.action, tone: "blue" as ActionTone };
                return (
                  <li
                    key={entry.id}
                    className={`activity-row activity-row-${meta.tone}`}
                    data-testid={`activity-row-${entry.action}`}
                  >
                    <span className={`activity-row-edge activity-edge-${meta.tone}`} aria-hidden="true" />
                    <span className={`activity-row-icon activity-icon-${meta.tone}`} aria-hidden="true" />
                    <div className="activity-row-main">
                      <div className="activity-row-topline">
                        <span className="activity-row-label">{meta.label}</span>
                        <span
                          className={`activity-badge activity-badge-${entry.actorType}`}
                          data-testid={`activity-badge-${entry.actorType}`}
                        >
                          {entry.actorType === "owner" ? "OWNER" : "GUEST"}
                        </span>
                        <span className="activity-row-actor">{actorLabel(entry)}</span>
                      </div>
                      <div className="activity-row-detail">{detailLine(entry)}</div>
                    </div>
                    <time className="activity-row-time" dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>
                      {timeAgo(entry.createdAt)}
                    </time>
                  </li>
                );
              })}
            </ul>

            <div className="activity-pagination">
              <span className="activity-showing" data-testid="activity-showing">
                Showing {showingFrom}–{showingTo} of {total}
              </span>
              <div className="activity-page-buttons">
                <button
                  type="button"
                  className="activity-page-btn"
                  data-testid="activity-prev"
                  disabled={!hasPrev}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="activity-page-btn"
                  data-testid="activity-next"
                  disabled={!hasNext}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
