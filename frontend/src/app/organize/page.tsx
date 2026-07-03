"use client";

// Reclassification UI (specs/ai-classification.md §"Manual reclassification
// UI", Option A per design/wireframes/reclassify-ui.svg): sidebar folder
// tree + thumbnail grid, per-card "Move to..." dropdown, Reclassify on
// failed/duplicate cards, inline folder creation.
//
// Backend gap found and closed (see routes/photos.ts's
// GET /api/photos/unfiled): failed/duplicate photos always have
// folderId: null (the dedup gate short-circuits before folder assignment
// for duplicates; a failed pipeline job never reaches folder assignment at
// all), so they're structurally invisible to GET /api/folders/:id/photos
// for every real folder - yet the wireframe requires them to be visible and
// actionable. This page surfaces them via a virtual "Unfiled" sidebar row
// (UNFILED_FOLDER_ID below) backed by that endpoint, styled identically to
// a real folder row.
//
// Bug fix (reports/2026-07-03_0731.md "New Failures" [High]): the Unfiled
// endpoint used to be collection-scoped (GET
// /api/collections/:id/unfiled-photos), so a brand-new user whose very
// first photo failed/deduped before any collection ever existed had no way
// to reach it - this page's initial-load effect bailed out on an empty
// GET /api/collections response before ever checking for unfiled photos.
// GET /api/photos/unfiled is user-scoped instead (it was never really
// collection-scoped server-side to begin with - see that route's comment),
// so the initial-load effect below now always checks it, independent of
// whether a collection/folder has ever been created.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  collectionsApi,
  Folder,
  FolderPhoto,
  folderPhotosApi,
  foldersApi,
  photosApi,
  unfiledPhotosApi,
} from "@/lib/api";

const PAGE_LIMIT = 12;
const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(["done", "duplicate", "failed"]);

// Sentinel id for the virtual "Unfiled" bucket - never a real folder id
// (Folder rows are UUIDs), so it can share the same selectedFolderId state
// and folder-row rendering as real folders without ambiguity.
const UNFILED_FOLDER_ID = "__unfiled__";

