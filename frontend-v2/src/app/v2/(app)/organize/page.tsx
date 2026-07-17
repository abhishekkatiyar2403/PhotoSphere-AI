"use client";

// v2 Organize - folder cards with the design's animated 3-slot cover mosaic
// (hovering a slot swaps it into the big position), a kebab menu with inline
// rename / "Merge into…" submenu / download all / delete, and an in-place
// folder detail view (back arrow, same URL). Detail view renders the
// design's photo cards: always-visible select checkbox, tag chips, a
// "Move to…" pop-up menu, download + delete icon buttons, drag-to-move drop
// chips, and a fixed bulk-selection bar. All actions are wired to the same
// real endpoints the classic /organize page uses (foldersApi rename/merge/
// remove with the F1 shared-with-guest 409 surfaced as a toast, photosApi
// move/remove/bulkMove/bulkDelete/downloadMany, downloadAllApi).

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  collectionsApi,
  downloadAllApi,
  Folder,
  FolderPhoto,
  folderPhotosApi,
  foldersApi,
  photosApi,
  unfiledPhotosApi,
} from "@/lib/api";
import { PhotoViewerV2, type ViewerOrigin, type ViewerPhotoRef } from "@/components/v2/PhotoViewerV2";
import { useToast } from "@/components/v2/ToastProviderV2";
import { SkeletonTiles } from "@/components/v2/SkeletonGrid";
import { useIsMobile } from "@/components/v2/useIsMobile";

// The design lists every photo of a folder in one grid (no pager). 100 is
// the pragmatic single-fetch cap; "Select all on page" applies to it.
const PAGE_LIMIT = 100;
const UNFILED_ID = "__unfiled__";

type FolderCard = { folder: Folder; covers: (string | null)[] };
type CardState = FolderPhoto & { moving: boolean };

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// "updated 2d ago" style relative label (the design's folder meta line).
function relTime(iso: string | null | undefined): string {
  if (!iso) return "just now";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const SLOT_POSITIONS = {
  big: { left: "0%", top: "0%", width: "66%", height: "100%" },
  topSmall: { left: "68%", top: "0%", width: "32%", height: "48%" },
  bottomSmall: { left: "68%", top: "52%", width: "32%", height: "48%" },
};

// Design mosaic: three absolutely-positioned slots; hovering a slot animates
// it into the big (left) position while the others tuck into the stack.
function MosaicCovers({ covers }: { covers: (string | null)[] }) {
  const [big, setBig] = useState(0);
  const others = [0, 1, 2].filter((i) => i !== big);
  const posFor = (i: number) =>
    i === big ? SLOT_POSITIONS.big : others.indexOf(i) === 0 ? SLOT_POSITIONS.topSmall : SLOT_POSITIONS.bottomSmall;

  return (
    <div style={{ position: "relative", height: 130, marginBottom: 14 }} onMouseLeave={() => setBig(0)}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            ...posFor(i),
            borderRadius: i === 0 ? 11 : 10,
            overflow: "hidden",
            boxShadow: i === 0 ? undefined : "0 4px 10px rgba(0,0,0,.25)",
            transition:
              "left .4s cubic-bezier(.2,.8,.2,1), top .4s cubic-bezier(.2,.8,.2,1), width .4s cubic-bezier(.2,.8,.2,1), height .4s cubic-bezier(.2,.8,.2,1)",
            zIndex: 1,
          }}
        >
          {covers[i] ? (
            <img src={covers[i] as string} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          ) : (
            <div style={{ width: "100%", height: "100%", background: "var(--ps2-tile)" }} />
          )}
        </div>
      ))}
      <div onMouseEnter={() => setBig(0)} style={{ position: "absolute", ...SLOT_POSITIONS.big, zIndex: 2 }} />
      <div onMouseEnter={() => setBig(1)} style={{ position: "absolute", ...SLOT_POSITIONS.topSmall, zIndex: 2 }} />
      <div onMouseEnter={() => setBig(2)} style={{ position: "absolute", ...SLOT_POSITIONS.bottomSmall, zIndex: 2 }} />
    </div>
  );
}

const menuItemStyle: CSSProperties = {
  width: "100%",
  textAlign: "left",
  padding: "8px 9px",
  border: "none",
  background: "transparent",
  borderRadius: 8,
  color: "var(--ps2-text)",
  fontFamily: "inherit",
  fontSize: 12.5,
  cursor: "pointer",
  transition: "background .2s",
};

