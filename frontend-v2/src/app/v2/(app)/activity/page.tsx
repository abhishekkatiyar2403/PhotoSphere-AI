"use client";

// v2 Activity - synced to PhotoSphere.dc.html (Activity screen, lines
// 1037-1094): serif title + "Everything that happened in your sphere,
// newest first.", a panel filter bar (Action select, All/Owner/Guest
// segmented actor toggle, From/To dates, Apply + conditional Clear), and a
// timeline feed - vertical accent gradient line, colored dot + glyph tile
// per row, "<bold actor> text" + relative time.
//
// Data stays the real audit feed (GET /api/audit via auditApi) with the
// same draft-vs-applied filter split - Apply explicitly triggers the
// refetch. The design has no pagination, so this fetches one large page
// instead of the old Previous/Next pager.

import { useCallback, useEffect, useState } from "react";
import { ApiError, AuditAction, AuditActorType, auditApi, AuditEntry } from "@/lib/api";
import { SkeletonRows } from "@/components/v2/SkeletonGrid";
import { ACTION_FILTER_OPTIONS, ACTION_META, actorLabel, detailLine, timeAgo } from "@/lib/v2/auditFormat";

const FETCH_LIMIT = 100;

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// Design row visuals (glyph in a tinted 38px tile + matching timeline dot).
// The prototype's mock feed uses green #8fd0b8 / purple #b06bc0 / amber
// #e8a15c / red #e87f8f dots - real audit actions map onto the same palette.
// Purple (not the primary accent) marks the "guest/view" category so it
// stays visually distinct from accent-colored active/highlighted UI.
const ROW_VISUALS: Record<AuditAction, { glyph: string; dot: string }> = {
  share_created: { glyph: "⤴", dot: "#e8a15c" },
  access_requested: { glyph: "✦", dot: "#b06bc0" },
  access_approved: { glyph: "◈", dot: "#8fd0b8" },
  access_denied: { glyph: "✕", dot: "#e87f8f" },
  guest_revoked: { glyph: "✕", dot: "#e87f8f" },
  photo_viewed: { glyph: "◉", dot: "#b06bc0" },
  photo_downloaded: { glyph: "↓", dot: "#8fd0b8" },
};

function rowText(entry: AuditEntry): string {
  // Actions outside ACTION_META (e.g. photo_permanently_deleted) fall back
  // to the raw code — humanize it so the feed reads as sentences.
  const label = ACTION_META[entry.action]?.label ?? entry.action.replace(/_/g, " ");
  const lc = label.charAt(0).toLowerCase() + label.slice(1);
  const detail = detailLine(entry);
  if (entry.action === "access_requested") {
    // detailLine already reads "<email> requested access…" - the email is the
    // bold actor, so drop the duplicate prefix.
    const actor = actorLabel(entry);
    const rest = detail.startsWith(actor) ? detail.slice(actor.length).trim() : detail;
    return rest || lc;
  }
  return detail ? `${lc} — ${detail}` : lc;
}

const fieldStyle: React.CSSProperties = {
  background: "var(--ps2-panel2)",
  border: "1px solid var(--ps2-border)",
  borderRadius: 10,
  padding: "9px 12px",
  fontSize: 13,
  fontFamily: "inherit",
  color: "var(--ps2-text)",
};

const upLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ps2-muted)",
  letterSpacing: ".08em",
  textTransform: "uppercase",
};

type Filters = { action: AuditAction | ""; actor: AuditActorType | ""; from: string; to: string };
const DEFAULT_FILTERS: Filters = { action: "", actor: "", from: "", to: "" };

