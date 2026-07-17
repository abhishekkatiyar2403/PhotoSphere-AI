"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ApiError,
  collectionsApi,
  dashboardApi,
  DashboardStats,
  Folder,
  foldersApi,
  folderPhotosApi,
  unfiledPhotosApi,
  searchApi,
  FolderPhoto,
} from "@/lib/api";
import { usePs2User } from "@/components/v2/Ps2UserContext";
import { FolderCovers } from "@/components/v2/FolderCovers";
import { SkeletonTiles } from "@/components/v2/SkeletonGrid";
import { usePullToRefresh } from "@/components/v2/usePullToRefresh";
import { PullToRefreshIndicator } from "@/components/v2/PullToRefreshIndicator";
import { DuplicateReviewModalV2 } from "@/components/v2/DuplicateReviewModalV2";
import { formatBytes, formatCount } from "@/lib/v2/format";

// Duplicate scan shares the same real duplicate-detection fields Organize
// already reads (status === "duplicate", duplicateOfPhotoId, dedupMethod) -
// scanned from the unfiled list since that's where duplicate-status photos
// live before they're reclassified. Bounded to one batch, same
// accepted-cost pattern as Favorites/Places.
// Backend caps list limits at 100 (values above fail validation).
const DUPLICATE_SCAN_LIMIT = 100;

// The photo-card list response carries no fileSize (see
// src/lib/v2/featureFlags.ts `sortByDateSize` - backend-pending), so the
// "could free X" figure uses a flat per-photo estimate. 6 MB matches the
// design's demo math (82 MB across 14 near-duplicates).
const ESTIMATED_DUPLICATE_BYTES = 6 * 1024 * 1024;

// "Curated for you" AI auto-albums: no backend endpoint exists yet (same
// backend-pending posture as src/lib/v2/featureFlags.ts). Until it ships,
// the three stories are fixed local content matching the design, with
// covers served from bundled assets.
const CURATED_ALBUMS = [
  { title: "Golden Hours", sub: "42 photos · auto-album", src: "/v2/photos/07-crimson-dawn.png", delay: 0.2 },
  { title: "Northern Coastlines", sub: "28 photos · auto-album", src: "/v2/photos/13-sapphire-bay.png", delay: 0.28 },
  { title: "After Dark", sub: "17 photos · auto-album", src: "/v2/photos/06-indigo-night.png", delay: 0.36 },
] as const;

type FolderCard = { folder: Folder; covers: (string | null)[] };

function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// Gigabyte figure formatted the way the design renders storage numbers:
// one decimal ("68.4", "7.2"), trimmed when whole ("200").
function gb(bytes: number): string {
  const value = Math.round((bytes / 1024 ** 3) * 10) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// "On this day" has no dedicated endpoint - searchApi.search already
// supports a from/to date range (see api.ts), so this just computes the
// same calendar day one year ago (with a 1-day pad either side, since
// photos are rarely taken at the exact same instant) and reuses it.
function memoriesRange(): { from: string; to: string; date: Date } {
  const today = new Date();
  const target = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
  const from = new Date(target);
  from.setDate(from.getDate() - 1);
  const to = new Date(target);
  to.setDate(to.getDate() + 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to), date: target };
}

// Cursor-tracking 3D tilt for the album cards - same effect the design's
// data-tilt="1" attribute wires up in its support script.
function tiltHandlers() {
  return {
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      el.style.transition = "box-shadow .3s";
      el.style.transform = `translateY(-6px) scale(1.02) rotateX(${(-py * 16).toFixed(2)}deg) rotateY(${(px * 16).toFixed(2)}deg)`;
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.transition = "transform .45s cubic-bezier(.2,.8,.2,1), box-shadow .3s";
      e.currentTarget.style.transform = "";
    },
  };
}

