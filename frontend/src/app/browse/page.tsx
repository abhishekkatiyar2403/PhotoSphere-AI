"use client";

// Folder browser (specs/week7-8-dashboard-browser-viewer.md "Folder
// browser") - a read-only subset of /organize's sidebar+grid pattern
// (design/wireframes/reclassify-ui.svg, Option A), reusing its CSS classes
// wholesale (.organize-shell/.organize-sidebar/.organize-grid/etc. from
// globals.css) since this is a visual subset of the same design, not a new
// visual language.
//
// Deliberately a new route rather than a "read-only mode" flag threaded
// through /organize - see the spec's "Folder browser: route/mode decision"
// for the full reasoning. This page has none of /organize's mutation state
// (no moving/reclassifying/actionError per card, no poll timers, no inline
// folder-creation form) - just fetch + paginate + render, plus opening the
// shared PhotoViewer on thumbnail click.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ApiError,
  authApi,
  collectionsApi,
  downloadAllApi,
  Folder,
  FolderPhoto,
  folderPhotosApi,
  foldersApi,
  photosApi,
  unfiledPhotosApi,
} from "@/lib/api";
import { PhotoViewer, ViewerPhotoRef } from "@/components/PhotoViewer";
import UiV2Banner from "@/components/UiV2Banner";

const PAGE_LIMIT = 12;

// Same sentinel-id convention as /organize - never a real folder id (Folder
// rows are UUIDs) - so it can share selectedFolderId state/rendering with
// real folders unambiguously.
const UNFILED_FOLDER_ID = "__unfiled__";

type CardState = FolderPhoto & {
  duplicateOfLabel: string | null;
};

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// useSearchParams() must sit inside a Suspense boundary in the Next 14 App
// Router (it opts the subtree into client-side rendering), so the page shell
// wraps the real component in <Suspense>.
export default function BrowsePage() {
  return (
    <Suspense fallback={null}>
      <BrowsePageInner />
    </Suspense>
  );
}

function BrowsePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Optional deep-link target from the Dashboard's folder tiles
  // (/browse?folder=<id>, or ?folder=__unfiled__ for the Unfiled bucket).
  // Applied once, after the initial folder/collection load resolves - see the
  // initial-load effect. Absent -> default to the first folder as before.
  const initialFolderId = searchParams.get("folder");
  const [checking, setChecking] = useState(true);

  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [unfiledCount, setUnfiledCount] = useState(0);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [foldersError, setFoldersError] = useState<string | null>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<CardState[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);

  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // Stale-fetch guard - a user can click between folders quickly, same
  // pattern /organize uses for its grid fetch.
  const gridRequestIdRef = useRef(0);

  // ---- Auth gate (same pattern as /organize/dashboard/upload) ----
  useEffect(() => {
    authApi
      .me()
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  const loadFolders = useCallback(async (cId: string | null) => {
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const [foldersRes, unfiledRes] = await Promise.all([
        cId ? foldersApi.list(cId) : Promise.resolve({ folders: [] as Folder[] }),
        unfiledPhotosApi.list({ limit: 1, offset: 0 }), // limit 1 - only `total` needed for the sidebar count
      ]);
      setFolders(foldersRes.folders);
      setUnfiledCount(unfiledRes.total);
      return foldersRes.folders;
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return [];
      }
      setFoldersError(err instanceof Error ? err.message : "Failed to load folders");
      return [];
    } finally {
      setFoldersLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Initial load: default collection (if any) + its folders, plus the
  // Unfiled count regardless of whether a collection exists yet (the same
  // brand-new-user-first-upload-fails scenario /organize's 07:31 bug fix
  // covers - this page is built against the already-fixed user-scoped
  // GET /api/photos/unfiled from day one, so the bug can't recur here). ----
  useEffect(() => {
    if (checking) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await collectionsApi.list();
        if (cancelled) return;
        const defaultCollection = res.collections.find((c) => c.isDefault) ?? res.collections[0] ?? null;
        setCollectionId(defaultCollection?.id ?? null);
        const loaded = await loadFolders(defaultCollection?.id ?? null);
        if (cancelled) return;
        // Honor a ?folder=<id> deep-link (from the Dashboard tiles) when it
        // resolves to something real: a folder present in the loaded list,
        // or the Unfiled sentinel (which isn't a real folder id, so it's
        // matched by value, not against `loaded`). Otherwise fall back to
        // the first folder, as before. Only sets the initial selection
        // (?? prev) - never overrides a user's later click.
        const deepLinkTarget =
          initialFolderId === UNFILED_FOLDER_ID
            ? UNFILED_FOLDER_ID
            : initialFolderId && loaded.some((f) => f.id === initialFolderId)
              ? initialFolderId
              : null;
        setSelectedFolderId((prev) => {
          if (prev) return prev;
          if (deepLinkTarget) return deepLinkTarget;
          if (loaded.length > 0) return loaded[0].id;
          return prev;
        });
      } catch (err) {
        if (cancelled) return;
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setFoldersError(err instanceof Error ? err.message : "Failed to load collections");
        setFoldersLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checking, loadFolders, router, initialFolderId]);

  const loadFolderPhotos = useCallback(
    async (folderId: string, pageOffset: number) => {
      const requestId = ++gridRequestIdRef.current;
      setGridLoading(true);
      setGridError(null);
      try {
        const res =
          folderId === UNFILED_FOLDER_ID
            ? await unfiledPhotosApi.list({ limit: PAGE_LIMIT, offset: pageOffset })
            : await folderPhotosApi.list(folderId, { limit: PAGE_LIMIT, offset: pageOffset });
        if (requestId !== gridRequestIdRef.current) return; // a newer request superseded this one

        const cards: CardState[] = res.photos.map((p) => ({ ...p, duplicateOfLabel: null }));
        setPhotos(cards);
        setTotal(res.total);
        setOffset(res.offset);

        cards
          .filter((c) => c.status === "duplicate" && c.duplicateOfPhotoId)
          .forEach((c) => resolveDuplicateLabel(c.id, c.duplicateOfPhotoId as string, c.dedupMethod, requestId));
      } catch (err) {
        if (requestId !== gridRequestIdRef.current) return;
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setGridError(err instanceof Error ? err.message : "Failed to load photos");
      } finally {
        if (requestId === gridRequestIdRef.current) setGridLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router],
  );

  async function resolveDuplicateLabel(
    photoId: string,
    duplicateOfPhotoId: string,
    dedupMethod: string | null,
    requestId: number,
  ) {
    let originalName = duplicateOfPhotoId;
    try {
      const original = await photosApi.get(duplicateOfPhotoId);
      if (requestId !== gridRequestIdRef.current) return;
      originalName = original?.originalFilename ?? duplicateOfPhotoId;
    } catch {
      // Original unavailable (cross-user edge case or the accepted
      // duplicate-of-a-duplicate chain trade-off) - fall back to the id.
    }
    if (requestId !== gridRequestIdRef.current) return;
    const label = dedupMethod ? `${originalName} (${dedupMethod})` : originalName;
    setPhotos((prev) => prev.map((p) => (p.id === photoId ? { ...p, duplicateOfLabel: label } : p)));
  }

  useEffect(() => {
    if (!selectedFolderId) return;
    setOffset(0);
    loadFolderPhotos(selectedFolderId, 0);
  }, [selectedFolderId, loadFolderPhotos]);

  function handlePrev() {
    if (!selectedFolderId || offset === 0) return;
    loadFolderPhotos(selectedFolderId, Math.max(0, offset - PAGE_LIMIT));
  }

  function handleNext() {
    if (!selectedFolderId || offset + PAGE_LIMIT >= total) return;
    loadFolderPhotos(selectedFolderId, offset + PAGE_LIMIT);
  }

  if (checking) return null;

  const selectedIsUnfiled = selectedFolderId === UNFILED_FOLDER_ID;
  const selectedFolder = selectedIsUnfiled
    ? { id: UNFILED_FOLDER_ID, name: "Unfiled", photoCount: unfiledCount }
    : (folders.find((f) => f.id === selectedFolderId) ?? null);
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_LIMIT, total);

  const viewerPhotos: ViewerPhotoRef[] = photos.map((p) => ({
    id: p.id,
    originalFilename: p.originalFilename,
    status: p.status,
    duplicateOfLabel: p.duplicateOfLabel,
  }));

  return (
    <main className="organize-shell">
      <div className="organize-topbar">
        <h1>
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="browse-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Browse
        </h1>
        <div className="dashboard-topbar-right">
          <UiV2Banner href="/browse/v2" />
          <Link href="/upload" className="dashboard-guests-link" data-testid="browse-upload-link">
            Upload
          </Link>
          <Link href="/organize" className="dashboard-guests-link" data-testid="browse-organize-link">
            Organize
          </Link>
          <Link href="/search" className="dashboard-guests-link" data-testid="browse-search-link">
            Search
          </Link>
          <Link href="/guests" className="dashboard-guests-link" data-testid="browse-guests-link">
            Guests
          </Link>
          <Link href="/activity" className="dashboard-guests-link" data-testid="browse-activity-link">
            Activity
          </Link>
          <Link href="/trash" className="dashboard-guests-link" data-testid="browse-trash-link">
            Trash
          </Link>
          <Link href="/settings" className="dashboard-guests-link" data-testid="browse-settings-link">
            Settings
          </Link>
        </div>
      </div>

      <div className="organize-body">
        <aside className="organize-sidebar">
          <h2>My Photos</h2>

          {foldersLoading && <p className="organize-empty">Loading folders…</p>}
          {foldersError && <p className="organize-new-folder-error">{foldersError}</p>}
          {!foldersLoading && !foldersError && folders.length === 0 && unfiledCount === 0 && (
            <p className="organize-empty">No photos yet — upload one to get started.</p>
          )}

          <ul className="organize-folder-list">
            {folders.map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  data-testid={`folder-row-${folder.name}`}
                  className={`organize-folder-row${folder.id === selectedFolderId ? " active" : ""}`}
                  onClick={() => setSelectedFolderId(folder.id)}
                >
                  <span>{folder.name}</span>
                  <span className="count">{folder.photoCount}</span>
                </button>
              </li>
            ))}
            {unfiledCount > 0 && (
              <li>
                <button
                  type="button"
                  data-testid="folder-row-Unfiled"
                  className={`organize-folder-row${selectedIsUnfiled ? " active" : ""}`}
                  onClick={() => setSelectedFolderId(UNFILED_FOLDER_ID)}
                >
                  <span>Unfiled</span>
                  <span className="count">{unfiledCount}</span>
                </button>
              </li>
            )}
          </ul>
        </aside>

        <section className="organize-main">
          {!selectedFolder && !foldersLoading && (
            <p className="organize-empty">Select a folder to view its photos.</p>
          )}

          {selectedFolder && (
            <>
              <div className="organize-main-header">
                <h2>{selectedFolder.name}</h2>
                <span>— {selectedFolder.photoCount} photos</span>
                {/* P5: owner "Download all" - real folders only (not the virtual
                    Unfiled bucket), and only when the folder has photos. A
                    credentialed top-level navigation to the streaming endpoint
                    (Content-Disposition: attachment) so the browser saves it. */}
                {!selectedIsUnfiled && selectedFolder.photoCount > 0 && (
                  <button
                    type="button"
                    className="organize-downloadall-btn"
                    data-testid="browse-download-all"
                    onClick={() => window.location.assign(downloadAllApi.ownerFolderUrl(selectedFolder.id))}
                  >
                    Download all
                  </button>
                )}
              </div>

              {gridError && <p className="organize-new-folder-error">{gridError}</p>}
              {gridLoading && <p className="organize-empty">Loading photos…</p>}

              {!gridLoading && photos.length === 0 && !gridError && (
                <p className="organize-empty">No photos in this folder.</p>
              )}

              {!gridLoading && photos.length > 0 && (
                <>
                  <div className="organize-grid" data-testid="browse-grid">
                    {photos.map((photo, i) => (
                      <ReadOnlyPhotoCard key={photo.id} photo={photo} onOpen={() => setViewerIndex(i)} />
                    ))}
                  </div>

                  <div className="organize-pagination">
                    <button type="button" onClick={handlePrev} disabled={offset === 0}>
                      ‹ Prev
                    </button>
                    <button type="button" onClick={handleNext} disabled={offset + PAGE_LIMIT >= total}>
                      Next ›
                    </button>
                    <span data-testid="pagination-range">
                      Showing {rangeStart}–{rangeEnd} of {total}
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </section>
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

// Read-only card - no Move dropdown, no Reclassify/"Not a duplicate?"
// button, no per-card action state. Not sharing /organize's PhotoCard
// component: that component's props (onMove/onReclassify, moveTargets,
// moving/reclassifying/actionError) are all mutation-only concerns this
// page has none of, so threading a "read-only" branch through it would cost
// more than the ~30 lines of markup duplicated here (per the spec's shared-
// component-reuse note - a judgment call, not a hard requirement).
function ReadOnlyPhotoCard({ photo, onOpen }: { photo: CardState; onOpen: () => void }) {
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
      {photo.status === "duplicate" && (
        <p className="organize-card-meta">duplicate of {photo.duplicateOfLabel ?? "…"}</p>
      )}
      {photo.status !== "failed" && photo.status !== "duplicate" && (
        <p className="organize-card-meta">
          {photo.aiLabels.length > 0 ? photo.aiLabels.join(", ") : " "}
          {photo.aiConfidence != null ? ` · ${photo.aiConfidence.toFixed(2)}` : ""}
        </p>
      )}
    </div>
  );
}
