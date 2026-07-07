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
import Link from "next/link";
import { useRouter } from "next/navigation";
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

  // Photo viewer (specs/week7-8-dashboard-browser-viewer.md "Photo viewer"):
  // clicking a card's thumbnail (not the Move <select>/Reclassify button)
  // opens the shared viewer over the current grid page - same component as
  // /browse, confirming "reachable from any grid" rather than being
  // /browse-specific.
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // ---- P4 folder management (rename / merge / delete via a per-folder kebab
  // menu, design/wireframes/folder-mgmt.svg Option A). openMenuFolderId tracks
  // which row's kebab menu is open; renamingFolderId tracks the inline-edit
  // row. mergeDialog / deleteDialog hold the folder each modal targets. Each
  // op refreshes the tree + counts on success; the F1 409 shared-block and the
  // rename 409 collision are surfaced inline in their respective surfaces. ----
  const [openMenuFolderId, setOpenMenuFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const [mergeDialogFolder, setMergeDialogFolder] = useState<Folder | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeBlocked, setMergeBlocked] = useState(false); // F1 shared-with-guest 409
  const [mergeBusy, setMergeBusy] = useState(false);

  const [deleteDialogFolder, setDeleteDialogFolder] = useState<Folder | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState(false); // F1 shared-with-guest 409
  const [deleteBusy, setDeleteBusy] = useState(false);

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

  // ---- P4: refresh the sidebar tree + counts after a merge/delete. Reuses
  // loadFolders (which refetches both the folder list and the Unfiled count) so
  // a merge/delete's downstream effects - target count bumped, source gone,
  // delete's photos now in Unfiled - all reconcile from the server, no manual
  // count math. If the currently-selected folder was the one removed, fall back
  // to the first remaining folder (or Unfiled). ----
  async function refreshTreeAfter(removedFolderId: string) {
    const remaining = await loadFolders(collectionIdRef.current);
    if (selectedFolderIdRef.current === removedFolderId) {
      setSelectedFolderId(remaining[0]?.id ?? UNFILED_FOLDER_ID);
    }
  }

  // ---- P4 Rename: inline edit on the folder row. 409 collision → inline
  // message; empty → validated/disabled before any request. ----
  function startRename(folder: Folder) {
    setOpenMenuFolderId(null);
    setRenamingFolderId(folder.id);
    setRenameDraft(folder.name);
    setRenameError(null);
  }

  function cancelRename() {
    setRenamingFolderId(null);
    setRenameDraft("");
    setRenameError(null);
    setRenameBusy(false);
  }

  async function commitRename(folder: Folder) {
    const name = renameDraft.trim();
    if (!name) {
      setRenameError("Folder name is required");
      return;
    }
    if (name === folder.name) {
      cancelRename();
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      const updated = await foldersApi.rename(folder.id, name);
      setFolders((prev) =>
        prev.map((f) => (f.id === folder.id ? { ...f, name: updated.name } : f)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      cancelRename();
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setRenameError("A folder with that name already exists");
      } else if (err instanceof ApiError && err.status === 400) {
        setRenameError(err.message || "Invalid folder name");
      } else {
        setRenameError(err instanceof Error ? err.message : "Rename failed");
      }
      setRenameBusy(false);
    }
  }

  // ---- P4 Merge: open the dialog for a source folder; the destination is
  // picked from the owner's OTHER folders in the same collection. 409 (F1)
  // shows the shared-with-guest block; success refreshes the tree. ----
  function openMergeDialog(folder: Folder) {
    setOpenMenuFolderId(null);
    setMergeDialogFolder(folder);
    setMergeTargetId("");
    setMergeError(null);
    setMergeBlocked(false);
    setMergeBusy(false);
  }

  function closeMergeDialog() {
    setMergeDialogFolder(null);
    setMergeTargetId("");
    setMergeError(null);
    setMergeBlocked(false);
    setMergeBusy(false);
  }

  async function confirmMerge() {
    if (!mergeDialogFolder || !mergeTargetId) return;
    const source = mergeDialogFolder;
    setMergeBusy(true);
    setMergeError(null);
    setMergeBlocked(false);
    try {
      await foldersApi.merge(source.id, mergeTargetId);
      closeMergeDialog();
      await refreshTreeAfter(source.id);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        // F1: the source folder is shared with a guest - revoke first.
        setMergeBlocked(true);
      } else if (err instanceof ApiError && err.status === 400) {
        setMergeError(err.message || "Cannot merge these folders");
      } else {
        setMergeError(err instanceof Error ? err.message : "Merge failed");
      }
      setMergeBusy(false);
    }
  }

  // ---- P4 Delete: confirm dialog with the "photos move to Unfiled" copy. 409
  // (F1) shows the shared-with-guest block; success refreshes the tree (the
  // deleted folder's photos now surface in the Unfiled bucket). ----
  function openDeleteDialog(folder: Folder) {
    setOpenMenuFolderId(null);
    setDeleteDialogFolder(folder);
    setDeleteError(null);
    setDeleteBlocked(false);
    setDeleteBusy(false);
  }

  function closeDeleteDialog() {
    setDeleteDialogFolder(null);
    setDeleteError(null);
    setDeleteBlocked(false);
    setDeleteBusy(false);
  }

  async function confirmDelete() {
    if (!deleteDialogFolder) return;
    const folder = deleteDialogFolder;
    setDeleteBusy(true);
    setDeleteError(null);
    setDeleteBlocked(false);
    try {
      await foldersApi.remove(folder.id);
      closeDeleteDialog();
      await refreshTreeAfter(folder.id);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        setDeleteBlocked(true);
      } else {
        setDeleteError(err instanceof Error ? err.message : "Delete failed");
      }
      setDeleteBusy(false);
    }
  }

  // ---- P5: trigger a browser download of the owner folder zip. A credentialed
  // top-level navigation to the streaming endpoint (Content-Disposition:
  // attachment) so the browser SAVES the file - NOT a fetch-into-memory. The
  // owner session cookie rides the same-origin navigation automatically. An
  // empty/too-large folder returns 400/409, which the browser would show as a
  // JSON body in a new context; we pre-guard the obvious empty case by hiding
  // the button when the folder has 0 photos. ----
  function handleDownloadAll(folderId: string) {
    setOpenMenuFolderId(null);
    window.location.assign(downloadAllApi.ownerFolderUrl(folderId));
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
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="organize-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Organize
        </h1>
        <div className="dashboard-topbar-right">
          <Link href="/upload" className="dashboard-guests-link" data-testid="organize-upload-link">
            Upload
          </Link>
          <Link href="/browse" className="dashboard-guests-link" data-testid="organize-browse-link">
            Browse
          </Link>
          <Link href="/search" className="dashboard-guests-link" data-testid="organize-search-link">
            Search
          </Link>
          <Link href="/guests" className="dashboard-guests-link" data-testid="organize-guests-link">
            Guests
          </Link>
          <Link href="/activity" className="dashboard-guests-link" data-testid="organize-activity-link">
            Activity
          </Link>
        </div>
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
              <li key={folder.id} className="organize-folder-item">
                {renamingFolderId === folder.id ? (
                  // Inline rename edit - replaces the row while active.
                  <div className="organize-rename-row">
                    <input
                      type="text"
                      autoFocus
                      className="organize-rename-input"
                      data-testid={`rename-input-${folder.id}`}
                      value={renameDraft}
                      disabled={renameBusy}
                      onChange={(e) => {
                        setRenameDraft(e.target.value);
                        if (renameError) setRenameError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(folder);
                        if (e.key === "Escape") cancelRename();
                      }}
                    />
                    <button
                      type="button"
                      className="organize-rename-save"
                      data-testid={`rename-save-${folder.id}`}
                      disabled={renameBusy || !renameDraft.trim()}
                      onClick={() => commitRename(folder)}
                    >
                      {renameBusy ? "…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="organize-rename-cancel"
                      data-testid={`rename-cancel-${folder.id}`}
                      disabled={renameBusy}
                      onClick={cancelRename}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="organize-folder-rowwrap">
                    <button
                      type="button"
                      data-testid={`folder-row-${folder.name}`}
                      className={`organize-folder-row${folder.id === selectedFolderId ? " active" : ""}`}
                      onClick={() => setSelectedFolderId(folder.id)}
                    >
                      <span>{folder.name}</span>
                      <span className="count">{folder.photoCount}</span>
                    </button>
                    <button
                      type="button"
                      className="organize-kebab"
                      data-testid={`folder-kebab-${folder.id}`}
                      aria-label={`Folder actions for ${folder.name}`}
                      aria-haspopup="menu"
                      aria-expanded={openMenuFolderId === folder.id}
                      onClick={() =>
                        setOpenMenuFolderId((prev) => (prev === folder.id ? null : folder.id))
                      }
                    >
                      ⋯
                    </button>
                    {openMenuFolderId === folder.id && (
                      <div
                        className="organize-kebab-menu"
                        role="menu"
                        data-testid={`folder-menu-${folder.id}`}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="organize-kebab-item"
                          data-testid={`folder-menu-rename-${folder.id}`}
                          onClick={() => startRename(folder)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="organize-kebab-item"
                          data-testid={`folder-menu-merge-${folder.id}`}
                          onClick={() => openMergeDialog(folder)}
                        >
                          Merge into…
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="organize-kebab-item"
                          data-testid={`folder-menu-download-${folder.id}`}
                          disabled={folder.photoCount === 0}
                          onClick={() => handleDownloadAll(folder.id)}
                        >
                          Download all
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="organize-kebab-item organize-kebab-danger"
                          data-testid={`folder-menu-delete-${folder.id}`}
                          onClick={() => openDeleteDialog(folder)}
                        >
                          Delete folder
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {renamingFolderId === folder.id && renameError && (
                  <p className="organize-new-folder-error" data-testid={`rename-error-${folder.id}`}>
                    {renameError}
                  </p>
                )}
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
                {/* P5: owner "Download all" - real folders only (not the virtual
                    Unfiled bucket), and only when the folder has photos. */}
                {!selectedIsUnfiled && selectedFolder.photoCount > 0 && (
                  <button
                    type="button"
                    className="organize-downloadall-btn"
                    data-testid="organize-download-all"
                    onClick={() => handleDownloadAll(selectedFolder.id)}
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
                  <div className="organize-grid" data-testid="organize-grid">
                    {photos.map((photo, i) => (
                      <PhotoCard
                        key={photo.id}
                        photo={photo}
                        folders={folders}
                        currentFolderId={selectedFolder.id}
                        onMove={handleMove}
                        onReclassify={handleReclassify}
                        onOpenViewer={() => setViewerIndex(i)}
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

      {viewerIndex !== null && (
        <PhotoViewer
          photos={viewerPhotos}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}

      {/* P4 Merge dialog. Destination = the owner's OTHER folders in this
          collection (all `folders` minus the source). Shows the consequence
          copy; the F1 409 flips to the shared-with-guest block. */}
      {mergeDialogFolder && (
        <div
          className="organize-modal-backdrop"
          data-testid="merge-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget && !mergeBusy) closeMergeDialog();
          }}
        >
          <div className="organize-modal">
            {mergeBlocked ? (
              <div className="organize-shared-block" data-testid="merge-shared-block">
                <h3>Can&apos;t merge — this folder is shared with a guest</h3>
                <p>
                  “{mergeDialogFolder.name}” is currently shared with a guest. Revoke the share first, then merge.
                </p>
                <p className="organize-shared-block-sub">Server returned 409. Nothing was moved or deleted.</p>
                <div className="organize-modal-actions">
                  <Link href="/guests" className="organize-shared-block-link" data-testid="merge-goto-guests">
                    Go to Guests →
                  </Link>
                  <button type="button" className="organize-modal-cancel" onClick={closeMergeDialog}>
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h3>Merge “{mergeDialogFolder.name}” into another folder</h3>
                <p className="organize-modal-sub">
                  All {mergeDialogFolder.photoCount} photos move to the destination; “{mergeDialogFolder.name}” is
                  then removed.
                </p>
                <label className="activity-filter-label" htmlFor="merge-target-select">
                  DESTINATION
                </label>
                <select
                  id="merge-target-select"
                  className="activity-select organize-merge-select"
                  data-testid="merge-target-select"
                  value={mergeTargetId}
                  disabled={mergeBusy}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                >
                  <option value="" disabled>
                    Choose a destination folder…
                  </option>
                  {folders
                    .filter((f) => f.id !== mergeDialogFolder.id)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} — {f.photoCount} photos
                      </option>
                    ))}
                </select>
                {folders.filter((f) => f.id !== mergeDialogFolder.id).length === 0 && (
                  <p className="organize-modal-sub">You have no other folder to merge into. Create one first.</p>
                )}
                {mergeError && (
                  <p className="organize-new-folder-error" data-testid="merge-error">
                    {mergeError}
                  </p>
                )}
                <div className="organize-modal-actions">
                  <button
                    type="button"
                    className="organize-modal-confirm"
                    data-testid="merge-confirm"
                    disabled={mergeBusy || !mergeTargetId}
                    onClick={confirmMerge}
                  >
                    {mergeBusy ? "Merging…" : "Merge folders"}
                  </button>
                  <button
                    type="button"
                    className="organize-modal-cancel"
                    data-testid="merge-cancel"
                    disabled={mergeBusy}
                    onClick={closeMergeDialog}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* P4 Delete confirm. The reassurance copy is load-bearing: photos move to
          Unfiled, they are NOT deleted. The F1 409 flips to the shared block. */}
      {deleteDialogFolder && (
        <div
          className="organize-modal-backdrop"
          data-testid="delete-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleteBusy) closeDeleteDialog();
          }}
        >
          <div className="organize-modal">
            {deleteBlocked ? (
              <div className="organize-shared-block" data-testid="delete-shared-block">
                <h3>Can&apos;t delete — this folder is shared with a guest</h3>
                <p>
                  “{deleteDialogFolder.name}” is currently shared with a guest. Revoke the share first, then delete.
                </p>
                <p className="organize-shared-block-sub">Server returned 409. Nothing was moved or deleted.</p>
                <div className="organize-modal-actions">
                  <Link href="/guests" className="organize-shared-block-link" data-testid="delete-goto-guests">
                    Go to Guests →
                  </Link>
                  <button type="button" className="organize-modal-cancel" onClick={closeDeleteDialog}>
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h3>Delete “{deleteDialogFolder.name}”?</h3>
                <div className="organize-delete-reassure" data-testid="delete-reassure">
                  <p className="organize-delete-reassure-title">
                    The {deleteDialogFolder.photoCount} photos in this folder will move to Unfiled — they are not
                    deleted.
                  </p>
                  <p className="organize-delete-reassure-sub">
                    You can re-file them any time from the Unfiled bucket. Only the folder is removed.
                  </p>
                </div>
                {deleteError && (
                  <p className="organize-new-folder-error" data-testid="delete-error">
                    {deleteError}
                  </p>
                )}
                <div className="organize-modal-actions">
                  <button
                    type="button"
                    className="organize-modal-delete"
                    data-testid="delete-confirm"
                    disabled={deleteBusy}
                    onClick={confirmDelete}
                  >
                    {deleteBusy ? "Deleting…" : "Delete folder"}
                  </button>
                  <button
                    type="button"
                    className="organize-modal-cancel"
                    data-testid="delete-cancel"
                    disabled={deleteBusy}
                    onClick={closeDeleteDialog}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function PhotoCard({
  photo,
  folders,
  currentFolderId,
  onMove,
  onReclassify,
  onOpenViewer,
}: {
  photo: CardState;
  folders: Folder[];
  currentFolderId: string;
  onMove: (photoId: string, targetFolderId: string) => void;
  onReclassify: (photoId: string) => void;
  onOpenViewer: () => void;
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
      <button
        type="button"
        className="organize-card-thumb"
        data-testid={`photo-thumb-${photo.id}`}
        onClick={onOpenViewer}
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
