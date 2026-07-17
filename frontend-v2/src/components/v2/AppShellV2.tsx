"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { authApi, dashboardApi } from "@/lib/api";
import { Ps2UserContext, type Ps2User } from "@/components/v2/Ps2UserContext";
import { usePs2Theme } from "@/components/v2/Ps2ThemeProvider";
import { useIsMobile } from "@/components/v2/useIsMobile";
import { Ps2Logo } from "@/components/v2/Ps2Logo";
import { CommandPaletteV2 } from "@/components/v2/CommandPaletteV2";
import { ShortcutsOverlayV2 } from "@/components/v2/ShortcutsOverlayV2";
import { OnboardingTourV2, TOUR_STEPS } from "@/components/v2/OnboardingTourV2";
import { NotificationsBellV2 } from "@/components/v2/NotificationsBellV2";
import { useExportSphere } from "@/components/v2/useExportSphere";
import { useToast } from "@/components/v2/ToastProviderV2";
import { formatBytes } from "@/lib/v2/format";
import {
  ActivityIcon,
  BrowseIcon,
  DashboardIcon,
  ExportIcon,
  ManagePlanIcon,
  MoreIcon,
  OrganizeIcon,
  PlacesIcon,
  SearchIcon,
  SettingsIcon,
  ShareIcon,
  SignOutIcon,
  SwitchIcon,
  ThemeIcon,
  TrashIcon,
  UploadIcon,
} from "@/components/v2/icons";

type NavKey = "dashboard" | "browse" | "search" | "upload" | "organize" | "share" | "places" | "activity" | "trash";

// Screens not yet rebuilt in v2 fall back to their classic route, so the nav
// (and the mobile More sheet) always has somewhere real to go - this is the
// "use both side by side" toggle from a routing point of view. Extend this
// set as each screen in the build order ships. Places has no classic
// counterpart at all (it's a new v2-only screen), so its "classicHref" is
// just a self-reference - navHref never falls back to it since "places" is
// already in this set.
const V2_READY: ReadonlySet<NavKey> = new Set(["dashboard", "browse", "upload", "organize", "search", "share", "places", "activity", "trash"]);

const NAV_ITEMS: { key: NavKey; label: string; classicHref: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { key: "dashboard", label: "Dashboard", classicHref: "/dashboard", Icon: DashboardIcon },
  { key: "browse", label: "Browse", classicHref: "/browse", Icon: BrowseIcon },
  { key: "search", label: "Search", classicHref: "/search", Icon: SearchIcon },
  { key: "upload", label: "Upload", classicHref: "/upload", Icon: UploadIcon },
  { key: "organize", label: "Organize", classicHref: "/organize", Icon: OrganizeIcon },
  { key: "share", label: "Share & guests", classicHref: "/share", Icon: ShareIcon },
  { key: "places", label: "Places", classicHref: "/v2/places", Icon: PlacesIcon },
  { key: "activity", label: "Activity", classicHref: "/activity", Icon: ActivityIcon },
  { key: "trash", label: "Trash", classicHref: "/trash", Icon: TrashIcon },
];

function navHref(key: NavKey, classicHref: string) {
  return V2_READY.has(key) ? `/v2/${key}` : classicHref;
}

