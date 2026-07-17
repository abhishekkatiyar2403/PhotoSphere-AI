"use client";

// Search v2 — redesign handoff (README.md "Search", PhotoSphere.dc.html
// Search screen), living side-by-side with the classic /search page. Same
// data logic as src/app/search/page.tsx — auth gate, folder-dropdown load,
// draft/applied filter split, stale-response guard, pagination — restyled
// as the design's centered hero: serif headline, pill search bar with an
// accent submit, suggestion chips, and a 4-column results grid.
//
// Mapping notes vs the prototype:
// - The prototype's live-filter-on-keystroke is mock-only; the real backend
//   is an explicit GET /api/search, so this keeps the classic page's
//   Search-on-submit model (the README itself says to replace the live
//   filter with searchApi.search).
// - The prototype's free-text suggestion chips become the backend's real
//   SEARCH_CATEGORIES (a chip toggles that category and searches).
// - The classic page's extra filters (date range, folder) survive in a
//   compact "advanced" row under the bar — real functionality we don't drop.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  collectionsApi,
  Folder,
  FolderPhoto,
  foldersApi,
  SEARCH_CATEGORIES,
  SearchCategory,
  searchApi,
} from "@/lib/api";
import { PhotoViewer, ViewerPhotoRef } from "@/components/PhotoViewer";
import Ps2Shell from "@/components/ps2/Shell";

const PAGE_LIMIT = 12;

// Reserved literal the backend maps to folderId IS NULL (unfiled photos).
const UNFILED_FOLDER_VALUE = "unfiled";

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

type AppliedFilters = {
  q: string;
  from: string;
  to: string;
  folderId: string; // "" = all folders, "unfiled", or a real folder UUID
  category: SearchCategory | "";
};

const EMPTY_FILTERS: AppliedFilters = { q: "", from: "", to: "", folderId: "", category: "" };

