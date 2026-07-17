"use client";

// Search page (specs/folder-mgmt-download-search.md PART P6,
// design/wireframes/search.svg - Option A: a dedicated /search page with its
// own top-bar entry). A filter bar (filename text, from/to date, folder
// dropdown, category dropdown) + Search/Clear over the existing photo-card grid
// + the shared PhotoViewer, with pagination and loading/empty/error states.
//
// Owner-only, authed - same client-side gate pattern as
// /activity/dashboard/organize (authApi.me() on mount -> /login on 401). Filter
// state is LOCAL component state (not URL params, matching /activity), so no
// useSearchParams / Suspense boundary is needed.
//
// Backend GET /api/search is owner-scoped, leak-proof (Tester-verified 208
// assertions clean): every query starts from the caller's ownerId. An empty
// search returns the whole library newest-first (S6). folderId accepts a real
// UUID, the "unfiled" literal, or is omitted for all folders; category is one
// of the 8 known values matched against the owner's own folder names (S1).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import UiV2Banner from "@/components/UiV2Banner";

const PAGE_LIMIT = 12;

// The reserved literal the backend maps to folderId IS NULL (unfiled photos).
// Kept in sync with UNFILED_FOLDER_LITERAL in the backend's validation schema.
const UNFILED_FOLDER_VALUE = "unfiled";

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// The applied filter set that drives a fetch. Kept distinct from the draft
// inputs so typing a filter doesn't refetch until Search is clicked (matching
// the wireframe's explicit Search button + /activity's draft/applied split).
type AppliedFilters = {
  q: string;
  from: string;
  to: string;
  folderId: string; // "" = all folders, "unfiled", or a real folder UUID
  category: SearchCategory | "";
};

const EMPTY_FILTERS: AppliedFilters = { q: "", from: "", to: "", folderId: "", category: "" };

