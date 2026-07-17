"use client";

// Activity v2 — redesign handoff (README.md "Activity", PhotoSphere.dc.html
// Activity screen): a vertical timeline (gradient spine, per-event dot +
// glyph chip color-coded by action, actor+text line, relative timestamp).
// Same data + all the presentation helpers as the classic /activity page
// (auditApi.list, ACTION_META tones, detailLine/actorLabel, draft/applied
// filter split, stale-response guard, pagination). Only the row layout is
// restyled into the timeline; the legend colors match the README (accent/AI =
// blue here per the v2 accent, green = user create, blue = guest view, red =
// delete/deny).

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, AuditAction, AuditActorType, auditApi, AuditEntry, authApi } from "@/lib/api";
import Ps2Shell from "@/components/ps2/Shell";

const PAGE_SIZE = 25;

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

type ActionTone = "green" | "blue" | "red";

const ACTION_META: Record<AuditAction, { label: string; tone: ActionTone; glyph: string }> = {
  photo_downloaded: { label: "Downloaded a photo", tone: "green", glyph: "↓" },
  photo_viewed: { label: "Viewed a photo", tone: "blue", glyph: "◉" },
  access_approved: { label: "Approved access", tone: "green", glyph: "✓" },
  access_denied: { label: "Denied access", tone: "red", glyph: "✕" },
  share_created: { label: "Created a share", tone: "blue", glyph: "↗" },
  access_requested: { label: "Requested access", tone: "blue", glyph: "◔" },
  guest_revoked: { label: "Revoked guest", tone: "red", glyph: "⊘" },
};

