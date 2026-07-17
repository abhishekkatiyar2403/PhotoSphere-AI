"use client";

// v2 Browse - masonry-feel grid over the same real endpoints the classic
// /browse + /organize pages use. "All" reuses searchApi.search({}) (a bare
// search returns the whole library, newest-first) rather than inventing a
// new endpoint. Matches the PhotoSphere design: 6-col dense grid with 2x2
// feature tiles on "All", panel-style chips, select mode with a fixed bulk
// bar (move/delete act immediately with a toast, like the design), and no
// visible pagination - more photos stream in as you scroll (the design has
// no pager UI).

import { Suspense, useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError, collectionsApi, Folder, FolderPhoto, folderPhotosApi, foldersApi, photosApi, searchApi, unfiledPhotosApi } from "@/lib/api";
import { PhotoViewerV2, type ViewerOrigin, type ViewerPhotoRef } from "@/components/v2/PhotoViewerV2";
import { useBulkPhotoActions } from "@/components/v2/useBulkPhotoActions";
import { SkeletonTiles } from "@/components/v2/SkeletonGrid";
import { usePullToRefresh } from "@/components/v2/usePullToRefresh";
import { PullToRefreshIndicator } from "@/components/v2/PullToRefreshIndicator";
import { useScrollReveal } from "@/components/v2/useScrollReveal";
import { useFavorites } from "@/components/v2/useFavorites";
import { useIsMobile } from "@/components/v2/useIsMobile";
import { isVideoFile } from "@/lib/v2/isVideoFile";

const PAGE_LIMIT = 24;
const UNFILED_CHIP = "__unfiled__";
const ALL_CHIP = "__all__";
const FAVORITES_CHIP = "__favorites__";
// Favorites has no backend filter to page through, so this pulls one large
// batch and filters client-side instead of paginating - fine for a personal
// library, not for tens of thousands of photos.
// Backend caps list limits at 100 (values above fail validation).
const FAVORITES_FETCH_LIMIT = 100;

type CardState = FolderPhoto & { duplicateOfLabel: string | null };

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// The design marks certain photos `big` (2x2 feature tiles, "All" chip,
// desktop only). The backend has no such flag, so mirror the design's
// density (3 of 18) with a deterministic every-6th pattern.
function isBigTile(index: number): boolean {
  return index % 6 === 0;
}

export default function BrowseV2Page() {
  return (
    <Suspense fallback={null}>
      <BrowseV2Inner />
    </Suspense>
  );
}

