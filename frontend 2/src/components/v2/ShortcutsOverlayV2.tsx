"use client";

// `?`-triggered keyboard-shortcuts overlay, matching the prototype. Ignored
// while typing in a real input/textarea/contenteditable so a literal "?"
// character in a search box or folder name doesn't pop this open.

import { useEffect, useState } from "react";

const SHORTCUTS: [string, string][] = [
  ["Command palette", "⌘K"],
  ["Next / previous photo", "← →"],
  ["Close viewer or dialog", "Esc"],
  ["Toggle this panel", "?"],
];

export function ShortcutsOverlayV2() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;

  return (
    <div className="ps2-shortcuts-backdrop" onClick={() => setOpen(false)}>
      <div className="ps2-shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps2-shortcuts-title">Keyboard shortcuts</div>
        <div className="ps2-shortcuts-list">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label} className="ps2-shortcuts-row">
              <span>{label}</span>
              <span className="ps2-shortcuts-keys">{keys}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