const ACTION_FILTER_OPTIONS: { value: AuditAction; label: string }[] = [
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

function actorLabel(entry: AuditEntry): string {
  if (entry.actorType === "owner") return "You";
  return entry.actor.email ?? metaStr(entry.metadata as Record<string, unknown> | null, "guestEmail") ?? entry.actor.id;
}

function detailLine(entry: AuditEntry): string {
  const md = entry.metadata as Record<string, unknown> | null;
  const ip = entry.ipAddress ? ` · IP ${entry.ipAddress}` : "";
  switch (entry.action) {
    case "photo_downloaded":
    case "photo_viewed": {
      const folderName = metaStr(md, "folderName");
      const folderId = metaStr(md, "folderId");
      const folderLabel = folderName ?? (folderId ? `folder ${folderId}` : null);
      return `photo${folderLabel ? ` in ${folderLabel}` : ""}${ip}`;
    }
    case "access_approved": {
      const email = metaStr(md, "guestEmail") ?? entry.actor.email;
      return email ? `for ${email}${ip}` : `access request${ip}`;
    }
    case "access_denied": {
      const email = metaStr(md, "guestEmail") ?? entry.actor.email;
      const reasonKey = metaStr(md, "reason");
      const reasonLabel = reasonKey ? DENY_REASON_LABEL[reasonKey] ?? reasonKey : undefined;
      const reason = reasonKey ? ` · ${reasonLabel}` : "";
      return `${email ? `for ${email}` : "access request"}${reason}${ip}`;
    }
    case "share_created": {
      const email = metaStr(md, "guestEmail");
      const folderNames = metaStrArray(md, "folderNames") ?? metaStrArray(md, "folderIds");
      const perm = metaStr(md, "permissionLevel");
      const folders = folderNames && folderNames.length > 0 ? folderNames.join(", ") : "folders";
      return `shared ${folders}${email ? ` with ${email}` : ""}${perm ? ` · ${perm}` : ""}`;
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

export default function ActivityV2Page() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

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

  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

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
    setOffset(0);
  }, [draftAction, draftActor, draftFrom, draftTo]);

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_SIZE, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <Ps2Shell active="activity" userName={user.name} classicHref="/activity">
      <main className="ps2-activity" data-testid="activity-v2">
        <h1 className="ps2-h1-page ps2-anim-up">Activity</h1>
        <div className="ps2-share-sub">Everything that happened in your sphere, newest first.</div>

        <form
          className="ps2-activity-filters"
          data-testid="activity-filters"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <label className="ps2-field">
            <span className="ps2-field-label">Action</span>
            <select className="ps2-select" value={draftAction} onChange={(e) => setDraftAction(e.target.value as AuditAction | "")} data-testid="activity-filter-action">
              <option value="">All actions</option>
              {ACTION_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <div className="ps2-field">
            <span className="ps2-field-label">Actor</span>
            <div className="ps2-actor-toggle" role="group" aria-label="Filter by actor">
              {([
                { value: "", label: "All" },
                { value: "owner", label: "Owner" },
                { value: "guest", label: "Guest" },
              ] as const).map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`ps2-actor-pill${draftActor === opt.value ? " ps2-actor-active" : ""}`}
                  aria-pressed={draftActor === opt.value}
                  onClick={() => setDraftActor(opt.value)}
                  data-testid={`activity-actor-${opt.value || "all"}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <label className="ps2-field">
            <span className="ps2-field-label">From</span>
            <input type="date" className="ps2-input" value={draftFrom} max={draftTo || undefined} onChange={(e) => setDraftFrom(e.target.value)} data-testid="activity-filter-from" />
          </label>
          <label className="ps2-field">
            <span className="ps2-field-label">To</span>
            <input type="date" className="ps2-input" value={draftTo} min={draftFrom || undefined} onChange={(e) => setDraftTo(e.target.value)} data-testid="activity-filter-to" />
          </label>
          <button type="submit" className="ps2-btn-accent" data-testid="activity-apply">Apply</button>
        </form>

        {loading && <div className="ps2-loading" data-testid="activity-loading"><span className="ps2-spinner" aria-hidden="true" />Loading activity…</div>}
        {error && !loading && <p className="ps2-error" data-testid="activity-error">{error}</p>}

        {!loading && !error && entries.length === 0 && (
          <div className="ps2-empty" data-testid="activity-empty">
            <div className="ps2-empty-title">No activity yet.</div>
            <div>Activity appears here once you share folders and guests start viewing or downloading.</div>
          </div>
        )}

        {!loading && !error && entries.length > 0 && (
          <>
            <div className="ps2-timeline" data-testid="activity-feed">
              <div className="ps2-timeline-spine" aria-hidden="true" />
              {entries.map((entry) => {
                const meta = ACTION_META[entry.action] ?? { label: entry.action, tone: "blue" as ActionTone, glyph: "•" };
                return (
                  <div key={entry.id} className="ps2-event" data-testid={`activity-row-${entry.action}`}>
                    <span className={`ps2-event-dot ps2-tone-${meta.tone} ps2-bg`} aria-hidden="true" style={{ background: `var(--ps2-accent)` }} />
                    <span className={`ps2-event-glyph ps2-tone-${meta.tone} ps2-bg`} aria-hidden="true">{meta.glyph}</span>
                    <div className="ps2-event-main">
                      <div className="ps2-event-text">
                        <span className="ps2-event-actor">{actorLabel(entry)}</span> {meta.label.toLowerCase()}
                        <span className="ps2-event-badge">{entry.actorType}</span>
                      </div>
                      <div className="ps2-event-when">{detailLine(entry)}{detailLine(entry) ? " · " : ""}{timeAgo(entry.createdAt)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="ps2-pagination">
              <button type="button" className="ps2-page-btn" disabled={!hasPrev} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))} data-testid="activity-prev">‹ Prev</button>
              <button type="button" className="ps2-page-btn" disabled={!hasNext} onClick={() => setOffset((o) => o + PAGE_SIZE)} data-testid="activity-next">Next ›</button>
              <span className="ps2-page-range" data-testid="activity-showing">Showing {showingFrom}–{showingTo} of {total}</span>
            </div>
          </>
        )}
      </main>
    </Ps2Shell>
  );
}