export default function DashboardV2Page() {
  const router = useRouter();
  const user = usePs2User();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [ringFilled, setRingFilled] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [folderCards, setFolderCards] = useState<FolderCard[]>([]);
  const [recent, setRecent] = useState<FolderPhoto[]>([]);
  const [memories, setMemories] = useState<FolderPhoto[]>([]);
  const [memoriesDate, setMemoriesDate] = useState<Date | null>(null);
  const [duplicates, setDuplicates] = useState<FolderPhoto[]>([]);
  const [reviewingDuplicates, setReviewingDuplicates] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadDashboard = useCallback(
    async (showSpinner: boolean) => {
      const requestId = ++requestIdRef.current;
      if (showSpinner) setLoading(true);
      setError(null);
      try {
        const { from, to, date } = memoriesRange();
        const [statsRes, collectionsRes, recentRes, memoriesRes, duplicateScanRes] = await Promise.all([
          dashboardApi.get(),
          collectionsApi.list(),
          searchApi.search({ limit: 8 }),
          searchApi.search({ from, to, limit: 3 }),
          unfiledPhotosApi.list({ limit: DUPLICATE_SCAN_LIMIT, offset: 0 }),
        ]);
        if (requestId !== requestIdRef.current) return;

        setStats(statsRes);
        setRecent(recentRes.photos);
        setMemories(memoriesRes.photos);
        setMemoriesDate(date);
        setDuplicates(duplicateScanRes.photos.filter((p) => p.status === "duplicate" && p.duplicateOfPhotoId));

        const defaultCollection =
          collectionsRes.collections.find((c) => c.isDefault) ?? collectionsRes.collections[0] ?? null;

        if (defaultCollection) {
          const foldersRes = await foldersApi.list(defaultCollection.id);
          if (requestId !== requestIdRef.current) return;

          const cards = await Promise.all(
            foldersRes.folders.map(async (folder): Promise<FolderCard> => {
              if (folder.photoCount === 0) return { folder, covers: [null, null, null] };
              const photosRes = await folderPhotosApi.list(folder.id, { limit: 3, offset: 0 });
              return { folder, covers: [0, 1, 2].map((i) => photosRes.photos[i]?.thumbnailUrl ?? null) };
            }),
          );
          if (requestId !== requestIdRef.current) return;
          setFolderCards(cards);
        } else {
          setFolderCards([]);
        }
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/v2/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    loadDashboard(true);
  }, [loadDashboard]);

  const { pullY, refreshing, handlers } = usePullToRefresh(() => loadDashboard(false));

  // Ring starts empty and sweeps to the real value on load - a `requestAnimationFrame`
  // (rather than firing in the same tick) guarantees the browser paints the
  // 0% state first, so the CSS transition on .ps2-ring-fill actually plays.
  useEffect(() => {
    if (!stats) return;
    const raf = requestAnimationFrame(() => setRingFilled(true));
    return () => cancelAnimationFrame(raf);
  }, [stats]);

  if (loading) {
    return (
      <div className="ps2-content">
        <div className="ps2-skeleton" style={{ width: 220, height: 14, marginBottom: 10 }} />
        <div className="ps2-skeleton" style={{ width: 420, height: 40, marginBottom: 30 }} />
        <div className="ps2-hero-row">
          <div className="ps2-skeleton" style={{ height: 260, borderRadius: 20 }} />
          <div className="ps2-skeleton" style={{ height: 260, borderRadius: 20 }} />
        </div>
        <div className="ps2-section">
          <SkeletonTiles count={6} />
        </div>
      </div>
    );
  }
  if (error) return <p className="ps2-error">{error}</p>;
  if (!stats) return null;

  const pct = Math.max(0, Math.min(1, Number.isFinite(stats.storage.usedPercent) ? stats.storage.usedPercent : 0));
  const radius = 74;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = ringFilled ? circumference * (1 - pct) : circumference;
  const now = new Date();
  const firstName = user.name.split(" ")[0] || user.name;

  const usedBytes = Number(stats.storage.usedBytes) || 0;
  const limitBytes = Number(stats.storage.limitBytes) || 0;
  // Media-type breakdown isn't in the dashboard response, and the upload
  // pipeline only accepts images today (see src/lib/v2/featureFlags.ts
  // `videoPlayback`) - so Photos carries the full usage and Video/Trash are
  // real zeros until the backend splits them out.
  const photosBytes = usedBytes;
  const videoBytes = 0;
  const trashBytes = 0;
  const freeBytes = Math.max(0, limitBytes - usedBytes);
  const barPct = (bytes: number) => (limitBytes > 0 ? Math.min(100, (bytes / limitBytes) * 100) : 0);

  const breakdownRows: { label: string; bytes: number; color: string }[] = [
    { label: "Photos", bytes: photosBytes, color: "var(--ps2-accent)" },
    { label: "Videos", bytes: videoBytes, color: "var(--ps2-purple)" },
    { label: "Trash", bytes: trashBytes, color: "#e87f8f" },
  ];

  return (
    <div
      className="ps2-content"
      onTouchStart={handlers.onTouchStart}
      onTouchMove={handlers.onTouchMove}
      onTouchEnd={handlers.onTouchEnd}
      style={{ transform: pullY > 0 ? `translateY(${pullY}px)` : undefined }}
    >
      {/* Design-exact layout bits the shared stylesheet doesn't cover:
          320px storage column and the 3-up album grid (1-col on mobile). */}
      <style>{`
        .ps2-hero-row.ps2-dash-hero{grid-template-columns:320px 1fr}
        @media (max-width:900px){.ps2-hero-row.ps2-dash-hero{grid-template-columns:1fr}}
        .ps2-dash-albums-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;flex:1;perspective:900px}
        @media (max-width:900px){.ps2-dash-albums-grid{grid-template-columns:1fr}}
        .ps2-dash-album-card{position:relative;border-radius:18px;overflow:hidden;cursor:pointer;min-height:190px;will-change:transform;display:block;transition:transform .3s cubic-bezier(.2,.8,.2,1),box-shadow .3s}
        .ps2-dash-album-card:hover{box-shadow:var(--ps2-shadow)}
      `}</style>
      <PullToRefreshIndicator pullY={pullY} refreshing={refreshing} />
      <div style={{ animation: "ps2Up .7s cubic-bezier(.2,.8,.2,1) both" }}>
        <div className="ps2-dash-greeting-date">{now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
        <h1 className="ps2-dash-greeting-h1">
          {greetingForHour(now.getHours())}, {firstName}{" "}
          <span className="ps2-dash-greeting-accent">
            — {formatCount(stats.totals.photoCount)} {stats.totals.photoCount === 1 ? "memory" : "memories"} safe.
          </span>
        </h1>
      </div>

      <div className="ps2-hero-row ps2-dash-hero">
        <div className="ps2-storage-card" style={{ animation: "ps2In .7s cubic-bezier(.2,.8,.2,1) both .1s" }}>
          <div
            className="ps2-ring-wrap"
            title="Storage breakdown"
            onClick={() => setStorageOpen((open) => !open)}
            style={{ cursor: "pointer" }}
          >
            <svg width="170" height="170" viewBox="0 0 170 170" style={{ transform: "rotate(-90deg)" }}>
              <circle cx="85" cy="85" r={radius} fill="none" stroke="color-mix(in oklab, var(--ps2-text) 10%, transparent)" strokeWidth="12" />
              <circle
                className="ps2-ring-fill"
                cx="85"
                cy="85"
                r={radius}
                fill="none"
                stroke="url(#ps2DashRing)"
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
              />
              <defs>
                <linearGradient id="ps2DashRing" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--ps2-accent)" />
                  <stop offset="100%" stopColor="var(--ps2-purple)" />
                </linearGradient>
              </defs>
            </svg>
            <div className="ps2-ring-center">
              <div className="ps2-ring-value" style={{ fontSize: 38 }}>{gb(usedBytes)}</div>
              <div className="ps2-ring-sub">GB of {gb(limitBytes)}</div>
            </div>
          </div>
          <div className="ps2-legend">
            <span>
              <span className="ps2-legend-dot" style={{ background: "var(--ps2-accent)" }} />
              Photos {gb(photosBytes)}
            </span>
            <span>
              <span className="ps2-legend-dot" style={{ background: "var(--ps2-purple)" }} />
              Video {gb(videoBytes)}
            </span>
          </div>
          {storageOpen && (
            <div style={{ width: "100%", marginTop: 18, display: "flex", flexDirection: "column", gap: 11, animation: "ps2Up .3s both" }}>
              {breakdownRows.map((row) => (
                <div key={row.label}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                    <span>{row.label}</span>
                    <span style={{ color: "var(--ps2-muted)" }}>{gb(row.bytes)} GB</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 99, background: "color-mix(in oklab, var(--ps2-text) 8%, transparent)" }}>
                    <div style={{ width: `${barPct(row.bytes)}%`, height: "100%", borderRadius: 99, background: row.color }} />
                  </div>
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: "var(--ps2-muted)" }}>{gb(freeBytes)} GB free · click ring to hide</div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, animation: "ps2Up .7s both .15s" }}>
            <div style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="var(--ps2-accent)">
                <path d="M12 2l2.1 6.4L21 10l-6.4 2.1L12 19l-2.1-6.9L3 10l6.9-1.6L12 2z" />
              </svg>
              Curated for you
            </div>
            <div style={{ fontSize: 12.5, color: "var(--ps2-muted)" }}>PhotoSphere AI grouped this week&apos;s uploads into three stories</div>
          </div>
          <div className="ps2-dash-albums-grid">
            {CURATED_ALBUMS.map((album) => (
              <Link
                key={album.title}
                href="/v2/browse"
                className="ps2-dash-album-card"
                style={{ animation: `ps2In .7s both ${album.delay}s` }}
                {...tiltHandlers()}
              >
                <img src={album.src} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, transparent 30%, rgba(6,7,12,.85))" }} />
                <div style={{ position: "absolute", left: 16, bottom: 14, color: "#f4f5f8" }}>
                  <div style={{ fontFamily: "var(--ps2-font-serif)", fontStyle: "italic", fontSize: 21 }}>{album.title}</div>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>{album.sub}</div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {memories.length > 0 && memoriesDate && (
        <div className="ps2-memories-card" style={{ animation: "ps2In .7s both .25s" }}>
          <div className="ps2-memories-text">
            <div className="ps2-memories-eyebrow">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--ps2-accent)">
                <path d="M12 2l2.1 6.4L21 10l-6.4 2.1L12 19l-2.1-6.9L3 10l6.9-1.6L12 2z" />
              </svg>
              Memories
            </div>
            <div className="ps2-memories-title">On this day, one year ago.</div>
            <div className="ps2-memories-sub">
              {memoriesDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} · your library
            </div>
          </div>
          <div className="ps2-memories-photos">
            {memories.map((p) => (
              <Link key={p.id} href="/v2/browse" className="ps2-memories-photo">
                {p.thumbnailUrl && <img src={p.thumbnailUrl} alt={p.originalFilename} />}
              </Link>
            ))}
          </div>
        </div>
      )}

      {duplicates.length > 0 && (
        <div className="ps2-dup-card" style={{ animation: "ps2In .7s both .3s" }}>
          <div className="ps2-dup-card-icon">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="8" y="8" width="12" height="12" rx="2.5" />
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </svg>
          </div>
          <div className="ps2-dup-card-text">
            <div className="ps2-dup-card-title">
              PhotoSphere AI found {formatCount(duplicates.length)} near-duplicate{duplicates.length === 1 ? "" : "s"}
            </div>
            <div className="ps2-dup-card-sub">
              Reviewing them could free {formatBytes(duplicates.length * ESTIMATED_DUPLICATE_BYTES)}
            </div>
          </div>
          <button type="button" className="ps2-select-toggle" onClick={() => setReviewingDuplicates(true)}>
            Review
          </button>
        </div>
      )}

      {recent.length > 0 && (
        <section className="ps2-section" style={{ animation: "ps2Up .7s both .3s" }}>
          <div className="ps2-section-head">
            <div className="ps2-section-title">Recent uploads</div>
            <Link href="/v2/browse" style={{ fontSize: 13 }}>
              View library →
            </Link>
          </div>
          <div className="ps2-recents-grid">
            {recent.map((p) => (
              <Link key={p.id} href="/v2/browse" className="ps2-recent-tile">
                {p.thumbnailUrl && <img src={p.thumbnailUrl} alt={p.originalFilename} />}
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="ps2-section" style={{ animation: "ps2Up .7s both .4s" }}>
        <div className="ps2-section-head">
          <div className="ps2-section-title">Folders</div>
        </div>
        <div className="ps2-folders-grid">
          {folderCards.map(({ folder, covers }) => (
            <Link key={folder.id} href={`/v2/browse?folder=${encodeURIComponent(folder.id)}`} className="ps2-folder-card">
              <FolderCovers covers={covers} />
              <div className="ps2-folder-name">{folder.name}</div>
              <div className="ps2-folder-count">{formatCount(folder.photoCount)} photos</div>
            </Link>
          ))}
        </div>
      </section>

      {reviewingDuplicates && (
        <DuplicateReviewModalV2
          duplicates={duplicates}
          onClose={() => setReviewingDuplicates(false)}
          onResolved={(removedId) => setDuplicates((prev) => prev.filter((p) => p.id !== removedId))}
        />
      )}
    </div>
  );
}
