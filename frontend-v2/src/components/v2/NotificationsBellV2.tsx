"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useNotifications } from "@/components/v2/useNotifications";
import { actorLabel, detailLine, timeAgo } from "@/lib/v2/auditFormat";

// Real data (auditApi.list(), the same feed as /v2/activity) rendered as a
// bell dropdown per the prototype - only read/dismiss state is client-only,
// since there's no backend endpoint for it (see useNotifications.ts).
export function NotificationsBellV2() {
  const { entries, unreadCount, markSeen, clearAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) markSeen();
      return next;
    });
  }

  return (
    <div className="ps2-bell-wrap" ref={wrapRef}>
      <button type="button" className="ps2-bell-btn" title="Notifications" onClick={toggle}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
        </svg>
        {unreadCount > 0 && <span className="ps2-bell-dot" />}
      </button>

      {open && (
        <div className="ps2-bell-dropdown">
          {entries.length === 0 ? (
            <div className="ps2-bell-empty">You&apos;re all caught up.</div>
          ) : (
            <>
              {entries.map((entry) => (
                <div key={entry.id} className="ps2-bell-item">
                  <div className="ps2-bell-item-text">
                    {actorLabel(entry)} · {detailLine(entry) || "activity"}
                  </div>
                  <div className="ps2-bell-item-when">{timeAgo(entry.createdAt)}</div>
                </div>
              ))}
              <div className="ps2-bell-divider" />
              <div style={{ display: "flex", gap: 6 }}>
                <Link href="/v2/activity" className="ps2-bell-action" onClick={() => setOpen(false)}>
                  View all activity
                </Link>
                <button type="button" className="ps2-bell-action muted" onClick={clearAll}>
                  Clear all
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
