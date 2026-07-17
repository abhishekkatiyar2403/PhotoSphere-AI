"use client";

// v2 ("ps2") app shell — persistent sidebar + glass top bar from the
// redesign handoff (README.md "App shell"). Purely presentational chrome:
// auth gating and data stay in each page. Rendered inside a `.ps2`-scoped
// root so none of the v1 global styles are affected.
//
// Nav targets: only routes with a built v2 page point at /X/v2; the rest
// deliberately link to the existing classic pages until their v2 version
// ships, so nothing 404s mid-migration.

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authApi, searchApi } from "@/lib/api";

const NAV_JUMP_ITEMS = [
  { label: "Dashboard", href: "/dashboard/v2" },
  { label: "Browse", href: "/browse/v2" },
  { label: "Search", href: "/search/v2" },
  { label: "Upload", href: "/upload/v2" },
  { label: "Organize", href: "/organize/v2" },
  { label: "Share & guests", href: "/share/v2" },
  { label: "Places", href: "/places/v2" },
  { label: "Activity", href: "/activity/v2" },
  { label: "Trash", href: "/trash/v2" },
  { label: "Settings", href: "/settings" },
];

const TOUR_STEPS = [
  {
    title: "Upload anything",
    body: "Drag photos or videos in — AI tags, sorts, and files everything on arrival.",
  },
  {
    title: "Find it by describing it",
    body: "Press ⌘K or open Search and type what you remember.",
  },
  {
    title: "Share without accounts",
    body: "Generate guest links from Share — friends view your folders with no signup.",
  },
];

const TOUR_STORAGE_KEY = "ps2_tour_done";

// Flip an entry to `${href}/v2` here as each v2 screen lands.
const NAV_ITEMS: { key: string; label: string; href: string; icon: ReactNode }[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    href: "/dashboard/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
    ),
  },
  {
    key: "browse",
    label: "Browse",
    href: "/browse/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
    ),
  },
  {
    key: "search",
    label: "Search",
    href: "/search/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
    ),
  },
  {
    key: "upload",
    label: "Upload",
    href: "/upload/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 16V4" /><path d="m6 10 6-6 6 6" /><path d="M4 20h16" /></svg>
    ),
  },
  {
    key: "organize",
    label: "Organize",
    href: "/organize/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /></svg>
    ),
  },
  {
    key: "share",
    label: "Share & guests",
    href: "/share/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
    ),
  },
  {
    key: "places",
    label: "Places",
    href: "/places/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></svg>
    ),
  },
  {
    key: "activity",
    label: "Activity",
    href: "/activity/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
    ),
  },
  {
    key: "trash",
    label: "Trash",
    href: "/trash/v2",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
    ),
  },
];

export type Ps2ShellProps = {
  active: string; // key from NAV_ITEMS
  userName: string;
  // Sidebar storage mini-widget (optional until the page has stats).
  storagePct?: number; // 0-100
  storageLabel?: string;
  // Where the "Classic UI" escape hatch points (the v1 twin of this page).
  classicHref: string;
  children: ReactNode;
};