function BrowseV2Inner() {
  const searchParams = useSearchParams();
  const initialChip = searchParams.get("folder");
  const isMobile = useIsMobile();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [chip, setChip] = useState<string>(initialChip ?? ALL_CHIP);

  const [photos, setPhotos] = useState<CardState[]>([]);
  // "Newest first" is the server's real default order, so it needs no
  // client work. "By name" sorts the already-loaded list (real filenames,
  // no extra requests). "Oldest first" reverses the loaded newest-first
  // list - same approach as the design prototype, which also reverses its
  // in-memory list rather than doing a true global sort.
  const [sort, setSort] = useState<"newest" | "oldest" | "name">("newest");
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerOrigin, setViewerOrigin] = useState<ViewerOrigin | null>(null);

  const requestIdRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const { favoriteIds, isFavorite, toggleFavorite } = useFavorites();

  const loadPhotos = useCallback(async (activeChip: string, pageOffset: number, favIds: Set<string>, append = false) => {
    if (append) {
      if (loadingMoreRef.current) return;
      loadingMoreRef.current = true;
    } else {
      setLoading(true);
    }
    const requestId = ++requestIdRef.current;
    setError(null);
    try {
      if (activeChip === FAVORITES_CHIP) {
        const res = await searchApi.search({ limit: FAVORITES_FETCH_LIMIT, offset: 0 });
        if (requestId !== requestIdRef.current) return;
        const favorited = res.photos.filter((p) => favIds.has(p.id));
        setPhotos(favorited.map((p) => ({ ...p, duplicateOfLabel: null })));
        setTotal(favorited.length);
        setOffset(0);
        return;
      }
      const res =
        activeChip === ALL_CHIP
          ? await searchApi.search({ limit: PAGE_LIMIT, offset: pageOffset })
          : activeChip === UNFILED_CHIP
            ? await unfiledPhotosApi.list({ limit: PAGE_LIMIT, offset: pageOffset })
            : await folderPhotosApi.list(activeChip, { limit: PAGE_LIMIT, offset: pageOffset });
      if (requestId !== requestIdRef.current) return;
      const mapped = res.photos.map((p) => ({ ...p, duplicateOfLabel: null }));
      setPhotos((prev) => (append ? [...prev, ...mapped] : mapped));
      setTotal(res.total);
      setOffset(res.offset);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      if (isAuthError(err)) return;
      setError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      if (append) loadingMoreRef.current = false;
      if (!append && requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  const bulk = useBulkPhotoActions(() => loadPhotos(chip, 0, favoriteIds));
  const { pullY, refreshing, handlers } = usePullToRefresh(() => loadPhotos(chip, 0, favoriteIds));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const collectionsRes = await collectionsApi.list();
        if (cancelled) return;
        const defaultCollection = collectionsRes.collections.find((c) => c.isDefault) ?? collectionsRes.collections[0] ?? null;
        const foldersRes = defaultCollection ? await foldersApi.list(defaultCollection.id) : { folders: [] as Folder[] };
        if (cancelled) return;
        setFolders(foldersRes.folders);
      } catch {
        // The grid below still loads independently; folder chips just won't have real names.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    loadPhotos(chip, 0, favoriteIds);
    bulk.exitSelectMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chip, loadPhotos]);

  // Design has no pager - the grid just contains the library. Stream more
  // pages in silently as the user nears the bottom (no extra UI).
  const loadMoreRef = useRef<() => void>(() => {});
  loadMoreRef.current = () => {
    if (loading || chip === FAVORITES_CHIP) return;
    if (photos.length >= total) return;
    loadPhotos(chip, offset + PAGE_LIMIT, favoriteIds, true);
  };

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const gridVisible = !loading && !error && photos.length > 0;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "600px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [gridVisible]);

  function handleViewerDeleted(photoId: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    setViewerIndex(null);
    bulk.showToast("Moved to Trash");
  }

  // Design bulk bar acts immediately (no confirm modal) and reports via
  // toast - drive the same real endpoints directly.
  async function handleBulkMove(targetFolderId: string) {
    try {
      const res = await photosApi.bulkMove([...bulk.selectedIds], targetFolderId);
      bulk.showToast(`${res.moved.length} moved to "${res.folderName}"${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      bulk.exitSelectMode();
      loadPhotos(chip, 0, favoriteIds);
    } catch (err) {
      bulk.showToast(err instanceof Error ? err.message : "Failed to move photos");
    }
  }

  async function handleBulkDelete() {
    try {
      const res = await photosApi.bulkDelete([...bulk.selectedIds]);
      bulk.showToast(`${res.deleted.length} moved to Trash${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      bulk.exitSelectMode();
      loadPhotos(chip, 0, favoriteIds);
    } catch (err) {
      bulk.showToast(err instanceof Error ? err.message : "Failed to delete photos");
    }
  }

  const sortedPhotos =
    sort === "name"
      ? [...photos].sort((a, b) => a.originalFilename.localeCompare(b.originalFilename))
      : sort === "oldest"
        ? [...photos].reverse()
        : photos;

  // Derived from the same sorted order the grid renders, so a tile's index
  // and the viewer's arrow-key navigation stay in sync with what's on screen.
  const viewerPhotos: ViewerPhotoRef[] = sortedPhotos.map((p) => ({
    id: p.id,
    originalFilename: p.originalFilename,
    status: p.status,
    duplicateOfLabel: p.duplicateOfLabel,
    thumbSrc: p.thumbnailUrl,
  }));

  const chipEntries: { key: string; name: string }[] = [
    { key: ALL_CHIP, name: "All" },
    { key: FAVORITES_CHIP, name: "♥ Favorites" },
    ...folders.map((f) => ({ key: f.id, name: f.name })),
    { key: UNFILED_CHIP, name: "Unfiled" },
  ];

  const bigTiles = chip === ALL_CHIP && !isMobile;

  return (
    <div
      className="ps2-content"
      style={{ maxWidth: 1360, paddingTop: 30 }}
      onTouchStart={handlers.onTouchStart}
      onTouchMove={handlers.onTouchMove}
      onTouchEnd={handlers.onTouchEnd}
    >
      <style>{`.ps2x-browse-chip:hover{border-color:var(--ps2-accent)}`}</style>
      <div style={{ transform: pullY > 0 ? `translateY(${pullY}px)` : undefined }}>
        <PullToRefreshIndicator pullY={pullY} refreshing={refreshing} />
        <div className="ps2-browse-head">
          <h1 className="ps2-browse-title">Library</h1>
          <div className="ps2-browse-count">
            {sortedPhotos.length} of {total} photos
          </div>
          <div className="ps2-browse-actions">
            <select className="ps2-sort-select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">By name</option>
            </select>
            <button
              type="button"
              className={`ps2-select-toggle${bulk.selectMode ? " active" : ""}`}
              onClick={() => (bulk.selectMode ? bulk.exitSelectMode() : bulk.setSelectMode(true))}
            >
              {bulk.selectMode ? "Done" : "Select"}
            </button>
          </div>
        </div>

        <div className="ps2-chips">
          {chipEntries.map((entry) => {
            const active = chip === entry.key;
            return (
              <button
                key={entry.key}
                type="button"
                className="ps2x-browse-chip"
                onClick={() => setChip(entry.key)}
                style={{
                  borderRadius: 99,
                  padding: "8px 16px",
                  fontSize: 13,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  transition: "all .25s",
                  border: `1px solid ${active ? "var(--ps2-accent)" : "var(--ps2-border)"}`,
                  background: active ? "var(--ps2-accent)" : "var(--ps2-panel)",
                  color: active ? "#141118" : "var(--ps2-muted)",
                }}
              >
                {entry.name}
              </button>
            );
          })}
        </div>

        {loading && <SkeletonTiles count={PAGE_LIMIT} />}
        {error && !loading && <p className="ps2-error">{error}</p>}

        {!loading && !error && photos.length === 0 && <p className="ps2-loading">Nothing here yet.</p>}

        {!loading && !error && photos.length > 0 && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "repeat(2,1fr)" : "repeat(6,1fr)",
                gridAutoRows: 150,
                gridAutoFlow: "dense",
                gap: 12,
              }}
            >
              {sortedPhotos.map((photo, i) => (
                <BrowseTile
                  key={photo.id}
                  photo={photo}
                  big={bigTiles && isBigTile(i)}
                  selected={bulk.selectedIds.has(photo.id)}
                  selectMode={bulk.selectMode}
                  favorited={isFavorite(photo.id)}
                  onToggleFavorite={() => toggleFavorite(photo.id)}
                  onOpen={(e) => {
                    if (bulk.selectMode) {
                      bulk.toggleSelected(photo.id);
                      return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    setViewerOrigin({ rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }, src: photo.thumbnailUrl });
                    setViewerIndex(i);
                  }}
                />
              ))}
            </div>
            <div ref={sentinelRef} aria-hidden="true" />
          </>
        )}

        {bulk.selectedIds.size > 0 && (
          <div className="ps2-selectbar">
            <div className="ps2-selectbar-count">{bulk.selectedIds.size} selected</div>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) handleBulkMove(e.target.value);
              }}
            >
              <option value="">Move to…</option>
              {folders
                .filter((f) => f.id !== chip)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
            <button type="button" className="ps2-selectbar-btn" onClick={bulk.bulkDownload}>
              Download selected
            </button>
            <button type="button" className="ps2-selectbar-btn danger" onClick={handleBulkDelete}>
              Delete selected
            </button>
            <button type="button" className="ps2-selectbar-btn cancel" onClick={bulk.exitSelectMode}>
              Cancel
            </button>
          </div>
        )}

        {viewerIndex !== null && (
          <PhotoViewerV2
            photos={viewerPhotos}
            index={viewerIndex}
            origin={viewerOrigin}
            onIndexChange={setViewerIndex}
            onClose={() => {
              setViewerIndex(null);
              setViewerOrigin(null);
            }}
            onDeleted={handleViewerDeleted}
          />
        )}
      </div>
    </div>
  );
}

