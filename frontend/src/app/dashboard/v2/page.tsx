"use client";

// Dashboard v2 — redesign handoff (README.md "Dashboard", PhotoSphere.dc.html
// Dashboard screen), living side-by-side with the classic /dashboard page.
// Same auth gate, cancellation guard, and error handling as
// src/app/dashboard/page.tsx; same data assembly (dashboardApi +
// collectionsApi + foldersApi + unfiledPhotosApi), plus one additive call:
// a bare searchApi.search({ limit: 8 }) — the library newest-first — to fill
// the design's "Recent uploads" thumbnail strip with real 60s pre-signed
// thumbnails. The prototype's "Curated for you" auto-album row has no backend
// yet (AI auto-albums aren't built), so the hero right side shows the user's
// real collections rollup from dashboardApi instead of fabricated albums.

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
  FolderPhoto,
  foldersApi,
  photosApi,
  searchApi,
  unfiledPhotosApi,
} from "@/lib/api";
import Ps2Shell from "@/components/ps2/Shell";

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// Same defensive byte formatting as the classic dashboard (string byte
// values from the API; binary units).
function formatBytes(raw: string | number): string {
  const bytes = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  const formatted = exponent === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${units[exponent]}`;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, noun: string): string {
  return `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export default function DashboardV2Page() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [unfiledCount, setUnfiledCount] = useState(0);
  const [recent, setRecent] = useState<FolderPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Duplicate review (README "duplicate detection" banner). The prototype's
  // modal reviews a fixed 3-pair mock set; here it reviews REAL photos whose
  // status is "duplicate" — those only ever show up via GET /api/photos/unfiled
  // (they have folderId: null), there's no dedicated duplicates endpoint.
  const [duplicates, setDuplicates] = useState<FolderPhoto[]>([]);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupIndex, setDupIndex] = useState(0);
  const [dupOriginal, setDupOriginal] = useState<Record<string, string>>({});
  const [dupBusy, setDupBusy] = useState(false);

  // ---- Auth gate (identical to the classic dashboard) ----
  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  useEffect(() => {
    if (checking) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [statsRes, collectionsRes, unfiledRes, recentRes, dupScanRes] = await Promise.all([
          dashboardApi.get(),
          collectionsApi.list(),
          unfiledPhotosApi.list({ limit: 1, offset: 0 }), // only `total` needed
          searchApi.search({ limit: 8, offset: 0 }), // bare search = library newest-first (S6)
          unfiledPhotosApi.list({ limit: 100, offset: 0 }), // scanned for status:"duplicate" below
        ]);
        if (cancelled) return;

        setStats(statsRes);
        setUnfiledCount(unfiledRes.total);
        setRecent(recentRes.photos);
        setDuplicates(dupScanRes.photos.filter((p) => p.status === "duplicate"));

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

  const currentDup = duplicates[dupIndex];

  useEffect(() => {
    if (!dupOpen || !currentDup?.duplicateOfPhotoId) return;
    const id = currentDup.duplicateOfPhotoId;
    if (dupOriginal[id]) return;
    let cancelled = false;
    photosApi
      .get(id)
      .then((orig) => {
        if (!cancelled) setDupOriginal((prev) => ({ ...prev, [id]: orig.originalFilename }));
      })
      .catch(() => {
        if (!cancelled) setDupOriginal((prev) => ({ ...prev, [id]: id }));
      });
    return () => {
      cancelled = true;
    };
  }, [dupOpen, currentDup, dupOriginal]);

  // "Keep this one" — the duplicate copy is soft-deleted to Trash (real
  // photosApi.remove), same as any other delete; the original stays put.
  async function keepOriginal() {
    if (!currentDup || dupBusy) return;
    setDupBusy(true);
    try {
      await photosApi.remove(currentDup.id);
      setDuplicates((prev) => {
        const next = prev.filter((p) => p.id !== currentDup.id);
        if (next.length === 0) setDupOpen(false);
        setDupIndex((i) => Math.min(i, Math.max(0, next.length - 1)));
        return next;
      });
    } catch {
      // leave the pair in place so the owner can retry
    } finally {
      setDupBusy(false);
    }
  }

  // "Keep both" — reclassifies the duplicate so it's re-run through the
  // pipeline as a distinct photo instead of being flagged a copy (the same
  // "not a duplicate?" action Browse already exposes per-card).
  async function keepBoth() {
    if (!currentDup || dupBusy) return;
    setDupBusy(true);
    try {
      await photosApi.reclassify(currentDup.id);
      setDuplicates((prev) => {
        const next = prev.filter((p) => p.id !== currentDup.id);
        if (next.length === 0) setDupOpen(false);
        setDupIndex((i) => Math.min(i, Math.max(0, next.length - 1)));
        return next;
      });
    } catch {
      // leave the pair in place so the owner can retry
    } finally {
      setDupBusy(false);
    }
  }

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  const pct = stats
    ? Math.max(0, Math.min(1, Number.isFinite(stats.storage.usedPercent) ? stats.storage.usedPercent : 0))
    : 0;

  return (
    <Ps2Shell
      active="dashboard"
      userName={user.name}
      classicHref="/dashboard"
      storagePct={stats ? pct * 100 : undefined}
      storageLabel={stats ? `${formatBytes(stats.storage.usedBytes)} of ${formatBytes(stats.storage.limitBytes)}` : undefined}
    >
      <main className="ps2-dash" data-testid="dashboard-v2">
        <div className="ps2-dash-head">
          <p className="ps2-eyebrow">{todayLabel()}</p>
          <h1 className="ps2-h1">
            {greeting()}, {user.name}{" "}
            {stats && (
              <span className="ps2-h1-accent">— {formatCount(stats.totals.photoCount)} memories safe.</span>
            )}
          </h1>
        </div>

        {loading && (
          <div className="ps2-loading">
            <span className="ps2-spinner" aria-hidden="true" />
            Loading your sphere…
          </div>
        )}
        {error && !loading && <p className="ps2-error">{error}</p>}

        {!loading && !error && stats && (
          <>
            <div className="ps2-hero-row">
              <StorageRing stats={stats} pct={pct} />

              <div className="ps2-collections-col">
                <div className="ps2-section-head ps2-anim-up">
                  <h2 className="ps2-section-title">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--ps2-accent)" }}><path d="M12 2l2.1 6.4L21 10l-6.4 2.1L12 19l-2.1-6.9L3 10l6.9-1.6L12 2z" /></svg>
                    Your collections
                  </h2>
                  <span className="ps2-section-sub">
                    {plural(stats.totals.folderCount, "folder")} across {plural(stats.totals.collectionCount, "collection")}
                  </span>
                </div>
                <div className="ps2-story-grid">
                  {stats.collections.slice(0, 3).map((c, i) => (
                    <Link
                      key={c.id}
                      href="/browse"
                      className="ps2-story-card"
                      style={{ animationDelay: `${0.2 + i * 0.08}s`, background: "var(--ps2-tile)" }}
                    >
                      <div className="ps2-story-scrim" />
                      <div className="ps2-story-caption">
                        <div className="ps2-story-title">{c.name}</div>
                        <div className="ps2-story-sub">
                          {plural(c.photoCount, "photo")} · {plural(c.folderCount, "folder")}
                        </div>
                      </div>
                    </Link>
                  ))}
                  {stats.collections.length === 0 && (
                    <div className="ps2-empty" style={{ gridColumn: "1 / -1" }}>
                      <div className="ps2-empty-title">No collections yet.</div>
                      <div>Upload a photo and PhotoSphere will start organizing.</div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {duplicates.length > 0 && (
              <div className="ps2-dup-banner ps2-anim-up">
                <div className="ps2-dup-banner-icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                    PhotoSphere found {plural(duplicates.length, "possible duplicate")}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 2 }}>
                    Review them to keep only what you want.
                  </div>
                </div>
                <button type="button" className="ps2-dup-review-btn" onClick={() => { setDupIndex(0); setDupOpen(true); }}>
                  Review
                </button>
              </div>
            )}

            <section style={{ marginTop: 36 }} className="ps2-anim-up">
              <div className="ps2-section-head-between">
                <h2 className="ps2-section-title">Recent uploads</h2>
                <Link href="/browse" style={{ fontSize: 13 }}>
                  View library →
                </Link>
              </div>
              {recent.length === 0 ? (
                <div className="ps2-empty">
                  <div className="ps2-empty-title">Nothing here yet.</div>
                  <div>Your newest photos will appear here after your first upload.</div>
                </div>
              ) : (
                <div className="ps2-recent-grid">
                  {recent.map((p) => (
                    <Link key={p.id} href="/browse" className="ps2-thumb-tile" title={p.originalFilename}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {p.thumbnailUrl && <img src={p.thumbnailUrl} alt={p.originalFilename} />}
                    </Link>
                  ))}
                </div>
              )}
            </section>

            <section style={{ marginTop: 36 }} className="ps2-anim-up">
              <div className="ps2-section-head-between">
                <h2 className="ps2-section-title">Folders</h2>
              </div>
              {folders.length === 0 && unfiledCount === 0 ? (
                <div className="ps2-empty">
                  <div className="ps2-empty-title">No photos yet.</div>
                  <div>Upload one to get started.</div>
                </div>
              ) : (
                <div className="ps2-folder-grid" data-testid="dashboard-v2-folders">
                  {folders.map((folder) => (
                    <Link
                      key={folder.id}
                      href={`/browse?folder=${encodeURIComponent(folder.id)}`}
                      className="ps2-folder-card"
                    >
                      <div className="ps2-folder-mosaic" aria-hidden="true">
                        <div className="ps2-folder-mosaic-main" />
                        <div className="ps2-folder-mosaic-side">
                          <div className="ps2-folder-mosaic-cell" />
                          <div className="ps2-folder-mosaic-cell" />
                        </div>
                      </div>
                      <div className="ps2-folder-name">{folder.name}</div>
                      <div className="ps2-folder-count">{plural(folder.photoCount, "photo")}</div>
                    </Link>
                  ))}
                  {unfiledCount > 0 && (
                    <Link href="/browse?folder=__unfiled__" className="ps2-folder-card">
                      <div className="ps2-folder-mosaic" aria-hidden="true">
                        <div className="ps2-folder-mosaic-main" style={{ borderStyle: "dashed", borderWidth: 1.5, borderColor: "var(--ps2-border)", background: "transparent" }} />
                        <div className="ps2-folder-mosaic-side">
                          <div className="ps2-folder-mosaic-cell" />
                          <div className="ps2-folder-mosaic-cell" />
                        </div>
                      </div>
                      <div className="ps2-folder-name">Unfiled</div>
                      <div className="ps2-folder-count">
                        {formatCount(unfiledCount)} {unfiledCount === 1 ? "needs" : "need"} attention
                      </div>
                    </Link>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {dupOpen && currentDup && (
        <div className="ps2-modal-overlay" onClick={() => setDupOpen(false)}>
          <div className="ps2-modal ps2-dup-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ps2-dup-modal-head">
              <div className="ps2-modal-title" style={{ marginBottom: 0 }}>Review duplicates</div>
              <div style={{ fontSize: 12.5, color: "var(--ps2-muted)" }}>
                {dupIndex + 1} of {duplicates.length}
              </div>
            </div>
            <div className="ps2-dup-grid">
              <div className="ps2-dup-col">
                {currentDup.duplicateOfPhotoId && dupOriginal[currentDup.duplicateOfPhotoId] ? (
                  <div className="ps2-dup-thumb-fallback">{dupOriginal[currentDup.duplicateOfPhotoId]}</div>
                ) : (
                  <div className="ps2-dup-thumb-fallback">Loading…</div>
                )}
                <div className="ps2-dup-label">Original</div>
              </div>
              <div className="ps2-dup-col">
                {currentDup.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={currentDup.thumbnailUrl} alt={currentDup.originalFilename} className="ps2-dup-thumb" />
                ) : (
                  <div className="ps2-dup-thumb-fallback">{currentDup.originalFilename}</div>
                )}
                <div className="ps2-dup-label">
                  {currentDup.originalFilename} · matched by {currentDup.dedupMethod ?? "content"}
                </div>
              </div>
            </div>
            <div className="ps2-dup-actions">
              <button type="button" className="ps2-dup-keep-btn" disabled={dupBusy} onClick={keepOriginal}>
                Keep original, delete this copy
              </button>
              <button type="button" className="ps2-dup-keep-both-btn" disabled={dupBusy} onClick={keepBoth}>
                Keep both
              </button>
              <button type="button" className="ps2-tour-skip" onClick={() => setDupOpen(false)}>Finish later</button>
            </div>
          </div>
        </div>
      )}
    </Ps2Shell>
  );
}

// Storage donut — SVG stroke-dasharray ring per the handoff (r=74 →
// circumference ≈ 465).
function StorageRing({ stats, pct }: { stats: DashboardStats; pct: number }) {
  const CIRC = 2 * Math.PI * 74;
  return (
    <div className="ps2-storage-card" data-testid="dashboard-v2-storage">
      <div className="ps2-ring-wrap">
        <svg width="170" height="170" viewBox="0 0 170 170" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="85" cy="85" r="74" fill="none" stroke="color-mix(in oklab, var(--ps2-text) 10%, transparent)" strokeWidth="12" />
          <circle
            cx="85"
            cy="85"
            r="74"
            fill="none"
            stroke="url(#ps2Ring)"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - pct)}
            style={{ transition: "stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)" }}
          />
          <defs>
            <linearGradient id="ps2Ring" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--ps2-accent)" />
              <stop offset="100%" stopColor="#7fa8e8" />
            </linearGradient>
          </defs>
        </svg>
        <div className="ps2-ring-label">
          <div className="ps2-ring-value">{formatBytes(stats.storage.usedBytes)}</div>
          <div className="ps2-ring-sub">of {formatBytes(stats.storage.limitBytes)}</div>
        </div>
      </div>
      <div className="ps2-storage-legend">
        <span>
          <span className="ps2-legend-dot" style={{ background: "var(--ps2-accent)" }} />
          {formatCount(stats.totals.photoCount)} photos
        </span>
        <span>
          <span className="ps2-legend-dot" style={{ background: "#7fa8e8" }} />
          {Math.round(pct * 100)}% used
        </span>
      </div>
    </div>
  );
}