export default function SearchV2Page() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  const [folders, setFolders] = useState<Folder[]>([]);

  // Draft (edit-in-the-bar) vs applied (drive the fetch) filters — same
  // split as the classic page.
  const [draftQ, setDraftQ] = useState("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [draftFolderId, setDraftFolderId] = useState("");
  const [draftCategory, setDraftCategory] = useState<SearchCategory | "">("");

  const [applied, setApplied] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [searched, setSearched] = useState(false);

  const [photos, setPhotos] = useState<FolderPhoto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // ---- Auth gate ----
  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  // ---- Folder dropdown source (best-effort, same as classic) ----
  useEffect(() => {
    if (checking || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await collectionsApi.list();
        if (cancelled) return;
        const defaultCollection = res.collections.find((c) => c.isDefault) ?? res.collections[0] ?? null;
        if (!defaultCollection) {
          setFolders([]);
          return;
        }
        const fRes = await foldersApi.list(defaultCollection.id);
        if (cancelled) return;
        setFolders(fRes.folders);
      } catch (err) {
        if (cancelled) return;
        if (isAuthError(err)) router.replace("/login");
        // Non-auth folder-load failure: dropdown stays All/Unfiled only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checking, user, router]);

  // ---- Results fetch on applied/offset change (stale-response guarded) ----
  useEffect(() => {
    if (checking || !user) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await searchApi.search({
          q: applied.q || undefined,
          from: applied.from || undefined,
          to: applied.to || undefined,
          folderId: applied.folderId || undefined,
          category: applied.category || undefined,
          limit: PAGE_LIMIT,
          offset,
        });
        if (cancelled) return;
        setPhotos(res.photos);
        setTotal(res.total);
        setSearched(true);
      } catch (err) {
        if (cancelled) return;
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Search failed");
        setPhotos([]);
        setTotal(0);
        setSearched(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checking, user, applied, offset, router]);

  const applyFilters = useCallback(() => {
    setApplied({
      q: draftQ.trim(),
      from: draftFrom,
      to: draftTo,
      folderId: draftFolderId,
      category: draftCategory,
    });
    setOffset(0);
  }, [draftQ, draftFrom, draftTo, draftFolderId, draftCategory]);

  const clearFilters = useCallback(() => {
    setDraftQ("");
    setDraftFrom("");
    setDraftTo("");
    setDraftFolderId("");
    setDraftCategory("");
    setApplied(EMPTY_FILTERS);
    setOffset(0);
  }, []);

  // Category chips toggle + search immediately (the design's one-tap
  // suggestion behavior), keeping the drafts in sync with what was applied.
  const pickCategory = useCallback(
    (c: SearchCategory) => {
      const next = draftCategory === c ? "" : c;
      setDraftCategory(next);
      setApplied({
        q: draftQ.trim(),
        from: draftFrom,
        to: draftTo,
        folderId: draftFolderId,
        category: next,
      });
      setOffset(0);
    },
    [draftQ, draftFrom, draftTo, draftFolderId, draftCategory],
  );

  const appliedSummary = useMemo(() => {
    const parts: string[] = [];
    if (applied.q) parts.push(`“${applied.q}”`);
    if (applied.category) parts.push(applied.category);
    if (applied.folderId === UNFILED_FOLDER_VALUE) parts.push("Unfiled");
    else if (applied.folderId) {
      const f = folders.find((x) => x.id === applied.folderId);
      if (f) parts.push(f.name);
    }
    if (applied.from || applied.to) {
      parts.push(`${applied.from || "…"} – ${applied.to || "…"}`);
    }
    return parts.join(" · ");
  }, [applied, folders]);

  const hasAppliedFilters =
    !!applied.q || !!applied.from || !!applied.to || !!applied.folderId || !!applied.category;

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_LIMIT, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_LIMIT < total;

  const viewerPhotos: ViewerPhotoRef[] = photos.map((p) => ({
    id: p.id,
    originalFilename: p.originalFilename,
    status: p.status,
    duplicateOfLabel: null,
  }));

  return (
    <Ps2Shell active="search" userName={user.name} classicHref="/search">
      <main className="ps2-search" data-testid="search-v2">
        <div className="ps2-search-hero">
          <div className="ps2-search-eyebrow">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.1 6.4L21 10l-6.4 2.1L12 19l-2.1-6.9L3 10l6.9-1.6L12 2z" /></svg>
            Library search
          </div>
          <h1 className="ps2-search-h1">Describe the photo you remember.</h1>

          <form
            className="ps2-search-bar"
            data-testid="search-filters"
            onSubmit={(e) => {
              e.preventDefault();
              applyFilters();
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ps2-muted)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              type="text"
              className="ps2-search-input"
              data-testid="search-filter-q"
              placeholder="Search by filename, e.g. brunch…"
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
              autoFocus
            />
            <button type="submit" className="ps2-search-submit" data-testid="search-submit">
              Search
            </button>
          </form>

          <div className="ps2-suggestion-row" data-testid="search-v2-categories">
            {SEARCH_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`ps2-suggestion${draftCategory === c ? " ps2-suggestion-active" : ""}`}
                data-testid={`search-category-${c}`}
                onClick={() => pickCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="ps2-search-advanced">
            <label className="ps2-field">
              <span className="ps2-field-label">From</span>
              <input
                type="date"
                className="ps2-input"
                data-testid="search-filter-from"
                value={draftFrom}
                max={draftTo || undefined}
                onChange={(e) => setDraftFrom(e.target.value)}
              />
            </label>
            <label className="ps2-field">
              <span className="ps2-field-label">To</span>
              <input
                type="date"
                className="ps2-input"
                data-testid="search-filter-to"
                value={draftTo}
                min={draftFrom || undefined}
                onChange={(e) => setDraftTo(e.target.value)}
              />
            </label>
            <label className="ps2-field">
              <span className="ps2-field-label">Folder</span>
              <select
                className="ps2-select"
                data-testid="search-filter-folder"
                value={draftFolderId}
                onChange={(e) => setDraftFolderId(e.target.value)}
              >
                <option value="">All folders</option>
                <option value={UNFILED_FOLDER_VALUE}>Unfiled</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="ps2-link-btn" data-testid="search-clear" onClick={clearFilters}>
              Clear all
            </button>
          </div>
        </div>

        {!loading && !error && (
          <div className="ps2-search-results-head" data-testid="search-results-head">
            {total} {total === 1 ? "result" : "results"}
            {appliedSummary ? ` for ${appliedSummary}` : hasAppliedFilters ? "" : " · Recently added"}
          </div>
        )}

        {loading && (
          <div className="ps2-loading" data-testid="search-loading">
            <span className="ps2-spinner" aria-hidden="true" />
            Searching…
          </div>
        )}

        {error && !loading && (
          <p className="ps2-error" data-testid="search-error">
            {error}
          </p>
        )}

        {!loading && !error && photos.length === 0 && (
          <div className="ps2-empty" data-testid="search-empty">
            {searched && hasAppliedFilters ? (
              <>
                <div className="ps2-empty-title">No photos match those filters.</div>
                <div>Try a shorter filename, a wider date range, or clearing the folder/category filter.</div>
              </>
            ) : (
              <>
                <div className="ps2-empty-title">No photos yet.</div>
                <div>Upload some photos, then search across your whole library here.</div>
              </>
            )}
          </div>
        )}

        {!loading && !error && photos.length > 0 && (
          <>
            <div className="ps2-results-grid" data-testid="search-grid">
              {photos.map((photo, i) => (
                <ResultTile key={photo.id} photo={photo} onOpen={() => setViewerIndex(i)} />
              ))}
            </div>

            <div className="ps2-pagination">
              <button
                type="button"
                className="ps2-page-btn"
                onClick={() => hasPrev && setOffset((o) => Math.max(0, o - PAGE_LIMIT))}
                disabled={!hasPrev}
              >
                ‹ Prev
              </button>
              <button
                type="button"
                className="ps2-page-btn"
                onClick={() => hasNext && setOffset((o) => o + PAGE_LIMIT)}
                disabled={!hasNext}
              >
                Next ›
              </button>
              <span className="ps2-page-range" data-testid="search-range">
                Showing {rangeStart}–{rangeEnd} of {total}
              </span>
            </div>
          </>
        )}
      </main>

      {viewerIndex !== null && (
        <PhotoViewer
          photos={viewerPhotos}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </Ps2Shell>
  );
}

// 4:3 result tile — same scrim-caption language as the Browse v2 masonry
// tile (first AI label as the design's tag pill, filename as the title).
function ResultTile({ photo, onOpen }: { photo: FolderPhoto; onOpen: () => void }) {
  const sub =
    photo.status === "duplicate"
      ? "duplicate"
      : photo.status === "failed"
        ? "classification failed"
        : photo.aiLabels.length > 0
          ? photo.aiLabels.join(", ")
          : "";

  return (
    <button
      type="button"
      className="ps2-photo-tile ps2-result-tile"
      data-testid={`photo-card-${photo.id}`}
      data-status={photo.status}
      onClick={onOpen}
    >
      {photo.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo.thumbnailUrl} alt={photo.originalFilename} />
      ) : (
        <span className="ps2-photo-tile-fallback">no preview</span>
      )}
      <span className="ps2-tile-scrim" aria-hidden="true" />
      {(photo.status === "failed" || photo.status === "duplicate") && (
        <span className="ps2-tile-badge">{photo.status}</span>
      )}
      <span className="ps2-tile-caption">
        <span className="ps2-tile-title">{photo.originalFilename}</span>
        {sub && <span className="ps2-tile-sub">{sub}</span>}
      </span>
    </button>
  );
}