export default function SearchPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  // Folder dropdown source (the owner's own folders + "All" + "Unfiled").
  const [folders, setFolders] = useState<Folder[]>([]);

  // Draft (edit-in-the-bar) vs applied (drive the fetch) filters.
  const [draftQ, setDraftQ] = useState("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [draftFolderId, setDraftFolderId] = useState("");
  const [draftCategory, setDraftCategory] = useState<SearchCategory | "">("");

  const [applied, setApplied] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  // `searched` gates the empty-state copy: before the first Search we don't
  // want to imply "no photos match" for a query the user never ran. The first
  // applied fetch (initial mount included) flips this true.
  const [searched, setSearched] = useState(false);

  const [photos, setPhotos] = useState<FolderPhoto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // ---- Auth gate (same pattern as /activity, /dashboard, /organize) ----
  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  // ---- Load the owner's folders for the folder dropdown (best-effort). A
  // brand-new user with no collection yet just gets an empty folder list; the
  // dropdown still offers All + Unfiled. Not fatal to search itself. ----
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
        // Non-auth folder-load failure: leave the dropdown at All/Unfiled only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checking, user, router]);

  // ---- Results fetch, re-run when APPLIED filters or offset change. Guarded
  // with a `cancelled` flag so a slow response can't clobber a newer one (same
  // stale-response guard as /activity). ----
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
    setOffset(0); // any filter change resets to the first page
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

  async function handleLogout() {
    await authApi.logout();
    router.replace("/login");
  }

  // A one-line human summary of the applied filters for the results header.
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
    <main className="search-page">
      <div className="organize-topbar">
        <h1>
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="search-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Search
        </h1>
        <div className="dashboard-topbar-right">
          <UiV2Banner href="/search/v2" />
          <Link href="/upload" className="dashboard-guests-link" data-testid="search-upload-link">
            Upload
          </Link>
          <Link href="/organize" className="dashboard-guests-link" data-testid="search-organize-link">
            Organize
          </Link>
          <Link href="/browse" className="dashboard-guests-link" data-testid="search-browse-link">
            Browse
          </Link>
          <Link
            href="/search"
            className="dashboard-guests-link activity-nav-active"
            aria-current="page"
            data-testid="search-nav-link"
          >
            Search
          </Link>
          <Link href="/guests" className="dashboard-guests-link" data-testid="search-guests-link">
            Guests
          </Link>
          <Link href="/activity" className="dashboard-guests-link" data-testid="search-activity-link">
            Activity
          </Link>
          <Link href="/trash" className="dashboard-guests-link" data-testid="search-trash-link">
            Trash
          </Link>
          <Link href="/settings" className="dashboard-guests-link" data-testid="search-settings-link">
            Settings
          </Link>
          <span>{user.name}</span>
          <button type="button" className="dashboard-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>

      <div className="search-content">
        <div className="activity-head">
          <h2>Search your photos</h2>
          <span className="activity-head-sub">filename, date, folder, category</span>
        </div>

        {/* Filter bar */}
        <form
          className="activity-filters"
          data-testid="search-filters"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <label className="activity-filter-field">
            <span className="activity-filter-label">FILENAME</span>
            <input
              type="text"
              className="activity-date search-filename-input"
              data-testid="search-filter-q"
              placeholder="e.g. brunch"
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
            />
          </label>

          <label className="activity-filter-field">
            <span className="activity-filter-label">FROM</span>
            <input
              type="date"
              className="activity-date"
              data-testid="search-filter-from"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(e) => setDraftFrom(e.target.value)}
            />
          </label>

          <label className="activity-filter-field">
            <span className="activity-filter-label">TO</span>
            <input
              type="date"
              className="activity-date"
              data-testid="search-filter-to"
              value={draftTo}
              min={draftFrom || undefined}
              onChange={(e) => setDraftTo(e.target.value)}
            />
          </label>

          <label className="activity-filter-field">
            <span className="activity-filter-label">FOLDER</span>
            <select
              className="activity-select"
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

          <label className="activity-filter-field">
            <span className="activity-filter-label">CATEGORY</span>
            <select
              className="activity-select"
              data-testid="search-filter-category"
              value={draftCategory}
              onChange={(e) => setDraftCategory(e.target.value as SearchCategory | "")}
            >
              <option value="">Any category</option>
              {SEARCH_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" className="activity-apply" data-testid="search-submit">
            Search
          </button>
          <button
            type="button"
            className="search-clear"
            data-testid="search-clear"
            onClick={clearFilters}
          >
            Clear
          </button>
        </form>

        {/* Results header */}
        {!loading && !error && (
          <div className="search-results-head" data-testid="search-results-head">
            <span className="search-results-count">
              {total} {total === 1 ? "result" : "results"}
            </span>
            {appliedSummary && <span className="activity-head-sub">for {appliedSummary}</span>}
          </div>
        )}

        {/* States */}
        {loading && (
          <p className="organize-empty" data-testid="search-loading">
            Searching…
          </p>
        )}

        {error && !loading && (
          <p className="share-error" data-testid="search-error">
            {error}
          </p>
        )}

        {!loading && !error && photos.length === 0 && (
          <div className="search-empty" data-testid="search-empty">
            {searched && hasAppliedFilters ? (
              <>
                <p className="search-empty-title">No photos match those filters</p>
                <p className="search-empty-sub">
                  Try a shorter filename, a wider date range, or clearing the folder/category filter.
                </p>
              </>
            ) : (
              <>
                <p className="search-empty-title">No photos yet</p>
                <p className="search-empty-sub">Upload some photos, then search across your whole library here.</p>
              </>
            )}
          </div>
        )}

        {!loading && !error && photos.length > 0 && (
          <>
            <div className="organize-grid" data-testid="search-grid">
              {photos.map((photo, i) => (
                <SearchResultCard key={photo.id} photo={photo} onOpen={() => setViewerIndex(i)} />
              ))}
            </div>

            <div className="organize-pagination">
              <button type="button" onClick={() => hasPrev && setOffset((o) => Math.max(0, o - PAGE_LIMIT))} disabled={!hasPrev}>
                ‹ Prev
              </button>
              <button type="button" onClick={() => hasNext && setOffset((o) => o + PAGE_LIMIT)} disabled={!hasNext}>
                Next ›
              </button>
              <span data-testid="search-range">
                Showing {rangeStart}–{rangeEnd} of {total}
              </span>
            </div>
          </>
        )}
      </div>

      {viewerIndex !== null && (
        <PhotoViewer
          photos={viewerPhotos}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </main>
  );
}

// Read-only result card - same visual language as /browse's card (reuses the
// .organize-card classes), no per-card actions. Clicking the thumbnail opens
// the shared PhotoViewer.
function SearchResultCard({ photo, onOpen }: { photo: FolderPhoto; onOpen: () => void }) {
  const cardClass =
    photo.status === "failed"
      ? "organize-card failed"
      : photo.status === "duplicate"
        ? "organize-card duplicate"
        : "organize-card";

  return (
    <div className={cardClass} data-testid={`photo-card-${photo.id}`} data-status={photo.status}>
      <button
        type="button"
        className="organize-card-thumb"
        data-testid={`photo-thumb-${photo.id}`}
        onClick={onOpen}
        style={{ border: "none", padding: 0, cursor: "pointer" }}
      >
        {photo.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo.thumbnailUrl} alt={photo.originalFilename} />
        ) : photo.status === "failed" ? (
          "failed"
        ) : photo.status === "duplicate" ? (
          "duplicate"
        ) : (
          "no preview"
        )}
      </button>

      <p className="organize-card-filename">{photo.originalFilename}</p>

      {photo.status === "failed" && <p className="organize-card-meta">classification failed</p>}
      {photo.status === "duplicate" && <p className="organize-card-meta">duplicate</p>}
      {photo.status !== "failed" && photo.status !== "duplicate" && (
        <p className="organize-card-meta">
          {photo.aiLabels.length > 0 ? photo.aiLabels.join(", ") : " "}
          {photo.aiConfidence != null ? ` · ${photo.aiConfidence.toFixed(2)}` : ""}
        </p>
      )}
    </div>
  );
}
