"use client";

// Dismissible opt-in to the v2 redesign, shown in each classic page's top
// bar next to its nav links. Dismissal persists in localStorage (one shared
// key across all pages — dismissing it anywhere hides it everywhere); the v2
// pages keep a "Classic UI" link back, so both UIs stay reachable either way.

import { useEffect, useState } from "react";
import Link from "next/link";

export default function UiV2Banner({ href }: { href: string }) {
  const [dismissed, setDismissed] = useState(true); // assume dismissed until localStorage is read (avoids SSR flash)

  useEffect(() => {
    setDismissed(localStorage.getItem("ps-ui-v2-banner-dismissed") === "1");
  }, []);

  if (dismissed) return null;
  return (
    <span className="ui-v2-banner" data-testid="ui-v2-banner">
      <Link href={href}>Try the new look ✨</Link>
      <button
        type="button"
        className="ui-v2-banner-dismiss"
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem("ps-ui-v2-banner-dismissed", "1");
          setDismissed(true);
        }}
      >
        ✕
      </button>
    </span>
  );
}
