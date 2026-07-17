"use client";

// Global ⌘K command palette, matching the PhotoSphere.dc.html prototype:
// a search-icon header with an "esc" chip, page destinations (hint "Go to
// page"), live photo matches from the real library (hint = photo place/
// label), accent-colored match highlighting, and a "No matches." empty
// state. Photo rows fall through to /v2/search since there is no global
// photo viewer outside the Browse/Search screens (local fallback).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { searchApi, type FolderPhoto } from "@/lib/api";
import { SearchIcon } from "./icons";

const DESTINATIONS = [
  { label: "Dashboard", href: "/v2/dashboard" },
  { label: "Browse", href: "/v2/browse" },
  { label: "Search", href: "/v2/search" },
  { label: "Upload", href: "/v2/upload" },
  { label: "Organize", href: "/v2/organize" },
  { label: "Share & guests", href: "/v2/share" },
  { label: "Activity", href: "/v2/activity" },
  { label: "Trash", href: "/v2/trash" },
];

function highlightMatch(label: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return label;
  const idx = label.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return label;
  return (
    <>
      {label.slice(0, idx)}
      <span className="ps2-palette-match">{label.slice(idx, idx + q.length)}</span>
      {label.slice(idx + q.length)}
    </>
  );
}

type PaletteResult = { key: string; label: string; hint: string; go: () => void };

export function CommandPaletteV2() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [photoMatches, setPhotoMatches] = useState<FolderPhoto[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setPhotoMatches([]);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Live photo matches from the real library (debounced). The prototype
  // searches its in-memory photo list; here the same rows come from
  // searchApi so results reflect the user's actual photos.
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setPhotoMatches([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchApi
        .search({ q, limit: 6 })
        .then((res) => {
          if (!cancelled) setPhotoMatches(res.photos.slice(0, 6));
        })
        .catch(() => {
          if (!cancelled) setPhotoMatches([]);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const results = useMemo<PaletteResult[]>(() => {
    const q = query.trim().toLowerCase();
    const navMatches = (q ? DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q)) : DESTINATIONS).map((d) => ({
      key: d.href,
      label: d.label,
      hint: "Go to page",
      go: () => router.push(d.href),
    }));
    const photoRows = q
      ? photoMatches.map((p) => ({
          key: `photo-${p.id}`,
          label: p.originalFilename,
          hint: p.aiLabels[0] ?? "Photo",
          go: () => router.push(`/v2/search?q=${encodeURIComponent(query.trim())}`),
        }))
      : [];
    return [...navMatches, ...photoRows];
  }, [query, photoMatches, router]);

  const clampedIndex = Math.min(activeIndex, Math.max(0, results.length - 1));

  function pick(r: PaletteResult) {
    setOpen(false);
    r.go();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[clampedIndex];
      if (item) pick(item);
    }
  }

  if (!open) return null;

  return (
    <div className="ps2-palette-backdrop" onClick={() => setOpen(false)}>
      <div className="ps2-palette" onClick={(e) => e.stopPropagation()}>
        <div className="ps2-palette-head">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            className="ps2-palette-input"
            placeholder="Jump to a page or search your photos…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <span className="ps2-palette-esc">esc</span>
        </div>
        <div className="ps2-palette-list">
          {results.map((r, i) => (
            <button key={r.key} type="button" className={`ps2-palette-item${i === clampedIndex ? " active" : ""}`} onClick={() => pick(r)}>
              <div style={{ minWidth: 0 }}>
                <div className="ps2-palette-item-label">{highlightMatch(r.label, query)}</div>
                <div className="ps2-palette-item-hint">{r.hint}</div>
              </div>
            </button>
          ))}
          {results.length === 0 && <div className="ps2-palette-empty">No matches.</div>}
        </div>
      </div>
    </div>
  );
}