export default function OrganizeV2Page() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const showToast = useToast();

  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [folderCards, setFolderCards] = useState<FolderCard[]>([]);
  const [unfiled, setUnfiled] = useState<{ count: number; covers: (string | null)[] }>({ count: 0, covers: [] });
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [foldersError, setFoldersError] = useState<string | null>(null);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<CardState[]>([]);
  const [total, setTotal] = useState(0);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridError, setGridError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerOrigin, setViewerOrigin] = useState<ViewerOrigin | null>(null);
  const [draggingPhotoId, setDraggingPhotoId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moveMenuPhotoId, setMoveMenuPhotoId] = useState<string | null>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [openMenuFolderId, setOpenMenuFolderId] = useState<string | null>(null);
  const [mergeOpenFolderId, setMergeOpenFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const gridRequestIdRef = useRef(0);
  const collectionIdRef = useRef<string | null>(null);
  collectionIdRef.current = collectionId;

  const folders = folderCards.map((c) => c.folder);

  // Design: clicking outside a [data-folder-menu] / [data-move-menu] closes it.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-folder-menu]")) {
        setOpenMenuFolderId(null);
        setMergeOpenFolderId(null);
      }
      if (!target.closest("[data-move-menu]")) setMoveMenuPhotoId(null);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const loadFolderGrid = useCallback(async (cId: string | null) => {
    setFoldersError(null);
    try {
      const [foldersRes, unfiledRes] = await Promise.all([
        cId ? foldersApi.list(cId) : Promise.resolve({ folders: [] as Folder[] }),
        unfiledPhotosApi.list({ limit: 3, offset: 0 }),
      ]);
      const cards = await Promise.all(
        foldersRes.folders.map(async (folder): Promise<FolderCard> => {
          if (folder.photoCount === 0) return { folder, covers: [null, null, null] };
          const photosRes = await folderPhotosApi.list(folder.id, { limit: 3, offset: 0 });
          return { folder, covers: [0, 1, 2].map((i) => photosRes.photos[i]?.thumbnailUrl ?? null) };
        }),
      );
      setFolderCards(cards);
      setUnfiled({ count: unfiledRes.total, covers: [0, 1, 2].map((i) => unfiledRes.photos[i]?.thumbnailUrl ?? null) });
      return foldersRes.folders;
    } catch (err) {
      if (isAuthError(err)) return [];
      setFoldersError(err instanceof Error ? err.message : "Failed to load folders");
      return [];
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await collectionsApi.list();
        if (cancelled) return;
        const defaultCollection = res.collections.find((c) => c.isDefault) ?? res.collections[0] ?? null;
        setCollectionId(defaultCollection?.id ?? null);
        await loadFolderGrid(defaultCollection?.id ?? null);
      } catch (err) {
        if (cancelled) return;
        if (!isAuthError(err)) setFoldersError(err instanceof Error ? err.message : "Failed to load collections");
        setFoldersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFolderGrid]);

  const loadFolderPhotos = useCallback(async (folderId: string) => {
    const requestId = ++gridRequestIdRef.current;
    setGridLoading(true);
    setGridError(null);
    try {
      const res =
        folderId === UNFILED_ID
          ? await unfiledPhotosApi.list({ limit: PAGE_LIMIT, offset: 0 })
          : await folderPhotosApi.list(folderId, { limit: PAGE_LIMIT, offset: 0 });
      if (requestId !== gridRequestIdRef.current) return;
      setPhotos(res.photos.map((p) => ({ ...p, moving: false })));
      setTotal(res.total);
    } catch (err) {
      if (requestId !== gridRequestIdRef.current) return;
      if (!isAuthError(err)) setGridError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      if (requestId === gridRequestIdRef.current) setGridLoading(false);
    }
  }, []);

  function openFolder(folderId: string) {
    setSelectedFolderId(folderId);
    setSelectedIds(new Set());
    setMoveMenuPhotoId(null);
    loadFolderPhotos(folderId);
  }

  function backToFolders() {
    setSelectedFolderId(null);
    setPhotos([]);
    setSelectedIds(new Set());
    setMoveMenuPhotoId(null);
  }

  async function handleCreateFolder() {
    if (!collectionId || creatingFolder) return;
    const name = newFolderName.trim();
    if (!name) return;
    setCreatingFolder(true);
    try {
      await foldersApi.create(collectionId, name);
      setNewFolderName("");
      setNewFolderOpen(false);
      await loadFolderGrid(collectionId);
    } catch (err) {
      if (isAuthError(err)) return;
      if (err instanceof ApiError && err.status === 409) showToast("A folder with this name already exists");
      else showToast(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setCreatingFolder(false);
    }
  }

  function startRename(folder: Folder) {
    setOpenMenuFolderId(null);
    setMergeOpenFolderId(null);
    setRenamingFolderId(folder.id);
    setRenameDraft(folder.name);
  }

  async function commitRename(folder: Folder) {
    if (renameBusy) return;
    const name = renameDraft.trim();
    if (!name || name === folder.name) {
      setRenamingFolderId(null);
      return;
    }
    setRenameBusy(true);
    try {
      await foldersApi.rename(folder.id, name);
      setRenamingFolderId(null);
      await loadFolderGrid(collectionIdRef.current);
    } catch (err) {
      if (isAuthError(err)) return;
      if (err instanceof ApiError && err.status === 409) showToast("A folder with that name already exists");
      else showToast(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setRenameBusy(false);
    }
  }

  async function handleMerge(source: Folder, targetId: string) {
    setOpenMenuFolderId(null);
    setMergeOpenFolderId(null);
    try {
      await foldersApi.merge(source.id, targetId);
      await loadFolderGrid(collectionIdRef.current);
      if (selectedFolderId === source.id) backToFolders();
    } catch (err) {
      if (isAuthError(err)) return;
      if (err instanceof ApiError && err.status === 409)
        showToast("This folder is shared with a guest — revoke the share before merging");
      else showToast(err instanceof Error ? err.message : "Merge failed");
    }
  }

  async function handleDeleteFolder(folder: Folder) {
    setOpenMenuFolderId(null);
    setMergeOpenFolderId(null);
    try {
      await foldersApi.remove(folder.id);
      await loadFolderGrid(collectionIdRef.current);
      if (selectedFolderId === folder.id) backToFolders();
    } catch (err) {
      if (isAuthError(err)) return;
      if (err instanceof ApiError && err.status === 409)
        showToast("This folder is shared with a guest — revoke the share before deleting");
      else showToast(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function handleDownloadAll(folderId: string) {
    setOpenMenuFolderId(null);
    window.location.assign(downloadAllApi.ownerFolderUrl(folderId));
  }

  async function handleMove(photoId: string, targetFolderId: string) {
    if (!targetFolderId || !selectedFolderId) return;
    setMoveMenuPhotoId(null);
    setPhotos((prev) => prev.map((p) => (p.id === photoId ? { ...p, moving: true } : p)));
    try {
      await photosApi.move(photoId, targetFolderId);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      setTotal((prev) => Math.max(0, prev - 1));
      setSelectedIds((prev) => {
        if (!prev.has(photoId)) return prev;
        const next = new Set(prev);
        next.delete(photoId);
        return next;
      });
      loadFolderGrid(collectionIdRef.current);
    } catch (err) {
      if (isAuthError(err)) return;
      setPhotos((prev) => prev.map((p) => (p.id === photoId ? { ...p, moving: false } : p)));
      showToast(err instanceof Error ? err.message : "Move failed");
    }
  }

  async function handleDownloadPhoto(photo: CardState) {
    try {
      const detail = await photosApi.get(photo.id);
      window.location.assign(detail.download.url);
    } catch (err) {
      if (isAuthError(err)) return;
      showToast(err instanceof Error ? err.message : "Download failed");
    }
  }

  async function handleDeletePhoto(photoId: string) {
    try {
      await photosApi.remove(photoId);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      setTotal((prev) => Math.max(0, prev - 1));
      setSelectedIds((prev) => {
        if (!prev.has(photoId)) return prev;
        const next = new Set(prev);
        next.delete(photoId);
        return next;
      });
      loadFolderGrid(collectionIdRef.current);
    } catch (err) {
      if (isAuthError(err)) return;
      showToast(err instanceof Error ? err.message : "Delete failed");
    }
  }

  function toggleSelected(photoId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  async function handleBulkMove(targetFolderId: string) {
    if (!targetFolderId || selectedIds.size === 0) return;
    try {
      const res = await photosApi.bulkMove([...selectedIds], targetFolderId);
      showToast(`${res.moved.length} moved to "${res.folderName}"${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      setSelectedIds(new Set());
      if (selectedFolderId) loadFolderPhotos(selectedFolderId);
      loadFolderGrid(collectionIdRef.current);
    } catch (err) {
      if (isAuthError(err)) return;
      showToast(err instanceof Error ? err.message : "Failed to move photos");
    }
  }

  async function handleBulkDownload() {
    try {
      await photosApi.downloadMany([...selectedIds]);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Download failed");
    }
  }

  async function handleBulkDelete() {
    try {
      const res = await photosApi.bulkDelete([...selectedIds]);
      showToast(`${res.deleted.length} moved to Trash${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      setSelectedIds(new Set());
      if (selectedFolderId) loadFolderPhotos(selectedFolderId);
      loadFolderGrid(collectionIdRef.current);
    } catch (err) {
      if (isAuthError(err)) return;
      showToast(err instanceof Error ? err.message : "Failed to delete photos");
    }
  }

  function handleViewerDeleted(photoId: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    setViewerIndex(null);
    setTotal((prev) => Math.max(0, prev - 1));
    showToast("Moved to Trash");
    loadFolderGrid(collectionIdRef.current);
  }

  const selectedIsUnfiled = selectedFolderId === UNFILED_ID;
  const selectedFolder = selectedIsUnfiled
    ? { id: UNFILED_ID, name: "Unfiled", photoCount: unfiled.count }
    : (folders.find((f) => f.id === selectedFolderId) ?? null);
  const viewerPhotos: ViewerPhotoRef[] = photos.map((p) => ({
    id: p.id,
    originalFilename: p.originalFilename,
    status: p.status,
    duplicateOfLabel: null,
    thumbSrc: p.thumbnailUrl,
  }));
  const moveTargets = folders.filter((f) => f.id !== selectedFolderId);
  const isDragging = draggingPhotoId !== null;

  // All folder cards in one list: real folders, plus the virtual Unfiled
  // bucket rendered exactly like the design's base "Unfiled" folder.
  type CardEntry = { id: string; name: string; count: number; updated: string; covers: (string | null)[]; virtual: boolean };
  const cardEntries: CardEntry[] = [
    ...folderCards.map(({ folder, covers }) => ({
      id: folder.id,
      name: folder.name,
      count: folder.photoCount,
      updated: relTime(folder.createdAt),
      covers,
      virtual: false,
    })),
    { id: UNFILED_ID, name: "Unfiled", count: unfiled.count, updated: "just now", covers: unfiled.covers, virtual: true },
  ];

  return (
    <main style={{ padding: "38px 32px 60px", maxWidth: 1240, width: "100%", margin: "0 auto", position: "relative", zIndex: 1 }}>
      <style>{`
        .ogv2-card:hover { transform: translateY(-4px); border-color: var(--ps2-accent) !important; }
        .ogv2-kebab:hover { background: rgba(10,11,16,.85) !important; border-color: var(--ps2-accent) !important; }
        .ogv2-menu-item:hover { background: color-mix(in oklab, var(--ps2-text) 7%, transparent); }
        .ogv2-menu-item.danger:hover { background: color-mix(in oklab, #e87f8f 12%, transparent); }
        .ogv2-menu-sub:hover { background: color-mix(in oklab, var(--ps2-text) 7%, transparent); color: var(--ps2-text) !important; }
        .ogv2-ghostbtn:hover { border-color: var(--ps2-accent) !important; }
        .ogv2-accentbtn:hover { background: color-mix(in oklab, var(--ps2-accent) 12%, transparent) !important; }
        .ogv2-photo:hover { transform: translateY(-5px); box-shadow: var(--ps2-shadow); }
        .ogv2-photo-img:hover { transform: scale(1.05); }
        .ogv2-moveopt:hover { background: color-mix(in oklab, var(--ps2-accent) 14%, transparent); }
        .ogv2-dlbtn:hover { border-color: var(--ps2-accent) !important; color: var(--ps2-accent) !important; }
        .ogv2-delbtn:hover { background: color-mix(in oklab, #e87f8f 14%, transparent) !important; }
        .ogv2-cancelbtn:hover { color: var(--ps2-text) !important; }
        .ogv2-modal-input:focus { border-color: var(--ps2-accent) !important; }
      `}</style>

      {!selectedFolderId ? (
        <>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", animation: "ps2Up .6s both" }}>
            <h1 style={{ fontFamily: "var(--ps2-font-serif)", fontWeight: 400, fontSize: 36, margin: 0 }}>Organize</h1>
            <button
              type="button"
              className="ogv2-ghostbtn"
              onClick={() => {
                setNewFolderOpen(true);
                setNewFolderName("");
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                borderRadius: 11,
                border: "1px solid var(--ps2-border)",
                background: "var(--ps2-panel)",
                color: "var(--ps2-text)",
                padding: "10px 16px",
                fontSize: 13.5,
                fontFamily: "inherit",
                cursor: "pointer",
                transition: "border-color .25s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New folder
            </button>
          </div>

          {foldersLoading && <SkeletonTiles count={6} />}
          {foldersError && <p className="ps2-error">{foldersError}</p>}

          {!foldersLoading && !foldersError && (
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3,1fr)", gap: 16, marginTop: 26 }}>
              {cardEntries.map((entry) => {
                const folder = entry.virtual ? null : (folders.find((f) => f.id === entry.id) ?? null);
                return (
                  <div
                    key={entry.id}
                    className="ogv2-card"
                    style={{
                      position: "relative",
                      borderRadius: 18,
                      background: "var(--ps2-panel)",
                      border: "1px solid var(--ps2-border)",
                      padding: 18,
                      animation: "ps2In .6s both",
                      transition: "transform .3s, border-color .3s",
                    }}
                  >
                    {folder && (
                      <div data-folder-menu style={{ position: "absolute", top: 14, right: 14, zIndex: 5 }}>
                        <button
                          type="button"
                          className="ogv2-kebab"
                          title="Folder options"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuFolderId((prev) => (prev === folder.id ? null : folder.id));
                            setMergeOpenFolderId(null);
                          }}
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 9,
                            border: "1px solid rgba(255,255,255,.14)",
                            background: "rgba(10,11,16,.6)",
                            backdropFilter: "blur(6px)",
                            boxShadow: "0 4px 12px rgba(0,0,0,.35)",
                            color: "#f4f5f8",
                            cursor: "pointer",
                            display: "grid",
                            placeItems: "center",
                            transition: "background .2s, border-color .2s",
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="2" />
                            <circle cx="12" cy="12" r="2" />
                            <circle cx="12" cy="19" r="2" />
                          </svg>
                        </button>
                        {openMenuFolderId === folder.id && (
                          <div
                            style={{
                              position: "absolute",
                              right: 0,
                              top: "calc(100% + 6px)",
                              width: 170,
                              borderRadius: 10,
                              background: "var(--ps2-panel2)",
                              border: "1px solid var(--ps2-border)",
                              boxShadow: "var(--ps2-shadow)",
                              padding: 6,
                              zIndex: 20,
                              animation: "ps2In .15s both",
                            }}
                          >
                            <button
                              type="button"
                              className="ogv2-menu-item"
                              style={menuItemStyle}
                              onClick={(e) => {
                                e.stopPropagation();
                                startRename(folder);
                              }}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="ogv2-menu-item"
                              style={menuItemStyle}
                              onClick={(e) => {
                                e.stopPropagation();
                                setMergeOpenFolderId((prev) => (prev === folder.id ? null : folder.id));
                              }}
                            >
                              Merge into…
                            </button>
                            {mergeOpenFolderId === folder.id && (
                              <div style={{ maxHeight: 150, overflowY: "auto", margin: "2px 0 4px", paddingLeft: 6, borderLeft: "2px solid var(--ps2-border)" }}>
                                {folders
                                  .filter((f) => f.id !== folder.id)
                                  .map((target) => (
                                    <button
                                      key={target.id}
                                      type="button"
                                      className="ogv2-menu-sub"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleMerge(folder, target.id);
                                      }}
                                      style={{
                                        width: "100%",
                                        textAlign: "left",
                                        padding: "7px 9px",
                                        border: "none",
                                        background: "transparent",
                                        borderRadius: 8,
                                        color: "var(--ps2-muted)",
                                        fontFamily: "inherit",
                                        fontSize: 12,
                                        cursor: "pointer",
                                        transition: "background .2s, color .2s",
                                      }}
                                    >
                                      {target.name}
                                    </button>
                                  ))}
                              </div>
                            )}
                            <button
                              type="button"
                              className="ogv2-menu-item"
                              style={menuItemStyle}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDownloadAll(folder.id);
                              }}
                            >
                              Download all
                            </button>
                            <button
                              type="button"
                              className="ogv2-menu-item danger"
                              style={{ ...menuItemStyle, color: "#e87f8f" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteFolder(folder);
                              }}
                            >
                              Delete folder
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <div onClick={() => openFolder(entry.id)} style={{ cursor: "pointer" }}>
                      <MosaicCovers covers={entry.covers} />
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          {folder && renamingFolderId === folder.id ? (
                            <input
                              autoFocus
                              value={renameDraft}
                              disabled={renameBusy}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename(folder);
                                if (e.key === "Escape") setRenamingFolderId(null);
                              }}
                              style={{
                                background: "var(--ps2-bg)",
                                border: "1px solid var(--ps2-accent)",
                                borderRadius: 8,
                                padding: "5px 8px",
                                fontSize: 14,
                                fontFamily: "inherit",
                                color: "var(--ps2-text)",
                                width: 150,
                                outline: "none",
                              }}
                            />
                          ) : (
                            <div style={{ fontSize: 15, fontWeight: 600 }}>{entry.name}</div>
                          )}
                          <div style={{ fontSize: 12.5, color: "var(--ps2-muted)", marginTop: 2 }}>
                            {entry.count} photos · updated {entry.updated}
                          </div>
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--ps2-accent)",
                            border: "1px solid color-mix(in oklab, var(--ps2-accent) 40%, transparent)",
                            borderRadius: 99,
                            padding: "4px 10px",
                          }}
                        >
                          Open →
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 14, animation: "ps2Up .6s both" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
              <button
                type="button"
                className="ogv2-ghostbtn"
                onClick={backToFolders}
                style={{
                  width: 38,
                  height: 38,
                  flex: "none",
                  borderRadius: 11,
                  border: "1px solid var(--ps2-border)",
                  background: "var(--ps2-panel)",
                  color: "var(--ps2-text)",
                  cursor: "pointer",
                  display: "grid",
                  placeItems: "center",
                  transition: "border-color .2s",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 18-6-6 6-6" />
                </svg>
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ fontFamily: "var(--ps2-font-serif)", fontWeight: 400, fontSize: 32, margin: 0 }}>{selectedFolder?.name}</h1>
                <div style={{ fontSize: 13, color: "var(--ps2-muted)", marginTop: 2 }}>
                  {total} {total === 1 ? "photo" : "photos"}
                </div>
              </div>
            </div>
            {photos.length > 0 && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", width: isMobile ? "100%" : "auto" }}>
                {!selectedIsUnfiled && (
                  <button
                    type="button"
                    className="ogv2-accentbtn"
                    onClick={() => selectedFolder && handleDownloadAll(selectedFolder.id)}
                    style={{
                      flex: isMobile ? "1" : "none",
                      borderRadius: 11,
                      border: "1px solid var(--ps2-accent)",
                      background: "transparent",
                      color: "var(--ps2-accent)",
                      padding: "10px 16px",
                      fontSize: 13.5,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      transition: "background .2s",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Download all
                  </button>
                )}
                <button
                  type="button"
                  className="ogv2-ghostbtn"
                  onClick={() => setSelectedIds(new Set(photos.map((p) => p.id)))}
                  style={{
                    flex: isMobile ? "1" : "none",
                    borderRadius: 11,
                    border: "1px solid var(--ps2-border)",
                    background: "var(--ps2-panel)",
                    color: "var(--ps2-text)",
                    padding: "10px 16px",
                    fontSize: 13.5,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    transition: "border-color .2s",
                    whiteSpace: "nowrap",
                  }}
                >
                  Select all on page
                </button>
              </div>
            )}
          </div>

          {isDragging && moveTargets.length > 0 && (
            <div
              style={{
                marginTop: 16,
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
                padding: 12,
                borderRadius: 14,
                border: "1.5px dashed var(--ps2-accent)",
                background: "color-mix(in oklab, var(--ps2-accent) 7%, transparent)",
                animation: "ps2In .2s both",
              }}
            >
              <span style={{ fontSize: 12.5, color: "var(--ps2-accent)", fontWeight: 600 }}>Drop to move into:</span>
              {moveTargets.map((f) => (
                <div
                  key={f.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const photoId = draggingPhotoId;
                    setDraggingPhotoId(null);
                    if (photoId) handleMove(photoId, f.id);
                  }}
                  style={{
                    borderRadius: 99,
                    border: "1px solid var(--ps2-accent)",
                    padding: "9px 18px",
                    fontSize: 12.5,
                    color: "var(--ps2-text)",
                    background: "var(--ps2-panel)",
                  }}
                >
                  {f.name}
                </div>
              ))}
            </div>
          )}

          {gridError && <p className="ps2-error">{gridError}</p>}
          {gridLoading && <SkeletonTiles count={12} />}

          {!gridLoading && photos.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill,minmax(258px,1fr))",
                gap: 20,
                marginTop: 24,
                paddingBottom: 110,
              }}
            >
              {photos.map((photo, i) => {
                const selected = selectedIds.has(photo.id);
                const moveOpen = moveMenuPhotoId === photo.id;
                const openViewer = (e: ReactMouseEvent<HTMLElement>) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setViewerOrigin({ rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }, src: photo.thumbnailUrl });
                  setViewerIndex(i);
                };
                return (
                  <div
                    key={photo.id}
                    className="ogv2-photo"
                    draggable={!photo.moving}
                    onDragStart={() => setDraggingPhotoId(photo.id)}
                    onDragEnd={() => setDraggingPhotoId(null)}
                    style={{
                      position: "relative",
                      borderRadius: 20,
                      background: "var(--ps2-panel)",
                      border: `1px solid ${selected ? "var(--ps2-accent)" : "var(--ps2-border)"}`,
                      overflow: "hidden",
                      transition: "border-color .3s, transform .35s cubic-bezier(.2,.8,.2,1), box-shadow .35s",
                    }}
                  >
                    <div
                      onClick={() => toggleSelected(photo.id)}
                      style={{
                        position: "absolute",
                        top: 13,
                        left: 13,
                        width: 25,
                        height: 25,
                        borderRadius: 8,
                        background: selected ? "var(--ps2-accent)" : "var(--ps2-panel)",
                        border: `1.5px solid ${selected ? "var(--ps2-accent)" : "var(--ps2-border)"}`,
                        cursor: "pointer",
                        display: "grid",
                        placeItems: "center",
                        zIndex: 6,
                        backdropFilter: "blur(6px)",
                        transition: "background .2s, border-color .2s",
                      }}
                    >
                      {selected && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#141118" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </div>
                    <div onClick={openViewer} style={{ cursor: "pointer", aspectRatio: "4/3", background: "var(--ps2-tile)", overflow: "hidden" }}>
                      {photo.thumbnailUrl && (
                        <img
                          className="ogv2-photo-img"
                          src={photo.thumbnailUrl}
                          alt={photo.originalFilename}
                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", transition: "transform .5s cubic-bezier(.2,.8,.2,1)" }}
                        />
                      )}
                    </div>
                    <div style={{ padding: "16px 16px 15px" }}>
                      <div
                        onClick={openViewer}
                        style={{
                          cursor: "pointer",
                          fontSize: 14.5,
                          fontWeight: 600,
                          letterSpacing: "-.01em",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {photo.originalFilename}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
                        {photo.aiLabels.slice(0, 3).map((label) => (
                          <span
                            key={label}
                            style={{
                              fontSize: 10.5,
                              fontWeight: 500,
                              padding: "3.5px 10px",
                              borderRadius: 99,
                              background: "color-mix(in oklab, var(--ps2-accent) 13%, var(--ps2-panel2))",
                              color: "var(--ps2-accent)",
                              border: "1px solid color-mix(in oklab, var(--ps2-accent) 28%, transparent)",
                            }}
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 15 }}>
                        <div data-move-menu style={{ position: "relative", flex: 1, minWidth: 0 }}>
                          <button
                            type="button"
                            className="ogv2-ghostbtn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMoveMenuPhotoId((prev) => (prev === photo.id ? null : photo.id));
                            }}
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 6,
                              background: "var(--ps2-panel2)",
                              border: "1px solid var(--ps2-border)",
                              borderRadius: 10,
                              padding: "10px 11px",
                              fontSize: 12.5,
                              fontFamily: "inherit",
                              color: "var(--ps2-text)",
                              cursor: "pointer",
                              transition: "border-color .2s",
                            }}
                          >
                            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {photo.moving ? "Moving…" : "Move to…"}
                            </span>
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{ flex: "none", transform: moveOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                            >
                              <path d="m6 9 6 6 6-6" />
                            </svg>
                          </button>
                          {moveOpen && (
                            <div
                              style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                bottom: "calc(100% + 8px)",
                                maxHeight: 190,
                                overflowY: "auto",
                                borderRadius: 12,
                                background: "var(--ps2-panel2)",
                                border: "1px solid var(--ps2-border)",
                                boxShadow: "var(--ps2-shadow)",
                                padding: 6,
                                zIndex: 30,
                                animation: "ps2In .15s cubic-bezier(.2,.8,.2,1) both",
                              }}
                            >
                              {moveTargets.map((f) => (
                                <button
                                  key={f.id}
                                  type="button"
                                  className="ogv2-moveopt"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleMove(photo.id, f.id);
                                  }}
                                  style={{
                                    width: "100%",
                                    textAlign: "left",
                                    padding: "9px 10px",
                                    border: "none",
                                    background: "transparent",
                                    borderRadius: 8,
                                    color: "var(--ps2-text)",
                                    fontFamily: "inherit",
                                    fontSize: 12.5,
                                    cursor: "pointer",
                                    transition: "background .2s",
                                  }}
                                >
                                  {f.name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="ogv2-dlbtn"
                          title="Download"
                          onClick={() => handleDownloadPhoto(photo)}
                          style={{
                            width: 38,
                            height: 38,
                            flex: "none",
                            borderRadius: 10,
                            border: "1px solid var(--ps2-border)",
                            background: "transparent",
                            color: "var(--ps2-text)",
                            cursor: "pointer",
                            display: "grid",
                            placeItems: "center",
                            transition: "border-color .2s, color .2s",
                          }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 4v12m-6-6 6 6 6-6M4 20h16" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="ogv2-delbtn"
                          title="Delete"
                          onClick={() => handleDeletePhoto(photo.id)}
                          style={{
                            width: 38,
                            height: 38,
                            flex: "none",
                            borderRadius: 10,
                            border: "1px solid color-mix(in oklab, #e87f8f 45%, var(--ps2-border))",
                            background: "transparent",
                            color: "#e87f8f",
                            cursor: "pointer",
                            display: "grid",
                            placeItems: "center",
                            transition: "background .2s",
                          }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!gridLoading && !gridError && photos.length === 0 && (
            <div
              style={{
                marginTop: 26,
                borderRadius: 20,
                border: "1.5px dashed var(--ps2-border)",
                padding: "60px 30px",
                textAlign: "center",
                color: "var(--ps2-muted)",
              }}
            >
              <div style={{ fontFamily: "var(--ps2-font-serif)", fontStyle: "italic", fontSize: 22, color: "var(--ps2-text)", marginBottom: 8 }}>
                No photos in this folder yet.
              </div>
              <div style={{ fontSize: 13.5, marginBottom: 18 }}>Upload photos or move some in from your library.</div>
              <button
                type="button"
                onClick={() => router.push("/v2/upload")}
                style={{
                  borderRadius: 11,
                  border: "none",
                  background: "var(--ps2-accent)",
                  color: "#141118",
                  padding: "11px 20px",
                  fontSize: 13.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Upload photos
              </button>
            </div>
          )}
        </>
      )}

      {/* ---- Bulk selection bar ---- */}
      {selectedIds.size > 0 && (
        <div
          style={{
            position: "fixed",
            left: isMobile ? "0px" : "236px",
            right: 0,
            bottom: isMobile ? "58px" : "0px",
            zIndex: 150,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "16px 28px",
            background: "var(--ps2-panel)",
            borderTop: "1px solid var(--ps2-border)",
            boxShadow: "0 -12px 30px rgba(0,0,0,.3)",
            animation: "ps2Up .25s cubic-bezier(.2,.8,.2,1) both",
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{selectedIds.size} selected</div>
          <select
            value=""
            onChange={(e) => e.target.value && handleBulkMove(e.target.value)}
            style={{
              background: "var(--ps2-panel2)",
              border: "1px solid var(--ps2-border)",
              borderRadius: 10,
              padding: "10px 14px",
              fontSize: 13,
              fontFamily: "inherit",
              color: "var(--ps2-text)",
              cursor: "pointer",
            }}
          >
            <option value="">Move to…</option>
            {moveTargets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ogv2-ghostbtn"
            onClick={handleBulkDownload}
            style={{
              borderRadius: 10,
              border: "1px solid var(--ps2-border)",
              background: "transparent",
              color: "var(--ps2-text)",
              padding: "10px 16px",
              fontSize: 13,
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "border-color .2s",
            }}
          >
            Download selected
          </button>
          <button
            type="button"
            onClick={handleBulkDelete}
            style={{
              borderRadius: 10,
              border: "none",
              background: "#e87f8f",
              color: "#2a0a10",
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            Delete selected
          </button>
          <button
            type="button"
            className="ogv2-cancelbtn"
            onClick={() => setSelectedIds(new Set())}
            style={{
              marginLeft: "auto",
              borderRadius: 10,
              border: "1px solid var(--ps2-border)",
              background: "transparent",
              color: "var(--ps2-muted)",
              padding: "10px 16px",
              fontSize: 13,
              fontFamily: "inherit",
              cursor: "pointer",
              transition: "color .2s",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ---- New Folder modal ---- */}
      {newFolderOpen && (
        <div
          onClick={() => !creatingFolder && setNewFolderOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            background: "rgba(5,6,10,.6)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: "ps2In .2s both",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 380,
              maxWidth: "90vw",
              borderRadius: 18,
              background: "var(--ps2-panel)",
              border: "1px solid var(--ps2-border)",
              boxShadow: "var(--ps2-shadow)",
              padding: 24,
              animation: "ps2Up .25s cubic-bezier(.2,.8,.2,1) both",
            }}
          >
            <div style={{ fontFamily: "var(--ps2-font-serif)", fontSize: 24, marginBottom: 16 }}>New folder</div>
            <input
              autoFocus
              className="ogv2-modal-input"
              value={newFolderName}
              placeholder="Folder name"
              disabled={creatingFolder}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
                if (e.key === "Escape" && !creatingFolder) setNewFolderOpen(false);
              }}
              style={{
                width: "100%",
                background: "var(--ps2-bg)",
                border: "1px solid var(--ps2-border)",
                borderRadius: 11,
                padding: "12px 14px",
                fontSize: 14,
                fontFamily: "inherit",
                color: "var(--ps2-text)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="ogv2-ghostbtn"
                onClick={() => setNewFolderOpen(false)}
                disabled={creatingFolder}
                style={{
                  borderRadius: 10,
                  border: "1px solid var(--ps2-border)",
                  background: "transparent",
                  color: "var(--ps2-text)",
                  padding: "10px 18px",
                  fontSize: 13.5,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  transition: "border-color .2s",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateFolder}
                disabled={creatingFolder || !collectionId}
                style={{
                  borderRadius: 10,
                  border: "none",
                  background: "var(--ps2-accent)",
                  color: "#141118",
                  padding: "10px 18px",
                  fontSize: 13.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Create
              </button>
            </div>
          </div>
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
    </main>
  );
}
