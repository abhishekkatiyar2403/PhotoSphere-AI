"use client";

// Dashboard page (specs/week7-8-dashboard-browser-viewer.md "Dashboard page",
// design/wireframes/dashboard.svg - Option B: storage-meter hero + folder
// shortcut tiles). Replaces the Week 1-2 auth-proof placeholder ("Welcome,
// {name}" + logout) that lived here; the logout affordance is folded into
// the top bar (the app has no persistent nav shell yet - Option C, the nav
// shell, was explicitly deferred).
//
// Data assembly (Option 1 - no backend change): GET /api/dashboard supplies
// the storage hero + totals recap, but its collections[] rollup is
// per-COLLECTION, not the per-FOLDER breakdown the Option B tiles need. So
// the folder tiles are assembled from the same already-shipped endpoints
// /organize and /browse use: GET /api/collections -> default collection ->
// GET /api/collections/:id/folders for the real folders, plus
// GET /api/photos/unfiled for the Unfiled tile count. A few GETs on mount,
// the same multi-fetch-on-mount pattern /organize already uses - zero new
// backend work, no dashboard-response change.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  collectionsApi,
  dashboardApi,
  DashboardStats,
  Folder,
  foldersApi,
  unfiledPhotosApi,
} from "@/lib/api";

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// Human-readable byte formatting from the API's string byte values (returned
// as strings to avoid BigInt-JSON issues). Parse defensively: a non-numeric
// or missing value formats as "0 B" rather than "NaN". Uses binary units
// (1024) so it lines up with typical "GB" storage-quota expectations.
function formatBytes(raw: string | number): string {
  const bytes = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  // 1 decimal for KB and up, integer for raw bytes.
  const formatted = exponent === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${units[exponent]}`;
}

// Locale-grouped integer, e.g. 1248 -> "1,248".
function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

// Pluralize a count with its noun, e.g. (1, "folder") -> "1 folder".
function plural(n: number, noun: string): string {
  return `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [unfiledCount, setUnfiledCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- Auth gate (same pattern as /organize, /browse, /upload) ----
  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  // ---- Data assembly on mount: dashboard stats + folder list + unfiled
  // count, in parallel where independent. Guarded against a stale response
  // clobbering state if the component unmounts mid-flight (the multi-fetch
  // race the build brief calls out). ----
  useEffect(() => {
    if (checking) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        // dashboard stats + collections (for the default collection's id) +
        // unfiled count are all independent -> fetch together.
        const [statsRes, collectionsRes, unfiledRes] = await Promise.all([
          dashboardApi.get(),
          collectionsApi.list(),
          unfiledPhotosApi.list({ limit: 1, offset: 0 }), // only `total` needed
        ]);
        if (cancelled) return;

        setStats(statsRes);
        setUnfiledCount(unfiledRes.total);

        // Folder tiles come from the default collection's folder list (the
        // per-folder breakdown the dashboard rollup doesn't carry). A
        // brand-new user with zero collections simply has no folders yet.
        const defaultCollection =
          collectionsRes.collections.find((c) => c.isDefault) ?? collectionsRes.collections[0] ?? null;
        if (defaultCollection) {
          const foldersRes = await foldersApi.list(defaultCollection.id);
          if (cancelled) return;
          setFolders(foldersRes.folders);
        } else {
          setFolders([]);
        }
      } catch (err) {
        if (cancelled) return;
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checking, router]);

  async function handleLogout() {
    await authApi.logout();
    router.replace("/login");
  }

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  return (
    <main className="dashboard-page">
      <div className="organize-topbar">
        <h1>PhotoSphere AI — Dashboard</h1>
        <div className="dashboard-topbar-right">
          <Link href="/guests" className="dashboard-guests-link" data-testid="dashboard-guests-link">
            Guests
          </Link>
          <Link href="/activity" className="dashboard-guests-link" data-testid="dashboard-activity-link">
            Activity
          </Link>
          <span>{user.name}</span>
          <button type="button" className="dashboard-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>

      <div className="dashboard-content">
        {loading && <p className="organize-empty">Loading dashboard…</p>}
        {error && !loading && <p className="organize-new-folder-error">{error}</p>}

        {!loading && !error && stats && (
          <>
            <StorageHero stats={stats} />

            <section className="dashboard-section">
              <div className="dashboard-section-head">
                <h2>Jump to a folder</h2>
                <span className="dashboard-section-sub">(from My Photos)</span>
              </div>

              {folders.length === 0 && unfiledCount === 0 ? (
                <p className="organize-empty">No photos yet — upload one to get started.</p>
              ) : (
                <div className="dashboard-tiles" data-testid="dashboard-tiles">
                  {folders.map((folder) => (
                    <Link
                      key={folder.id}
                      href={`/browse?folder=${encodeURIComponent(folder.id)}`}
                      className="dashboard-tile"
                      data-testid={`dashboard-tile-${folder.name}`}
                    >
                      <span className="dashboard-tile-thumb" aria-hidden="true" />
                      <span className="dashboard-tile-name">{folder.name}</span>
                      <span className="dashboard-tile-count">{plural(folder.photoCount, "photo")}</span>
                    </Link>
                  ))}

                  {unfiledCount > 0 && (
                    <Link
                      href="/browse?folder=__unfiled__"
                      className="dashboard-tile dashboard-tile-unfiled"
                      data-testid="dashboard-tile-Unfiled"
                    >
                      <span className="dashboard-tile-thumb dashboard-tile-thumb-unfiled" aria-hidden="true" />
                      <span className="dashboard-tile-name">Unfiled</span>
                      <span className="dashboard-tile-count">
                        {formatCount(unfiledCount)} {unfiledCount === 1 ? "needs" : "need"} attention
                      </span>
                    </Link>
                  )}

                  <Link href="/browse" className="dashboard-tile dashboard-tile-viewall" data-testid="dashboard-tile-viewall">
                    <span className="dashboard-tile-viewall-label">View all folders</span>
                    <span className="dashboard-tile-viewall-arrow" aria-hidden="true">
                      →
                    </span>
                  </Link>
                </div>
              )}
            </section>

            <section className="dashboard-section">
              <div className="dashboard-section-head">
                <h2>At a glance</h2>
              </div>
              <p className="dashboard-glance" data-testid="dashboard-glance">
                {plural(stats.totals.folderCount, "folder")} · {plural(stats.totals.collectionCount, "collection")} ·{" "}
                {formatCount(stats.totals.photoCount)} photos total
              </p>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function StorageHero({ stats }: { stats: DashboardStats }) {
  const { storage } = stats;
  // usedPercent is a 0-1 float from the server; render as a 0-100 width.
  // Clamp defensively even though the server already caps at 1.0.
  const pct = Math.max(0, Math.min(1, Number.isFinite(storage.usedPercent) ? storage.usedPercent : 0));
  const pctLabel = Math.round(pct * 100);

  return (
    <section className="dashboard-hero" data-testid="dashboard-hero">
      <p className="dashboard-hero-label">STORAGE</p>
      <p className="dashboard-hero-heading">
        {formatBytes(storage.usedBytes)}{" "}
        <span className="dashboard-hero-heading-sub">of {formatBytes(storage.limitBytes)} used</span>
      </p>
      <div className="dashboard-meter" role="progressbar" aria-valuenow={pctLabel} aria-valuemin={0} aria-valuemax={100}>
        <div className="dashboard-meter-fill" style={{ width: `${pct * 100}%` }} data-testid="dashboard-meter-fill" />
      </div>
      <div className="dashboard-hero-captions">
        <span data-testid="dashboard-pct">{pctLabel}% used</span>
        <span>{formatCount(stats.totals.photoCount)} photos total</span>
      </div>
    </section>
  );
}