export default function Ps2Shell({ active, userName, storagePct, storageLabel, classicHref, children }: Ps2ShellProps) {
  const router = useRouter();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteResults, setPaletteResults] = useState<{ label: string; hint: string; go: () => void }[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0); // 0 = closed, 1-3 = step
  const [toast, setToast] = useState<string | null>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);

  async function handleLogout() {
    await authApi.logout();
    router.replace("/login");
  }

  const initial = (userName.trim()[0] ?? "?").toUpperCase();

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2200);
  }

  // Close dropdowns on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) setProfileMenuOpen(false);
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // First-ever dashboard visit shows the welcome tour once.
  useEffect(() => {
    if (active !== "dashboard") return;
    try {
      if (!localStorage.getItem(TOUR_STORAGE_KEY)) setTourStep(1);
    } catch {
      // localStorage unavailable — skip the tour rather than error.
    }
  }, [active]);

  const runPaletteSearch = useCallback(async (query: string) => {
    const q = query.trim().toLowerCase();
    const navMatches = (q ? NAV_JUMP_ITEMS.filter((n) => n.label.toLowerCase().includes(q)) : NAV_JUMP_ITEMS).map((n) => ({
      label: n.label,
      hint: "Go to page",
      go: () => router.push(n.href),
    }));
    if (!q) {
      setPaletteResults(navMatches);
      return;
    }
    try {
      const res = await searchApi.search({ q: query.trim(), limit: 6, offset: 0 });
      const photoMatches = res.photos.map((p) => ({
        label: p.originalFilename,
        hint: "Photo",
        go: () => router.push("/browse/v2"),
      }));
      setPaletteResults([...navMatches, ...photoMatches]);
    } catch {
      setPaletteResults(navMatches);
    }
  }, [router]);

  useEffect(() => {
    if (paletteOpen) void runPaletteSearch(paletteQuery);
  }, [paletteOpen, paletteQuery, runPaletteSearch]);

  // Global keyboard shortcuts: ⌘K / Ctrl+K for the palette, "?" for the
  // shortcuts overlay, Escape to close whichever is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        setPaletteQuery("");
        return;
      }
      if (e.key === "Escape") {
        setPaletteOpen(false);
        setShortcutsOpen(false);
        return;
      }
      if (e.key === "?" && !typing && !paletteOpen) {
        setShortcutsOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  function finishTour() {
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, "1");
    } catch {
      // best-effort only
    }
    setTourStep(0);
  }

  return (
    <div className="ps2" data-ps2-theme={theme}>
      <div className="ps2-shell">
        <aside className="ps2-sidebar">
          <div className="ps2-logo-row">
            <div className="ps2-logo-mark"><div className="ps2-logo-dot" /></div>
            <div className="ps2-logo-name">PhotoSphere</div>
          </div>

          <nav className="ps2-nav">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={`ps2-nav-item${item.key === active ? " ps2-nav-active" : ""}`}
                data-testid={`ps2-nav-${item.key}`}
              >
                {item.icon}
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ps2-sidebar-bottom">
            {storagePct != null && (
              <div className="ps2-storage-mini">
                <div className="ps2-storage-mini-head">
                  <span>Storage</span>
                  <span>{Math.round(storagePct)}%</span>
                </div>
                <div className="ps2-progress">
                  <div className="ps2-progress-fill" style={{ width: `${Math.max(0, Math.min(100, storagePct))}%` }} />
                </div>
                {storageLabel && <div className="ps2-storage-mini-sub">{storageLabel}</div>}
              </div>
            )}
            <div className="ps2-user-row" ref={profileMenuRef} style={{ position: "relative" }}>
              {profileMenuOpen && (
                <div className="ps2-menu ps2-menu-up">
                  <div className="ps2-menu-header">
                    <div className="ps2-menu-header-name">{userName}</div>
                  </div>
                  <button type="button" className="ps2-menu-item" onClick={() => { setProfileMenuOpen(false); router.push("/settings"); }}>
                    <span className="ps2-menu-item-label">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                      Manage plan
                    </span>
                  </button>
                  <button type="button" className="ps2-menu-item" onClick={() => { setProfileMenuOpen(false); router.push("/settings"); }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                    Account settings
                  </button>
                  <button
                    type="button"
                    className="ps2-menu-item"
                    onClick={() => { setProfileMenuOpen(false); showToast("Export isn't wired up yet — coming soon."); }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v12m-6-6 6 6 6-6M4 20h16" /></svg>
                    Export my sphere
                  </button>
                  <button
                    type="button"
                    className="ps2-menu-item"
                    onClick={() => { setProfileMenuOpen(false); setTourStep(1); }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5" /></svg>
                    Replay welcome tour
                  </button>
                  <div className="ps2-menu-divider" />
                  <button type="button" className="ps2-menu-item ps2-menu-item-danger" onClick={handleLogout}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></svg>
                    Sign out
                  </button>
                </div>
              )}
              <div className="ps2-user-row-click" onClick={() => setProfileMenuOpen((v) => !v)}>
                <div className="ps2-avatar">{initial}</div>
                <div className="ps2-user-meta">
                  <div className="ps2-user-name">{userName}</div>
                  <div className="ps2-user-plan">Local MVP</div>
                </div>
              </div>
              <button
                type="button"
                className="ps2-icon-btn"
                title="Toggle theme"
                onClick={(e) => { e.stopPropagation(); setTheme((t) => (t === "dark" ? "light" : "dark")); }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
              </button>
            </div>
          </div>
        </aside>

        <div className="ps2-main-col">
          <div className="ps2-topbar">
            <button type="button" className="ps2-searchbar" onClick={() => { setPaletteOpen(true); setPaletteQuery(""); }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              Search photos, places, moods…
              <span className="ps2-kbd">⌘K</span>
            </button>
            <div className="ps2-topbar-right">
              <div className="ps2-bell-wrap" ref={bellRef} style={{ position: "relative" }}>
                <button type="button" className="ps2-icon-btn-lg" title="Notifications" onClick={() => setBellOpen((v) => !v)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>
                </button>
                {bellOpen && (
                  <div className="ps2-menu ps2-menu-down ps2-bell-menu">
                    <div className="ps2-bell-empty">Notifications aren&apos;t wired up yet — check Activity for a full history.</div>
                    <Link href="/activity/v2" className="ps2-menu-item" onClick={() => setBellOpen(false)}>
                      View all activity
                    </Link>
                  </div>
                )}
              </div>
              <Link href={classicHref} className="ps2-classic-link" data-testid="ps2-classic-link">
                Classic UI
              </Link>
              <Link href="/upload/v2" className="ps2-btn-accent">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 16V4m-6 6 6-6 6 6M4 20h16" /></svg>
                Upload
              </Link>
              <button type="button" className="ps2-icon-btn-lg" title="Sign out" onClick={handleLogout}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></svg>
              </button>
            </div>
          </div>

          {children}
        </div>
      </div>

      {paletteOpen && (
        <div className="ps2-modal-overlay ps2-palette-overlay" onClick={() => setPaletteOpen(false)}>
          <div className="ps2-palette" onClick={(e) => e.stopPropagation()}>
            <div className="ps2-palette-input-row">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ps2-muted)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input
                autoFocus
                value={paletteQuery}
                onChange={(e) => setPaletteQuery(e.target.value)}
                placeholder="Jump to a page or search your photos…"
                className="ps2-palette-input"
              />
              <span className="ps2-kbd">esc</span>
            </div>
            <div className="ps2-palette-results">
              {paletteResults.map((r, i) => (
                <div
                  key={`${r.label}-${i}`}
                  className="ps2-palette-item"
                  onClick={() => { r.go(); setPaletteOpen(false); }}
                >
                  <div className="ps2-palette-item-label">{r.label}</div>
                  <div className="ps2-palette-item-hint">{r.hint}</div>
                </div>
              ))}
              {paletteResults.length === 0 && <div className="ps2-palette-empty">No matches.</div>}
            </div>
          </div>
        </div>
      )}

      {shortcutsOpen && (
        <div className="ps2-modal-overlay" onClick={() => setShortcutsOpen(false)}>
          <div className="ps2-modal ps2-shortcuts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ps2-modal-title">Keyboard shortcuts</div>
            <div className="ps2-shortcut-row"><span>Command palette</span><span className="ps2-kbd">⌘K</span></div>
            <div className="ps2-shortcut-row"><span>Close viewer or dialog</span><span className="ps2-kbd">Esc</span></div>
            <div className="ps2-shortcut-row"><span>Toggle this panel</span><span className="ps2-kbd">?</span></div>
          </div>
        </div>
      )}

      {tourStep > 0 && (
        <div className="ps2-modal-overlay">
          <div className="ps2-modal ps2-tour-modal">
            <div className="ps2-tour-eyebrow">Welcome · {tourStep} of {TOUR_STEPS.length}</div>
            <div className="ps2-tour-title">{TOUR_STEPS[tourStep - 1].title}</div>
            <div className="ps2-tour-body">{TOUR_STEPS[tourStep - 1].body}</div>
            <div className="ps2-tour-actions">
              <button type="button" className="ps2-tour-skip" onClick={finishTour}>Skip tour</button>
              <button
                type="button"
                className="ps2-btn-accent"
                onClick={() => (tourStep >= TOUR_STEPS.length ? finishTour() : setTourStep(tourStep + 1))}
              >
                {tourStep >= TOUR_STEPS.length ? "Done" : "Next"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="ps2-toast">{toast}</div>}
    </div>
  );
}