type CardState = FolderPhoto & {
  duplicateOfLabel: string | null; // resolved original filename, e.g. "IMG_2041.jpg" - null while loading/unavailable
  moving: boolean; // a PATCH move is in flight for this card
  reclassifying: boolean; // a reclassify request/poll is in flight for this card
  actionError: string | null;
};

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export default function OrganizePage() {
  const router = useRouter();
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

  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Guards against stale async responses clobbering newer state - e.g.
  // switching folders quickly, or a reclassify poll resolving after the
  // photo already moved out of the current grid (a manual move raced it).
  const gridRequestIdRef = useRef(0);
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const selectedFolderIdRef = useRef<string | null>(null);
  const collectionIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedFolderIdRef.current = selectedFolderId;
  }, [selectedFolderId]);
  useEffect(() => {
    collectionIdRef.current = collectionId;
  }, [collectionId]);

  function stopPoll(photoId: string) {
    const timer = pollTimersRef.current.get(photoId);
    if (timer) {
      clearInterval(timer);
      pollTimersRef.current.delete(photoId);
    }
  }

  useEffect(() => {
    const timers = pollTimersRef.current;
    return () => {
      // Unmount cleanup - stop every in-flight poll, don't leak timers.
      timers.forEach((timer) => clearInterval(timer));
      timers.clear();
    };
  }, []);

  // ---- Auth gate (same pattern as /dashboard and /upload) ----
  useEffect(() => {
    authApi
      .me()
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  // ---- Refresh sidebar: real folders (if a collection exists yet) + the
  // virtual Unfiled row's count (always - user-scoped, no collection
  // dependency). cId may be null for a brand-new user who has never had a
  // successful classification (no collection created yet) but whose
  // first-ever upload already failed/deduped - see the initial-load effect
  // below and reports/2026-07-03_0731.md "New Failures" [High].
  const loadFolders = useCallback(async (cId: string | null) => {
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const [foldersRes, unfiledRes] = await Promise.all([
        cId ? foldersApi.list(cId) : Promise.resolve({ folders: [] as Folder[] }),
        unfiledPhotosApi.list({ limit: 1, offset: 0 }), // limit 1 - only `total` is needed for the sidebar count
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

  // ---- Initial load: default collection (if any) + its folders, PLUS the
  // Unfiled count regardless of whether a collection exists yet.
  //
  // Bug fix (reports/2026-07-03_0731.md "New Failures" [High]): this used to
  // bail out entirely ("no collection yet -> not an error, just an empty
  // state") whenever GET /api/collections returned [], which is also true
  // for a user whose first-ever upload already failed or deduped (the
  // default "My Photos" collection is only lazily created at successful
  // folder assignment, never reached by a failed job or a dedup
  // short-circuit) - stranding that photo with no way to reach it, since
  // the old unfiled-photos route required a collection id. loadFolders now
  // always checks Unfiled via the user-scoped GET /api/photos/unfiled
  // (routes/photos.ts), independent of collection existence, so this effect
  // calls it either way instead of returning early.
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
        if (loaded.length > 0) {
          setSelectedFolderId((prev) => prev ?? loaded[0].id);
        }
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
  }, [checking, loadFolders, router]);

  // ---- Refresh the sidebar after a reclassify resolves, picking up a
  // brand-new collection if this was the user's first-ever successful
  // classification (same bug class as the Unfiled-unreachable fix: before
  // this, a first-ever reclassify success would silently keep
  // collectionIdRef.current === null forever, since it's only ever set from
  // the initial-load effect - the new Food/Animals/etc. folder would exist
  // server-side but never appear in the sidebar without a manual reload). ----
  function refreshSidebarAfterReclassify(statusCollectionId: string | null) {
    const knownCollectionId = collectionIdRef.current ?? statusCollectionId ?? null;
    if (!collectionIdRef.current && statusCollectionId) {
      setCollectionId(statusCollectionId);
    }
    loadFolders(knownCollectionId);
  }

  // ---- Load the selected folder's (or Unfiled's) photos, paginated ----
  const loadFolderPhotos = useCallback(
    async (folderId: string, pageOffset: number) => {
      // Unfiled is user-scoped (GET /api/photos/unfiled) - no collection
      // dependency, so no early-return guard needed here anymore.
      const requestId = ++gridRequestIdRef.current;
      setGridLoading(true);
      setGridError(null);
      try {
        const res =
          folderId === UNFILED_FOLDER_ID
            ? await unfiledPhotosApi.list({ limit: PAGE_LIMIT, offset: pageOffset })
            : await folderPhotosApi.list(folderId, { limit: PAGE_LIMIT, offset: pageOffset });
        if (requestId !== gridRequestIdRef.current) return; // a newer request superseded this one

        const cards: CardState[] = res.photos.map((p) => ({
          ...p,
          duplicateOfLabel: null,
          moving: false,
          reclassifying: false,
          actionError: null,
        }));
        setPhotos(cards);
        setTotal(res.total);
        setOffset(res.offset);

        // Resolve "duplicate of X" -> the original's filename. duplicateOfPhotoId
        // and dedupMethod now come directly from the list response (backend
        // addition), so only the *original's filename* still needs a per-card
        // fetch - unavoidable without a backend join, and cheap at this
        // photo-per-page count (<= PAGE_LIMIT).
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
      if (requestId !== gridRequestIdRef.current) return; // grid moved on
      originalName = original?.originalFilename ?? duplicateOfPhotoId;
    } catch {
      // Original photo detail unavailable (e.g. cross-user edge case or the
      // narrow duplicate-of-a-duplicate chain documented in Day2.md/
      // STATUS.md's accepted dedup trade-offs) - fall back to the id so the
      // card still communicates something useful rather than erroring.
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

  // ---- Inline folder creation ----
  async function handleCreateFolder() {
    if (!collectionId) return;
    const name = newFolderName.trim();
    if (!name) {
      setNewFolderError("Folder name is required");
      return;
    }
    setCreatingFolder(true);
    setNewFolderError(null);
    try {
      const folder = await foldersApi.create(collectionId, name);
      setFolders((prev) => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)));
      setNewFolderName("");
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setNewFolderError("A folder with this name already exists");
      } else if (err instanceof ApiError && err.status === 400) {
        setNewFolderError(err.message || "Invalid folder name");
      } else {
        setNewFolderError(err instanceof Error ? err.message : "Failed to create folder");
      }
    } finally {
      setCreatingFolder(false);
    }
  }

  // ---- Move a photo to another folder (only offered on real-folder cards,
  // never on Unfiled's failed/duplicate cards - those use Reclassify) ----
  async function handleMove(photoId: string, targetFolderId: string) {
    if (!targetFolderId || !selectedFolderId) return;
    const sourceFolderId = selectedFolderId;

    setPhotos((prev) => prev.map((p) => (p.id === photoId ? { ...p, moving: true, actionError: null } : p)));

    try {
      await photosApi.move(photoId, targetFolderId);

      // A reclassify poll may be in flight for this photo (e.g. the user
      // triggered reclassify, then moved the card before it resolved). The
      // move is an organizational act only (backend leaves classification
      // fields untouched) so the poll's eventual status update is still
      // valid, but it must not resurrect this card into the *old* view once
      // it's moved away - stop polling under this folder's view.
      stopPoll(photoId);

      // Card left the currently-viewed folder - remove it from the grid.
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      setTotal((prev) => Math.max(0, prev - 1));

      // Reconcile both real folders' live counts. Server guarantees exactly
      // a +1/-1 pair on success (routes/photos.ts PATCH handler), so a
      // targeted local update is safe and avoids a full sidebar refetch.
      // (sourceFolderId is never UNFILED_FOLDER_ID here - Unfiled cards
      // don't render a move dropdown - so this is always a real folder id.)
      setFolders((prev) =>
        prev.map((f) => {
          if (f.id === sourceFolderId) return { ...f, photoCount: Math.max(0, f.photoCount - 1) };
          if (f.id === targetFolderId) return { ...f, photoCount: f.photoCount + 1 };
          return f;
        }),
      );
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photoId
            ? { ...p, moving: false, actionError: err instanceof Error ? err.message : "Move failed" }
            : p,
        ),
      );
    }
  }

  // ---- Reclassify / "Not a duplicate?" ----
  async function handleReclassify(photoId: string) {
    setPhotos((prev) =>
      prev.map((p) => (p.id === photoId ? { ...p, reclassifying: true, actionError: null } : p)),
    );

    try {
      await photosApi.reclassify(photoId);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      const message =
        err instanceof ApiError && err.status === 409
          ? "Already in progress"
          : err instanceof Error
            ? err.message
            : "Reclassify failed";
      setPhotos((prev) =>
        prev.map((p) => (p.id === photoId ? { ...p, reclassifying: false, actionError: message } : p)),
      );
      return;
    }

    // Poll status until it resolves, same pattern as /upload. Guard against
    // a duplicate poll for the same photo and against the card having moved
    // to a different folder/Unfiled view in the meantime.
    stopPoll(photoId);
    const folderAtPollStart = selectedFolderIdRef.current;

    const timer = setInterval(async () => {
      try {
        const statusRes = await photosApi.status(photoId);

        // The user navigated to a different folder while this was in
        // flight - the card is no longer visible, stop silently rather
        // than writing into unrelated grid state.
        if (selectedFolderIdRef.current !== folderAtPollStart) {
          stopPoll(photoId);
          return;
        }

        if (!TERMINAL_STATUSES.has(statusRes.status)) return;

        stopPoll(photoId);

        // Reclassification always resolves a previously-failed/duplicate
        // photo (started in Unfiled, folderId: null) into either a real
        // folder (done) or stays orphaned another way (failed again, or a
        // fresh duplicate verdict) - either way it leaves the Unfiled view
        // whenever it now has a folderId, or a normal-folder view if it's
        // now unfiled again (shouldn't happen from a real folder, since
        // only Unfiled cards call reclassify, but guard anyway). Refetch
        // both the sidebar (counts including Unfiled) and, if the photo
        // left the folder currently open, remove its card.
        const stillInSameView =
          folderAtPollStart === UNFILED_FOLDER_ID
            ? statusRes.folderId == null // still unfiled (failed again, or re-flagged duplicate)
            : statusRes.folderId === folderAtPollStart;

        if (!stillInSameView) {
          setPhotos((prev) => prev.filter((p) => p.id !== photoId));
          setTotal((prev) => Math.max(0, prev - 1));
          refreshSidebarAfterReclassify(statusRes.collectionId);
          return;
        }

        // Still belongs in the view being looked at (e.g. re-resolved to
        // Uncategorized while Uncategorized is open, or failed again while
        // Unfiled is open) - update the card in place rather than reloading.
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === photoId
              ? {
                  ...p,
                  status: statusRes.status,
                  aiLabels: statusRes.aiLabels ?? [],
                  aiConfidence: statusRes.aiConfidence ?? null,
                  duplicateOfPhotoId: statusRes.duplicateOfPhotoId ?? null,
                  dedupMethod: statusRes.dedupMethod ?? null,
                  reclassifying: false,
                  duplicateOfLabel: null,
                  actionError: null,
                }
              : p,
          ),
        );
        if (statusRes.status === "duplicate" && statusRes.duplicateOfPhotoId) {
          resolveDuplicateLabel(photoId, statusRes.duplicateOfPhotoId, statusRes.dedupMethod ?? null, gridRequestIdRef.current);
        }
        refreshSidebarAfterReclassify(statusRes.collectionId); // counts may have changed
      } catch (pollErr) {
        stopPoll(photoId);
        if (isAuthError(pollErr)) {
          router.replace("/login");
          return;
        }
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === photoId
              ? {
                  ...p,
                  reclassifying: false,
                  actionError: pollErr instanceof Error ? pollErr.message : "Polling failed",
                }
              : p,
          ),
        );
      }
    }, POLL_INTERVAL_MS);

    pollTimersRef.current.set(photoId, timer);
  }

  function handlePrev() {
    if (!selectedFolderId || offset === 0) return;
    const newOffset = Math.max(0, offset - PAGE_LIMIT);
    loadFolderPhotos(selectedFolderId, newOffset);
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

  return (
    <main className="organize-shell">
      <div className="organize-topbar">
        <h1>PhotoSphere AI — Organize</h1>
      </div>

      <div className="organize-body">
        <aside className="organize-sidebar">
          <h2>My Photos</h2>

          {foldersLoading && <p className="organize-empty">Loading folders…</p>}
          {foldersError && <p className="organize-new-folder-error">{foldersError}</p>}
          {!foldersLoading && !foldersError && folders.length === 0 && unfiledCount === 0 && (
            <p className="organize-empty">
              No folders yet — upload a photo to get started, or create one below.
            </p>
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

          <div className="organize-new-folder">
            <input
              type="text"
              placeholder="New folder name…"
              value={newFolderName}
              disabled={!collectionId || creatingFolder}
              data-testid="new-folder-input"
              onChange={(e) => {
                setNewFolderName(e.target.value);
                if (newFolderError) setNewFolderError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
              }}
            />
            <button
              type="button"
              data-testid="new-folder-submit"
              disabled={!collectionId || creatingFolder}
              onClick={handleCreateFolder}
            >
              Add
            </button>
          </div>
          {newFolderError && <p className="organize-new-folder-error">{newFolderError}</p>}
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
              </div>

              {gridError && <p className="organize-new-folder-error">{gridError}</p>}
              {gridLoading && <p className="organize-empty">Loading photos…</p>}

              {!gridLoading && photos.length === 0 && !gridError && (
                <p className="organize-empty">No photos in this folder.</p>
              )}

              {!gridLoading && photos.length > 0 && (
                <>
                  <div className="organize-grid" data-testid="organize-grid">
                    {photos.map((photo) => (
                      <PhotoCard
                        key={photo.id}
                        photo={photo}
                        folders={folders}
                        currentFolderId={selectedFolder.id}
                        onMove={handleMove}
                        onReclassify={handleReclassify}
                      />
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
    </main>
  );
}

function PhotoCard({
  photo,
  folders,
  currentFolderId,
  onMove,
  onReclassify,
}: {
  photo: CardState;
  folders: Folder[];
  currentFolderId: string;
  onMove: (photoId: string, targetFolderId: string) => void;
  onReclassify: (photoId: string) => void;
}) {
  const moveTargets = folders.filter((f) => f.id !== currentFolderId);
  const cardClass =
    photo.status === "failed"
      ? "organize-card failed"
      : photo.status === "duplicate"
        ? "organize-card duplicate"
        : "organize-card";

  return (
    <div className={cardClass} data-testid={`photo-card-${photo.id}`} data-status={photo.status}>
      <div className="organize-card-thumb">
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
      </div>

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

      {photo.actionError && <p className="organize-new-folder-error">{photo.actionError}</p>}

      <div className="organize-card-action">
        {photo.status === "failed" && (
          <button
            type="button"
            data-testid={`reclassify-${photo.id}`}
            disabled={photo.reclassifying}
            onClick={() => onReclassify(photo.id)}
          >
            {photo.reclassifying ? "Reclassifying…" : "Reclassify"}
          </button>
        )}
        {photo.status === "duplicate" && (
          <button
            type="button"
            data-testid={`not-duplicate-${photo.id}`}
            disabled={photo.reclassifying}
            onClick={() => onReclassify(photo.id)}
          >
            {photo.reclassifying ? "Checking…" : "Not a duplicate?"}
          </button>
        )}
        {photo.status !== "failed" && photo.status !== "duplicate" && (
          <select
            data-testid={`move-select-${photo.id}`}
            value=""
            disabled={photo.moving || moveTargets.length === 0}
            onChange={(e) => {
              const target = e.target.value;
              if (target) onMove(photo.id, target);
            }}
          >
            <option value="" disabled>
              {photo.moving ? "Moving…" : "Move to… ▾"}
            </option>
            {moveTargets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