export default function ActivityV2Page() {
  const [draftAction, setDraftAction] = useState<AuditAction | "">("");
  const [draftActor, setDraftActor] = useState<AuditActorType | "">("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");

  const [applied, setApplied] = useState<Filters>(DEFAULT_FILTERS);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await auditApi.list({
          limit: FETCH_LIMIT,
          offset: 0,
          action: applied.action || undefined,
          actorType: applied.actor || undefined,
          from: applied.from ? `${applied.from}T00:00:00.000Z` : undefined,
          to: applied.to ? `${applied.to}T23:59:59.999Z` : undefined,
        });
        if (cancelled) return;
        setEntries(res.entries);
      } catch (err) {
        if (cancelled || isAuthError(err)) return;
        setError(err instanceof Error ? err.message : "Failed to load activity");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applied]);

  const applyFilters = useCallback(() => {
    setApplied({ action: draftAction, actor: draftActor, from: draftFrom, to: draftTo });
  }, [draftAction, draftActor, draftFrom, draftTo]);

  const filtersActive = applied.action !== "" || applied.actor !== "" || applied.from !== "" || applied.to !== "";

  function clearFilters() {
    setDraftAction("");
    setDraftActor("");
    setDraftFrom("");
    setDraftTo("");
    setApplied(DEFAULT_FILTERS);
  }

  return (
    <main style={{ padding: "38px 32px 60px", maxWidth: 860, width: "100%", margin: "0 auto", position: "relative", zIndex: 1 }}>
      <style>{`
        .agx-row:hover{border-color:var(--ps2-accent)}
        .agx-clear:hover{color:var(--ps2-text)}
        .agx-date{color-scheme:dark}
        .ps2[data-theme="light"] .agx-date{color-scheme:light}
      `}</style>

      <h1 style={{ fontFamily: "var(--ps2-font-serif)", fontWeight: 400, fontSize: 36, margin: 0, animation: "ps2Up .6s both" }}>Activity</h1>
      <div style={{ fontSize: 14, color: "var(--ps2-muted)", margin: "8px 0 22px", animation: "ps2Up .6s both .05s" }}>
        Everything that happened in your sphere, newest first.
      </div>

      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginBottom: 30,
          padding: 18,
          borderRadius: 16,
          background: "var(--ps2-panel)",
          border: "1px solid var(--ps2-border)",
          animation: "ps2Up .6s both .1s",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={upLabelStyle}>Action</label>
          <select value={draftAction} onChange={(e) => setDraftAction(e.target.value as AuditAction | "")} style={{ ...fieldStyle, cursor: "pointer", minWidth: 150 }}>
            <option value="">All actions</option>
            {ACTION_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={upLabelStyle}>Actor</label>
          <div style={{ display: "flex", borderRadius: 10, background: "var(--ps2-panel2)", border: "1px solid var(--ps2-border)", overflow: "hidden" }}>
            {([
              { value: "", label: "All" },
              { value: "owner", label: "Owner" },
              { value: "guest", label: "Guest" },
            ] as const).map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setDraftActor(opt.value)}
                style={{
                  padding: "9px 16px",
                  fontSize: 13,
                  fontFamily: "inherit",
                  border: "none",
                  cursor: "pointer",
                  background: draftActor === opt.value ? "var(--ps2-accent)" : "transparent",
                  color: draftActor === opt.value ? "#141118" : "var(--ps2-muted)",
                  transition: "background .2s",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 130 }}>
          <label style={upLabelStyle}>From</label>
          <input type="date" className="agx-date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} style={{ ...fieldStyle, width: "100%", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 130 }}>
          <label style={upLabelStyle}>To</label>
          <input type="date" className="agx-date" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} style={{ ...fieldStyle, width: "100%", boxSizing: "border-box" }} />
        </div>
        <button
          type="button"
          onClick={applyFilters}
          style={{ borderRadius: 10, border: "none", background: "var(--ps2-accent)", color: "#141118", padding: "10px 20px", fontSize: 13.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", height: 38 }}
        >
          Apply
        </button>
        {filtersActive && (
          <button
            type="button"
            className="agx-clear"
            onClick={clearFilters}
            style={{ borderRadius: 10, border: "1px solid var(--ps2-border)", background: "transparent", color: "var(--ps2-muted)", padding: "10px 16px", fontSize: 13, fontFamily: "inherit", cursor: "pointer", height: 38, transition: "color .2s" }}
          >
            Clear
          </button>
        )}
      </div>

      {loading && <SkeletonRows count={8} />}
      {error && !loading && <div style={{ fontSize: 13.5, color: "#e87f8f" }}>{error}</div>}

      {!loading && !error && entries.length === 0 && (
        <div style={{ borderRadius: 20, border: "1.5px dashed var(--ps2-border)", padding: "50px 30px", textAlign: "center", color: "var(--ps2-muted)" }}>
          <div style={{ fontFamily: "var(--ps2-font-serif)", fontStyle: "italic", fontSize: 22, color: "var(--ps2-text)", marginBottom: 6 }}>No matching activity.</div>
          <div style={{ fontSize: 13.5 }}>Try widening your filters.</div>
        </div>
      )}

      {!loading && !error && entries.length > 0 && (
        <div style={{ position: "relative", paddingLeft: 26 }}>
          <div style={{ position: "absolute", left: 7, top: 8, bottom: 8, width: 2, background: "linear-gradient(180deg, var(--ps2-accent), var(--ps2-border))" }} />
          {entries.map((entry) => {
            const visuals = ROW_VISUALS[entry.action] ?? { glyph: "◉", dot: "#b06bc0" };
            const actor = actorLabel(entry);
            const actorDisplay = actor === "you" ? "You" : actor;
            return (
              <div
                key={entry.id}
                className="agx-row"
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  padding: "14px 16px",
                  marginBottom: 12,
                  borderRadius: 14,
                  background: "var(--ps2-panel)",
                  border: "1px solid var(--ps2-border)",
                  animation: "ps2Up .5s both",
                  transition: "border-color .25s",
                }}
              >
                <div style={{ position: "absolute", left: -25, width: 12, height: 12, borderRadius: "50%", background: visuals.dot, border: "2px solid var(--ps2-bg)" }} />
                <div
                  style={{
                    width: 38,
                    height: 38,
                    flex: "none",
                    borderRadius: 11,
                    display: "grid",
                    placeItems: "center",
                    background: `color-mix(in oklab, ${visuals.dot} 15%, transparent)`,
                    color: visuals.dot,
                    fontSize: 16,
                  }}
                >
                  {visuals.glyph}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14 }}>
                    <span style={{ fontWeight: 600 }}>{actorDisplay}</span> {rowText(entry)}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 2 }}>{timeAgo(entry.createdAt)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