export default function AppShellV2({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { toggleTheme } = usePs2Theme();
  const showToast = useToast();

  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<Ps2User | null>(null);
  const isMobile = useIsMobile();
  const [profileOpen, setProfileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [storagePct, setStoragePct] = useState<number | null>(null);
  const [storageLabel, setStorageLabel] = useState<string | null>(null);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const { exportSphere, exporting } = useExportSphere();

  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/v2/login"))
      .finally(() => setChecking(false));
  }, [router]);

  // First-visit onboarding tour - gated on a localStorage flag so it never
  // nags twice; "Replay welcome tour" in the profile menu re-opens it
  // regardless of the flag.
  useEffect(() => {
    try {
      if (localStorage.getItem("ps2_tour_done") !== "1") setTourStep(0);
    } catch {
      // localStorage unavailable (e.g. private mode) - just skip the tour
      // rather than risk nagging every load.
    }
  }, []);

  function finishTour() {
    setTourStep(null);
    try {
      localStorage.setItem("ps2_tour_done", "1");
    } catch {
      // Nothing to persist to - the tour will just show again next visit.
    }
  }

  function nextTourStep() {
    setTourStep((s) => (s == null || s >= TOUR_STEPS.length - 1 ? (finishTour(), null) : s + 1));
  }

  function replayTour() {
    setProfileOpen(false);
    setMoreOpen(false);
    setTourStep(0);
  }

  function openManagePlan() {
    setProfileOpen(false);
    showToast("Plan management is coming soon for Pro members.");
  }

  function openAccountSettings() {
    setProfileOpen(false);
    showToast("Account settings are coming soon.");
  }

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    dashboardApi
      .get()
      .then((stats) => {
        if (cancelled) return;
        setStoragePct(Math.max(0, Math.min(1, stats.storage.usedPercent)));
        setStorageLabel(`${formatBytes(stats.storage.usedBytes)} of ${formatBytes(stats.storage.limitBytes)}`);
      })
      .catch(() => {
        // Decorative widget only - the page content surfaces real load errors.
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    setProfileOpen(false);
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!profileOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest("[data-ps2-profile]")) setProfileOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [profileOpen]);

  async function handleSignOut() {
    await authApi.logout();
    router.replace("/v2/login");
  }

  if (checking || !user) return null;

  function isActive(key: NavKey) {
    const href = navHref(key, "");
    return href.startsWith("/v2/") && pathname?.startsWith(href);
  }

  function renderProfileMenu(currentUser: Ps2User, style?: CSSProperties) {
    return (
      <div className="ps2-profile-menu" style={style}>
        <div style={{ padding: "10px 10px 8px", borderBottom: "1px solid var(--ps2-border)", marginBottom: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{currentUser.name}</div>
          <div style={{ fontSize: 11.5, color: "var(--ps2-muted)", marginTop: 1 }}>{currentUser.email}</div>
        </div>
        <button type="button" className="ps2-profile-menu-item spread" onClick={openManagePlan}>
          <span className="item-label">
            <ManagePlanIcon size={15} />
            Manage plan
          </span>
          <span className="ps2-pro-badge">Pro</span>
        </button>
        <button type="button" className="ps2-profile-menu-item" onClick={openAccountSettings}>
          <SettingsIcon size={15} />
          Account settings
        </button>
        <button type="button" className="ps2-profile-menu-item" onClick={exportSphere} disabled={exporting}>
          <ExportIcon size={15} />
          {exporting ? "Exporting…" : "Export my sphere"}
        </button>
        {isMobile ? (
          <button type="button" className="ps2-profile-menu-item" onClick={toggleTheme}>
            <ThemeIcon size={15} />
            Switch theme
          </button>
        ) : (
          <button type="button" className="ps2-profile-menu-item" onClick={replayTour}>
            <SwitchIcon size={15} />
            Replay welcome tour
          </button>
        )}
        <div className="ps2-menu-divider" />
        <button type="button" className="ps2-profile-menu-item danger" onClick={handleSignOut}>
          <SignOutIcon size={15} />
          Sign out
        </button>
      </div>
    );
  }

  return (
    <Ps2UserContext.Provider value={user}>
      <div className="ps2-shell">
        {!isMobile && (
          <aside className="ps2-sidebar">
            <div className="ps2-sidebar-brand">
              <Ps2Logo size={32} gradientId="ps2LogoSidebar" />
              <div className="ps2-sidebar-brand-name">PhotoSphere</div>
            </div>
            <nav className="ps2-nav">
              {NAV_ITEMS.map(({ key, label, classicHref, Icon: ItemIcon }) => (
                <Link
                  key={key}
                  href={navHref(key, classicHref)}
                  className={`ps2-nav-btn${key === "places" ? " no-hover" : ""}${isActive(key) ? " active" : ""}`}
                >
                  <ItemIcon />
                  {label}
                </Link>
              ))}
            </nav>
            <div className="ps2-sidebar-bottom">
              <div className="ps2-storage-mini">
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--ps2-muted)", marginBottom: 9 }}>
                  <span>Storage</span>
                  <span>{storagePct != null ? `${Math.round(storagePct * 100)}%` : "…"}</span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 99,
                    background: "color-mix(in oklab, var(--ps2-text) 10%, transparent)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${(storagePct ?? 0) * 100}%`,
                      height: "100%",
                      borderRadius: 99,
                      background: "linear-gradient(90deg, var(--ps2-accent), var(--ps2-purple))",
                    }}
                  />
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ps2-muted)", marginTop: 8 }}>{storageLabel ?? "Loading…"}</div>
              </div>

              <div className="ps2-profile" data-ps2-profile>
                {profileOpen && renderProfileMenu(user)}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button type="button" className="ps2-profile-trigger" onClick={() => setProfileOpen((v) => !v)} style={{ flex: 1 }}>
                    <div className="ps2-avatar">{user.name.charAt(0).toUpperCase()}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {user.name}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--ps2-muted)" }}>Pro plan</div>
                    </div>
                  </button>
                  <button type="button" className="ps2-theme-btn" title="Toggle theme" onClick={toggleTheme}>
                    <ThemeIcon size={14} />
                  </button>
                </div>
              </div>
            </div>
          </aside>
        )}

        <div className="ps2-main">
          <div className="ps2-topbar">
            <Link href={navHref("search", "/search")} className="ps2-search-pill">
              <SearchIcon size={15} />
              {!isMobile && "Search photos, places, moods…"}
              <span className="ps2-kbd">⌘K</span>
            </Link>
            <div className="ps2-topbar-right">
              <NotificationsBellV2 />
              {!isMobile && (
                <Link href={navHref("upload", "/upload")} className="ps2-upload-btn">
                  <UploadIcon size={14} />
                  Upload
                </Link>
              )}
              {isMobile && (
                <div className="ps2-profile" data-ps2-profile>
                  <button type="button" className="ps2-mobile-avatar-btn" title="Account" onClick={() => setProfileOpen((v) => !v)}>
                    {user.name.charAt(0).toUpperCase()}
                  </button>
                  {profileOpen &&
                    renderProfileMenu(user, { left: "auto", right: 0, bottom: "auto", top: "calc(100% + 8px)", width: 236, zIndex: 60 })}
                </div>
              )}
            </div>
          </div>

          {children}
        </div>
      </div>

      {isMobile && (
        <nav className="ps2-bottomnav">
          <Link href={navHref("dashboard", "/dashboard")} className={`ps2-bottomnav-btn${isActive("dashboard") ? " active" : ""}`}>
            <DashboardIcon size={19} />
            <span>Home</span>
          </Link>
          <Link href={navHref("browse", "/browse")} className={`ps2-bottomnav-btn${isActive("browse") ? " active" : ""}`}>
            <BrowseIcon size={19} />
            <span>Browse</span>
          </Link>
          <Link href={navHref("upload", "/upload")} className={`ps2-bottomnav-btn${isActive("upload") ? " active" : ""}`}>
            <span className="ps2-bottomnav-upload">
              <UploadIcon size={17} />
            </span>
          </Link>
          <Link href={navHref("search", "/search")} className={`ps2-bottomnav-btn${isActive("search") ? " active" : ""}`}>
            <SearchIcon size={19} />
            <span>Search</span>
          </Link>
          <button type="button" className="ps2-bottomnav-btn" onClick={() => setMoreOpen(true)}>
            <MoreIcon size={19} />
            <span>More</span>
          </button>
        </nav>
      )}

      {moreOpen && (
        <div className="ps2-sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div className="ps2-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="ps2-sheet-handle" />
            <Link href={navHref("organize", "/organize")} className={`ps2-sheet-item${isActive("organize") ? " active" : ""}`}>
              <OrganizeIcon size={19} />
              Organize
            </Link>
            <Link href={navHref("places", "/v2/places")} className={`ps2-sheet-item${isActive("places") ? " active" : ""}`}>
              <PlacesIcon size={19} />
              Places
            </Link>
            <Link href={navHref("share", "/share")} className={`ps2-sheet-item${isActive("share") ? " active" : ""}`}>
              <ShareIcon size={19} />
              Share &amp; guests
            </Link>
            <Link href={navHref("activity", "/activity")} className={`ps2-sheet-item${isActive("activity") ? " active" : ""}`}>
              <ActivityIcon size={19} />
              Activity
            </Link>
            <Link href={navHref("trash", "/trash")} className={`ps2-sheet-item${isActive("trash") ? " active" : ""}`}>
              <TrashIcon size={19} />
              Trash
            </Link>
            <div className="ps2-sheet-divider" />
            <button type="button" className="ps2-sheet-item danger" onClick={handleSignOut}>
              <SignOutIcon size={19} />
              Sign out
            </button>
          </div>
        </div>
      )}

      <CommandPaletteV2 />
      <ShortcutsOverlayV2 />
      {tourStep !== null && <OnboardingTourV2 step={tourStep} onNext={nextTourStep} onSkip={finishTour} />}
    </Ps2UserContext.Provider>
  );
}