function BrowseTile({
  photo,
  big,
  selected,
  selectMode,
  favorited,
  onToggleFavorite,
  onOpen,
}: {
  photo: CardState;
  big: boolean;
  selected: boolean;
  selectMode: boolean;
  favorited: boolean;
  onToggleFavorite: () => void;
  onOpen: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  const { ref, revealed } = useScrollReveal<HTMLDivElement>();
  const span = big ? 2 : 1;
  const place = photo.aiLabels[0] ?? "";
  return (
    // div (not button) so the nested favorite button stays valid HTML,
    // matching the design's clickable-div tiles.
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      className={`ps2-browse-tile ps2-scroll-reveal${revealed ? " revealed" : ""}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          (e.currentTarget as HTMLDivElement).click();
        }
      }}
      style={{ gridColumn: `span ${span}`, gridRow: `span ${span}`, aspectRatio: "auto", height: "100%", cursor: "pointer" }}
    >
      {selectMode && (
        <span
          className={`ps2-browse-checkbox${selected ? " checked" : ""}`}
          style={
            selected
              ? undefined
              : { background: "rgba(10,11,16,.45)", borderColor: "rgba(255,255,255,.5)" }
          }
        >
          {selected && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#141118" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </span>
      )}
      <button
        type="button"
        className={`ps2-fav-btn${favorited ? " active" : ""}`}
        aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill={favorited ? "#e87f8f" : "none"} stroke={favorited ? "#e87f8f" : "#f4f5f8"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8Z" />
        </svg>
      </button>
      {!selectMode && isVideoFile(photo.originalFilename) && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10.5,
            color: "#f4f5f8",
            background: "rgba(10,11,16,.6)",
            backdropFilter: "blur(6px)",
            borderRadius: 99,
            padding: "3px 9px",
            zIndex: 4,
          }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="#f4f5f8">
            <path d="M8 5v14l11-7Z" />
          </svg>
        </span>
      )}
      {photo.thumbnailUrl && <img src={photo.thumbnailUrl} alt={photo.originalFilename} />}
      <span className="ps2-browse-tile-scrim" style={{ opacity: 0.9 }} />
      <span className="ps2-browse-tile-caption">
        <span className="ps2-browse-tile-title" style={{ fontSize: 13 }}>
          {photo.originalFilename}
        </span>
        {place && <span style={{ display: "block", fontSize: 11, opacity: 0.7 }}>{place}</span>}
      </span>
    </div>
  );
}
