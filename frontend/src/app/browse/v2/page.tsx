"use client";

// Browse v2 — redesign handoff (README.md "Browse", PhotoSphere.dc.html
// Browse screen), living side-by-side with the classic /browse page. Same
// data logic as src/app/browse/page.tsx — auth gate, default-collection
// resolution, ?folder= deep-link (incl. the __unfiled__ sentinel),
// stale-fetch guard, duplicate-label resolution, pagination, owner
// "Download all" — only the markup/styling changes: the folder sidebar
// becomes the design's filter-chip row, and the card grid becomes the
// 6-column dense masonry with gradient-scrim captions. Photo clicks open
// the SAME shared PhotoViewer; its v2 skin is the "Photo Viewer" screen,
// ported separately.
//
// Masonry "big" tiles: the prototype flags hero photos in mock data; real
// photos carry no such flag, so a fixed positional rhythm stands in (first
// tile of each page + every 9th after), which the dense grid packs around.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
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
import Ps2Shell from "@/components/ps2/Shell";

const PAGE_LIMIT = 12;

// Same sentinel-id convention as /organize and classic /browse.
const UNFILED_FOLDER_ID = "__unfiled__";

type CardState = FolderPhoto & {
  duplicateOfLabel: string | null;
};

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// useSearchParams() needs a Suspense boundary in the Next 14 App Router,
// same as the classic page.
export default function BrowseV2Page() {
  return (
    <Suspense fallback={null}>
      <BrowseV2PageInner />
    </Suspense>
  );
}

function BrowseV2PageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFolderId = searchParams.get("folder");
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

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

  const gridRequestIdRef = useRef(0);

  // ---- Auth gate (same pattern as the classic page; also keeps the user
  // object for the shell's avatar/name row) ----
  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  const loadFolders = useCallback(async (cId: string | null) => {
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const [foldersRes, unfiledRes] = await Promise.all([
        cId ? foldersApi.list(cId) : Promise.resolve({ folders: [] as Folder[] }),
        unfiledPhotosApi.list({ limit: 1, offset: 0 }), // only `total` needed for the chip count
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

  // ---- Initial load: default collection + folders + Unfiled count, then
  // honor a ?folder= deep-link exactly as the classic page does. ----
  useEffect(() => {
    if (checking) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await collectionsApi.list();
        if (cancelled) return;
        const defaultCollection = res.collections.find((c) => c.isDefault) ?? res.collections[0] ?? null;
        const loaded = await loadFolders(defaultCollection?.id ?? null);
        if (cancelled) return;
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
        if (requestId !== gridRequestIdRef.current) return; // superseded

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
      // Original unavailable — fall back to the id (same trade-off as classic).
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
  if (!user) return null; // redirect already in flight

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
    <Ps2Shell active="browse" userName={user.name} classicHref="/browse">
      <main className="ps2-browse" data-testid="browse-v2">
        <div className="ps2-browse-head">
          <h1 className="ps2-h1-page">Library</h1>
          {selectedFolder && (
            <span className="ps2-browse-count" data-testid="browse-v2-count">
              {selectedFolder.name} · {total} photos
            </span>
          )}
          {!selectedIsUnfiled && selectedFolder && selectedFolder.photoCount > 0 && (
            <button
              type="button"
              className="ps2-btn-ghost"
              style={{ marginLeft: "auto" }}
              data-testid="browse-download-all"
              onClick={() => window.location.assign(downloadAllApi.ownerFolderUrl(selectedFolder.id))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4v12m-6-6 6 6 6-6M4 20h16" /></svg>
              Download all
            </button>
          )}
        </div>

        {foldersError && <p className="ps2-error">{foldersError}</p>}
        {foldersLoading && (
          <div className="ps2-loading">
            <span className="ps2-spinner" aria-hidden="true" />
            Loading folders…
          </div>
        )}

        {!foldersLoading && !foldersError && folders.length === 0 && unfiledCount === 0 && (
          <div className="ps2-empty" style={{ marginTop: 24 }}>
            <div className="ps2-empty-title">No photos yet.</div>
            <div>Upload one to get started.</div>
          </div>
        )}

        {(folders.length > 0 || unfiledCount > 0) && (
          <div className="ps2-chip-row" data-testid="browse-v2-chips">
            {folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                data-testid={`folder-chip-${folder.name}`}
                className={`ps2-chip${folder.id === selectedFolderId ? " ps2-chip-active" : ""}`}
                onClick={() => setSelectedFolderId(folder.id)}
              >
                {folder.name}
                <span className="ps2-chip-count">{folder.photoCount}</span>
              </button>
            ))}
            {unfiledCount > 0 && (
              <button
                type="button"
                data-testid="folder-chip-Unfiled"
                className={`ps2-chip${selectedIsUnfiled ? " ps2-chip-active" : ""}`}
                onClick={() => setSelectedFolderId(UNFILED_FOLDER_ID)}
              >
                Unfiled
                <span className="ps2-chip-count">{unfiledCount}</span>
              </button>
            )}
          </div>
        )}

        {gridError && <p className="ps2-error">{gridError}</p>}
        {gridLoading && (
          <div className="ps2-loading">
            <span className="ps2-spinner" aria-hidden="true" />
            Loading photos…
          </div>
        )}

        {!gridLoading && selectedFolder && photos.length === 0 && !gridError && (
          <div className="ps2-empty">
            <div className="ps2-empty-title">Nothing in this folder.</div>
            <div>Photos you add here will show up in this grid.</div>
          </div>
        )}

        {!gridLoading && photos.length > 0 && (
          <>
            <div className="ps2-masonry" data-testid="browse-v2-grid">
              {photos.map((photo, i) => (
                <PhotoTile key={photo.id} photo={photo} big={i % 9 === 0} onOpen={() => setViewerIndex(i)} />
              ))}
            </div>

            <div className="ps2-pagination">
              <button type="button" className="ps2-page-btn" onClick={handlePrev} disabled={offset === 0}>
                ‹ Prev
              </button>
              <button
                type="button"
                className="ps2-page-btn"
                onClick={handleNext}
                disabled={offset + PAGE_LIMIT >= total}
              >
                Next ›
              </button>
              <span className="ps2-page-range" data-testid="pagination-range">
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

// Masonry tile — thumbnail with a bottom gradient scrim carrying filename +
// AI labels (the design's title/place caption), and a status badge for
// failed/duplicate photos (the classic card's status affordances, restyled).
function PhotoTile({ photo, big, onOpen }: { photo: CardState; big: boolean; onOpen: () => void }) {
  const sub =
    photo.status === "duplicate"
      ? `duplicate of ${photo.duplicateOfLabel ?? "…"}`
      : photo.status === "failed"
        ? "classification failed"
        : photo.aiLabels.length > 0
          ? photo.aiLabels.join(", ")
          : "";

  return (
    <button
      type="button"
      className={`ps2-photo-tile${big ? " ps2-photo-tile-big" : ""}`}
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
