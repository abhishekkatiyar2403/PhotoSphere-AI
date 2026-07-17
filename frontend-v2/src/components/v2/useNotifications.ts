"use client";

import { useCallback, useEffect, useState } from "react";
import { auditApi, type AuditEntry } from "@/lib/api";
import { readLocal, writeLocal } from "@/lib/v2/localStore";

// Real data (auditApi.list(), the same feed Activity uses) - only the
// read/unread and "clear all" state is client-only, since there's no
// backend endpoint for notification read-state or deletion.
const LAST_SEEN_KEY = "ps2_notifications_last_seen";
const DISMISSED_KEY = "ps2_notifications_dismissed";
const BELL_LIMIT = 8;

export function useNotifications() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    setLastSeen(readLocal<string | null>(LAST_SEEN_KEY, null));
    setDismissed(readLocal<string[]>(DISMISSED_KEY, []));
    auditApi
      .list({ limit: BELL_LIMIT })
      .then((res) => setEntries(res.entries))
      .catch(() => {
        // Bell is decorative-on-failure - the Activity page surfaces real load errors.
      });
  }, []);

  const visible = entries.filter((e) => !dismissed.includes(e.id));
  const unread = visible.filter((e) => !lastSeen || e.createdAt > lastSeen).length;

  const markSeen = useCallback(() => {
    const now = new Date().toISOString();
    setLastSeen(now);
    writeLocal(LAST_SEEN_KEY, now);
  }, []);

  const clearAll = useCallback(() => {
    setDismissed((prev) => {
      const next = Array.from(new Set([...prev, ...entries.map((e) => e.id)]));
      writeLocal(DISMISSED_KEY, next);
      return next;
    });
  }, [entries]);

  return { entries: visible, unreadCount: unread, markSeen, clearAll };
}
