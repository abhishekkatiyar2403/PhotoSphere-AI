"use client";

// v2 Trash - synced to PhotoSphere.dc.html (Trash screen, lines 1099-1153):
// one mixed list of trashed photos AND folders (no tabs), always-visible
// row checkboxes, a baseline header that swaps "Empty trash" for
// "Recover (n)" + "Delete forever" while a selection exists, per-row
// clock "N days left" (red when ≤7), outline Recover / Delete forever
// buttons with icons, and the dashed empty state whose note flips to
// "“X” was recovered to its folder." after a recover.
//
// The real recover/purge engine is unchanged (photosApi.restore /
// foldersApi.restore / trashApi.purgeOne / trashApi.emptyAll). Restore can
// 409 with a real conflict the prototype never models (folder name
// collision, original folder purged) - those resolution panels are KEPT
// (design has no equivalent; a Recover button that silently fails would be
// broken), rendered inline under the row.

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  FolderDeletedBody,
  foldersApi,
  isFolderDeletedConflict,
  isRestoreConflict,
  PhotoRestoreOnConflict,
  photosApi,
  RestoreConflictBody,
  trashApi,
  TrashFolderItem,
  TrashPhotoItem,
} from "@/lib/api";
import { SkeletonRows } from "@/components/v2/SkeletonGrid";
import { useToast } from "@/components/v2/ToastProviderV2";
import { useIsMobile } from "@/components/v2/useIsMobile";

const FETCH_LIMIT = 100;
const URGENT_DAYS = 7; // design: dayColor flips red at ≤7 days left

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

function deletedAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return "just now";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "1 day ago" : `${days} days ago`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}

type CollisionState = {
  conflictingFolderId: string;
  conflictingFolderName: string;
  renaming: boolean;
  renameDraft: string;
  busy: boolean;
  error: string | null;
};

type PhotoCollisionState = {
  conflictingFolderId: string;
  conflictingFolderName: string;
  customizingNewName: boolean;
  newNameDraft: string;
  busy: boolean;
  error: string | null;
};

type FolderGoneState = {
  originalFolderName: string;
  liveFolders: { id: string; name: string }[];
  selectedFolderId: string;
  customizingNewName: boolean;
  newNameDraft: string;
  busy: boolean;
  error: string | null;
};

type TrashRow =
  | { type: "photo"; id: string; title: string; kind: string; deletedAt: string; days: number; photo: TrashPhotoItem }
  | { type: "folder"; id: string; title: string; kind: string; deletedAt: string; days: number; folder: TrashFolderItem };

export default function TrashV2Page() {
  const isMobile = useIsMobile();
  const showToast = useToast();

  const [photos, setPhotos] = useState<TrashPhotoItem[]>([]);
  const [folders, setFolders] = useState<TrashFolderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [emptyBusy, setEmptyBusy] = useState(false);
  const [lastRecovered, setLastRecovered] = useState<string | null>(null);

  const [folderCollisions, setFolderCollisions] = useState<Record<string, CollisionState>>({});
  const [photoCollisions, setPhotoCollisions] = useState<Record<string, PhotoCollisionState>>({});
  const [folderGoneStates, setFolderGoneStates] = useState<Record<string, FolderGoneState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await trashApi.list({ limit: FETCH_LIMIT, offset: 0 });
      setPhotos(res.photos);
      setFolders(res.folders);
    } catch (err) {
      if (isAuthError(err)) return;
      setError(err instanceof Error ? err.message : "Failed to load trash");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows: TrashRow[] = [
    ...photos.map<TrashRow>((p) => ({ type: "photo", id: p.id, title: p.originalFilename, kind: "Photo", deletedAt: p.deletedAt, days: p.daysRemaining, photo: p })),
    ...folders.map<TrashRow>((f) => ({
      type: "folder",
      id: f.id,
      title: f.name,
      kind: `Folder · ${f.photoCount} photo${f.photoCount === 1 ? "" : "s"}`,
      deletedAt: f.deletedAt,
      days: f.daysRemaining,
      folder: f,
    })),
  ].sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());

  const hasTrash = rows.length > 0;
  const selCount = selectedIds.size;

  function clearRowError(id: string) {
    setRowError((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRecoverPhoto(photo: TrashPhotoItem) {
    setBusyId(photo.id);
    clearRowError(photo.id);
    try {
      await photosApi.restore(photo.id);
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(photo.id);
        return next;
      });
      setPhotoCollisions((prev) => {
        const next = { ...prev };
        delete next[photo.id];
        return next;
      });
      setFolderGoneStates((prev) => {
        const next = { ...prev };
        delete next[photo.id];
        return next;
      });
      setLastRecovered(photo.originalFilename);
    } catch (err) {
      if (isAuthError(err)) return;
      if (isRestoreConflict(err) && photo.folderId) {
        const body = err.body as RestoreConflictBody;
        setPhotoCollisions((prev) => ({
          ...prev,
          [photo.id]: {
            conflictingFolderId: body.conflictingFolderId,
            conflictingFolderName: body.conflictingFolderName,
            customizingNewName: false,
            newNameDraft: "",
            busy: false,
            error: null,
          },
        }));
      } else if (isFolderDeletedConflict(err)) {
        const body = err.body as FolderDeletedBody;
        setFolderGoneStates((prev) => ({
          ...prev,
          [photo.id]: {
            originalFolderName: body.originalFolderName,
            liveFolders: body.liveFolders,
            selectedFolderId: body.liveFolders[0]?.id ?? "",
            customizingNewName: false,
            newNameDraft: "",
            busy: false,
            error: null,
          },
        }));
      } else {
        setRowError((prev) => ({ ...prev, [photo.id]: err instanceof Error ? err.message : "Restore failed" }));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function resolvePhotoCollision(photo: TrashPhotoItem, onConflict: PhotoRestoreOnConflict, newName?: string) {
    const collision = photoCollisions[photo.id];
    if (!collision) return;
    setPhotoCollisions((prev) => ({ ...prev, [photo.id]: { ...collision, busy: true, error: null } }));
    try {
      await photosApi.restore(photo.id, { onConflict, newName });
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setPhotoCollisions((prev) => {
        const next = { ...prev };
        delete next[photo.id];
        return next;
      });
      setLastRecovered(photo.originalFilename);
    } catch (err) {
      if (isAuthError(err)) return;
      setPhotoCollisions((prev) => ({ ...prev, [photo.id]: { ...prev[photo.id], busy: false, error: err instanceof Error ? err.message : "Restore failed" } }));
    }
  }

  async function resolveFolderGone(photo: TrashPhotoItem, onConflict: PhotoRestoreOnConflict, newName?: string) {
    const state = folderGoneStates[photo.id];
    if (!state) return;
    if (onConflict === "existing" && !state.selectedFolderId) return;
    setFolderGoneStates((prev) => ({ ...prev, [photo.id]: { ...state, busy: true, error: null } }));
    try {
      await photosApi.restore(photo.id, { onConflict, newName, targetFolderId: onConflict === "existing" ? state.selectedFolderId : undefined });
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setFolderGoneStates((prev) => {
        const next = { ...prev };
        delete next[photo.id];
        return next;
      });
      setLastRecovered(photo.originalFilename);
    } catch (err) {
      if (isAuthError(err)) return;
      setFolderGoneStates((prev) => ({ ...prev, [photo.id]: { ...prev[photo.id], busy: false, error: err instanceof Error ? err.message : "Restore failed" } }));
    }
  }

  async function handleRecoverFolder(folder: TrashFolderItem) {
    setBusyId(folder.id);
    clearRowError(folder.id);
    try {
      await foldersApi.restore(folder.id);
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(folder.id);
        return next;
      });
      setFolderCollisions((prev) => {
        const next = { ...prev };
        delete next[folder.id];
        return next;
      });
      setLastRecovered(folder.name);
    } catch (err) {
      if (isAuthError(err)) return;
      if (isRestoreConflict(err)) {
        const body = err.body as RestoreConflictBody;
        setFolderCollisions((prev) => ({
          ...prev,
          [folder.id]: {
            conflictingFolderId: body.conflictingFolderId,
            conflictingFolderName: body.conflictingFolderName,
            renaming: false,
            renameDraft: `${folder.name} (2)`,
            busy: false,
            error: null,
          },
        }));
      } else {
        setRowError((prev) => ({ ...prev, [folder.id]: err instanceof Error ? err.message : "Restore failed" }));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function resolveFolderCollision(folder: TrashFolderItem, onConflict: "merge" | "rename", newName?: string) {
    const collision = folderCollisions[folder.id];
    if (!collision) return;
    setFolderCollisions((prev) => ({ ...prev, [folder.id]: { ...collision, busy: true, error: null } }));
    try {
      await foldersApi.restore(folder.id, onConflict, newName);
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      setFolderCollisions((prev) => {
        const next = { ...prev };
        delete next[folder.id];
        return next;
      });
      setLastRecovered(folder.name);
    } catch (err) {
      if (isAuthError(err)) return;
      setFolderCollisions((prev) => ({ ...prev, [folder.id]: { ...prev[folder.id], busy: false, error: err instanceof Error ? err.message : "Restore failed" } }));
    }
  }

  async function handleDestroy(row: TrashRow) {
    setBusyId(row.id);
    clearRowError(row.id);
    try {
      await trashApi.purgeOne(row.type, row.id);
      if (row.type === "photo") setPhotos((prev) => prev.filter((p) => p.id !== row.id));
      else setFolders((prev) => prev.filter((f) => f.id !== row.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    } catch (err) {
      if (isAuthError(err)) return;
      setRowError((prev) => ({ ...prev, [row.id]: err instanceof Error ? err.message : "Permanent delete failed" }));
    } finally {
      setBusyId(null);
    }
  }

  async function recoverSelected() {
    if (bulkBusy || selCount === 0) return;
    setBulkBusy(true);
    const selectedRows = rows.filter((r) => selectedIds.has(r.id));
    const results = await Promise.allSettled(
      selectedRows.map((r) => (r.type === "photo" ? photosApi.restore(r.id) : foldersApi.restore(r.id))),
    );
    const okIds = new Set(selectedRows.filter((_, i) => results[i].status === "fulfilled").map((r) => r.id));
    const failed = selectedRows.length - okIds.size;
    setPhotos((prev) => prev.filter((p) => !okIds.has(p.id)));
    setFolders((prev) => prev.filter((f) => !okIds.has(f.id)));
    setSelectedIds(new Set());
    if (okIds.size > 0) setLastRecovered(selectedRows.find((r) => okIds.has(r.id))?.title ?? null);
    showToast(
      failed === 0
        ? `Recovered ${okIds.size} ${okIds.size === 1 ? "item" : "items"}`
        : `Recovered ${okIds.size} · ${failed} need individual attention — use the row's Recover button`,
    );
    setBulkBusy(false);
  }

  async function destroySelected() {
    if (bulkBusy || selCount === 0) return;
    setBulkBusy(true);
    const selectedRows = rows.filter((r) => selectedIds.has(r.id));
    const results = await Promise.allSettled(selectedRows.map((r) => trashApi.purgeOne(r.type, r.id)));
    const okIds = new Set(selectedRows.filter((_, i) => results[i].status === "fulfilled").map((r) => r.id));
    const failed = selectedRows.length - okIds.size;
    setPhotos((prev) => prev.filter((p) => !okIds.has(p.id)));
    setFolders((prev) => prev.filter((f) => !okIds.has(f.id)));
    setSelectedIds(new Set());
    showToast(failed === 0 ? `Deleted ${okIds.size} ${okIds.size === 1 ? "item" : "items"} forever` : `Deleted ${okIds.size}, ${failed} failed`);
    setBulkBusy(false);
  }

  async function emptyTrash() {
    if (emptyBusy) return;
    setEmptyBusy(true);
    try {
      await trashApi.emptyAll();
      setPhotos([]);
      setFolders([]);
      setSelectedIds(new Set());
    } catch (err) {
      if (isAuthError(err)) return;
      setError(err instanceof Error ? err.message : "Empty trash failed");
    } finally {
      setEmptyBusy(false);
    }
  }

  return (
    <main style={{ padding: "38px 32px 60px", maxWidth: 1000, width: "100%", margin: "0 auto", position: "relative", zIndex: 1 }}>
      <style>{`
        .tgx-row:hover{border-color:var(--ps2-accent)}
        .tgx-empty:hover{background:color-mix(in oklab, #e87f8f 12%, transparent)}
        .tgx-recover-sel:hover{background:color-mix(in oklab, var(--ps2-accent) 12%, transparent)}
        .tgx-recover:hover{background:color-mix(in oklab, var(--ps2-accent) 14%, transparent);border-color:var(--ps2-accent);box-shadow:0 4px 14px color-mix(in oklab, var(--ps2-accent) 30%, transparent)}
        .tgx-destroy:hover{background:color-mix(in oklab, #e87f8f 14%, transparent);border-color:#e87f8f;box-shadow:0 4px 14px color-mix(in oklab, #e87f8f 30%, transparent)}
      `}</style>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", animation: "ps2Up .6s both" }}>
        <h1 style={{ fontFamily: "var(--ps2-font-serif)", fontWeight: 400, fontSize: 36, margin: 0 }}>Trash</h1>
        {selCount > 0 ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="tgx-recover-sel"
              disabled={bulkBusy}
              onClick={recoverSelected}
              style={{ borderRadius: 11, border: "1px solid var(--ps2-accent)", background: "transparent", color: "var(--ps2-accent)", padding: "10px 16px", fontSize: 13, fontFamily: "inherit", cursor: "pointer", transition: "background .2s" }}
            >
              Recover ({selCount})
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={destroySelected}
              style={{ borderRadius: 11, border: "none", background: "#e87f8f", color: "#2a0a10", padding: "10px 16px", fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
            >
              Delete forever
            </button>
          </div>
        ) : (
          hasTrash && (
            <button
              type="button"
              className="tgx-empty"
              disabled={emptyBusy}
              onClick={emptyTrash}
              style={{
                borderRadius: 11,
                border: "1px solid color-mix(in oklab, #e87f8f 50%, var(--ps2-border))",
                background: "transparent",
                color: "#e87f8f",
                padding: "10px 16px",
                fontSize: 13.5,
                fontFamily: "inherit",
                cursor: "pointer",
                transition: "background .25s",
              }}
            >
              Empty trash
            </button>
          )
        )}
      </div>
      <div style={{ fontSize: 14, color: "var(--ps2-muted)", margin: "8px 0 28px", animation: "ps2Up .6s both .05s" }}>
        Items are kept for 30 days, then removed forever.
      </div>

      {error && <div style={{ fontSize: 13.5, color: "#e87f8f", marginBottom: 14 }}>{error}</div>}
      {loading && <SkeletonRows count={6} />}

      {!loading && !error && hasTrash && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((row) => {
            const checked = selectedIds.has(row.id);
            const collision = row.type === "folder" ? folderCollisions[row.id] : undefined;
            const photoCollision = row.type === "photo" ? photoCollisions[row.id] : undefined;
            const gone = row.type === "photo" ? folderGoneStates[row.id] : undefined;
            return (
              <div key={`${row.type}-${row.id}`}>
                <div
                  className="tgx-row"
                  style={{
                    display: "flex",
                    flexDirection: isMobile ? "column" : "row",
                    gap: 13,
                    padding: "13px 16px",
                    borderRadius: 15,
                    background: "var(--ps2-panel)",
                    border: "1px solid var(--ps2-border)",
                    animation: "ps2Up .5s both",
                    transition: "border-color .25s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 13, minWidth: 0, flex: isMobile ? undefined : 1 }}>
                    <div
                      onClick={() => toggleSelected(row.id)}
                      style={{
                        width: 21,
                        height: 21,
                        flex: "none",
                        borderRadius: 6,
                        background: checked ? "var(--ps2-accent)" : "transparent",
                        border: `1.5px solid ${checked ? "var(--ps2-accent)" : "var(--ps2-border)"}`,
                        cursor: "pointer",
                        display: "grid",
                        placeItems: "center",
                        transition: "background .2s, border-color .2s",
                      }}
                    >
                      {checked && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#141118" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </div>
                    {/* The trash list API exposes no thumbnail URL - a desaturated
                        tile stands in for the design's 52px preview image. */}
                    <div style={{ width: 52, height: 52, flex: "none", borderRadius: 11, background: "var(--ps2-tile)", display: "grid", placeItems: "center", color: "var(--ps2-muted)", filter: "saturate(.4)" }}>
                      {row.type === "folder" ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <path d="m21 15-5-5L5 21" />
                        </svg>
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{row.title}</div>
                      <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 2 }}>
                        {row.kind} · deleted {deletedAgo(row.deletedAt)}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", width: isMobile ? "100%" : "auto", justifyContent: isMobile ? "space-between" : "flex-start" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: row.days <= URGENT_DAYS ? "#e87f8f" : "var(--ps2-muted)", flex: "none" }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                      {row.days} days left
                    </div>
                    <button
                      type="button"
                      className="tgx-recover"
                      disabled={busyId === row.id}
                      onClick={() => (row.type === "photo" ? handleRecoverPhoto(row.photo) : handleRecoverFolder(row.folder))}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        borderRadius: 10,
                        border: "1px solid color-mix(in oklab, var(--ps2-accent) 40%, var(--ps2-border))",
                        background: "transparent",
                        color: "var(--ps2-accent)",
                        padding: "9px 14px",
                        fontSize: 12.5,
                        fontWeight: 600,
                        fontFamily: "inherit",
                        cursor: "pointer",
                        transition: "background .25s, border-color .25s, box-shadow .25s",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 1 0 3-6.7" />
                        <path d="M3 4v5h5" />
                      </svg>
                      Recover
                    </button>
                    <button
                      type="button"
                      className="tgx-destroy"
                      disabled={busyId === row.id}
                      onClick={() => handleDestroy(row)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        borderRadius: 10,
                        border: "1px solid color-mix(in oklab, #e87f8f 35%, var(--ps2-border))",
                        background: "transparent",
                        color: "#e87f8f",
                        padding: "9px 14px",
                        fontSize: 12.5,
                        fontWeight: 600,
                        fontFamily: "inherit",
                        cursor: "pointer",
                        transition: "background .25s, border-color .25s, box-shadow .25s",
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      </svg>
                      Delete forever
                    </button>
                  </div>
                </div>
                {rowError[row.id] && <div style={{ fontSize: 12, color: "#e87f8f", margin: "6px 2px 0" }}>{rowError[row.id]}</div>}
                {photoCollision && row.type === "photo" && (
                  <PhotoCollisionPanel
                    collision={photoCollision}
                    onUseExisting={() => resolvePhotoCollision(row.photo, "existing")}
                    onCreateNew={(name) => resolvePhotoCollision(row.photo, "new", name || undefined)}
                    onDraftChange={(draft) => setPhotoCollisions((prev) => ({ ...prev, [row.id]: { ...prev[row.id], newNameDraft: draft } }))}
                    onStartCustomizing={() => setPhotoCollisions((prev) => ({ ...prev, [row.id]: { ...prev[row.id], customizingNewName: true } }))}
                  />
                )}
                {gone && row.type === "photo" && (
                  <FolderGonePanel
                    state={gone}
                    onUseExisting={() => resolveFolderGone(row.photo, "existing")}
                    onCreateNew={(name) => resolveFolderGone(row.photo, "new", name || undefined)}
                    onSelectFolder={(id) => setFolderGoneStates((prev) => ({ ...prev, [row.id]: { ...prev[row.id], selectedFolderId: id } }))}
                    onDraftChange={(draft) => setFolderGoneStates((prev) => ({ ...prev, [row.id]: { ...prev[row.id], newNameDraft: draft } }))}
                    onStartCustomizing={() => setFolderGoneStates((prev) => ({ ...prev, [row.id]: { ...prev[row.id], customizingNewName: true } }))}
                  />
                )}
                {collision && row.type === "folder" && (
                  <CollisionPanel
                    collision={collision}
                    onMerge={() => resolveFolderCollision(row.folder, "merge")}
                    onRename={(name) => resolveFolderCollision(row.folder, "rename", name)}
                    onDraftChange={(draft) => setFolderCollisions((prev) => ({ ...prev, [row.id]: { ...prev[row.id], renameDraft: draft } }))}
                    onStartRename={() => setFolderCollisions((prev) => ({ ...prev, [row.id]: { ...prev[row.id], renaming: true } }))}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && !error && !hasTrash && (
        <div style={{ borderRadius: 20, border: "1.5px dashed var(--ps2-border)", padding: "60px 30px", textAlign: "center", color: "var(--ps2-muted)", animation: "ps2In .5s both" }}>
          <div style={{ fontFamily: "var(--ps2-font-serif)", fontStyle: "italic", fontSize: 24, color: "var(--ps2-text)", marginBottom: 8 }}>Nothing in the trash.</div>
          <div style={{ fontSize: 13.5 }}>
            {lastRecovered ? `“${lastRecovered}” was recovered to its folder.` : "Deleted photos and folders land here for 30 days."}
          </div>
        </div>
      )}
    </main>
  );
}

function PhotoCollisionPanel({
  collision,
  onUseExisting,
  onCreateNew,
  onDraftChange,
  onStartCustomizing,
}: {
  collision: PhotoCollisionState;
  onUseExisting: () => void;
  onCreateNew: (name: string) => void;
  onDraftChange: (draft: string) => void;
  onStartCustomizing: () => void;
}) {
  return (
    <div className="ps2-collision">
      <p className="ps2-collision-title">A folder named &quot;{collision.conflictingFolderName}&quot; already exists</p>
      <p className="ps2-collision-sub">This photo&apos;s original folder is still in the trash and won&apos;t be restored. Choose where this photo should go instead:</p>
      {!collision.customizingNewName ? (
        <div className="ps2-collision-actions">
          <button type="button" className="ps2-collision-btn-primary" disabled={collision.busy} onClick={onUseExisting}>
            Put it in the existing &quot;{collision.conflictingFolderName}&quot; folder
          </button>
          <button type="button" className="ps2-collision-btn-secondary" disabled={collision.busy} onClick={() => onCreateNew("")}>
            Create a new folder for it
          </button>
          <button type="button" className="ps2-collision-btn-link" disabled={collision.busy} onClick={onStartCustomizing}>
            Name the new folder myself…
          </button>
        </div>
      ) : (
        <div className="ps2-collision-row">
          <input type="text" placeholder={`${collision.conflictingFolderName} (recovered)`} value={collision.newNameDraft} disabled={collision.busy} onChange={(e) => onDraftChange(e.target.value)} />
          <button type="button" className="ps2-collision-btn-secondary" disabled={collision.busy} onClick={() => onCreateNew(collision.newNameDraft.trim())}>
            {collision.busy ? "…" : "Create & restore"}
          </button>
        </div>
      )}
      {collision.error && <p className="ps2-modal-error" style={{ marginBottom: 0 }}>{collision.error}</p>}
    </div>
  );
}

function FolderGonePanel({
  state,
  onUseExisting,
  onCreateNew,
  onSelectFolder,
  onDraftChange,
  onStartCustomizing,
}: {
  state: FolderGoneState;
  onUseExisting: () => void;
  onCreateNew: (name: string) => void;
  onSelectFolder: (id: string) => void;
  onDraftChange: (draft: string) => void;
  onStartCustomizing: () => void;
}) {
  return (
    <div className="ps2-collision">
      <p className="ps2-collision-title">The folder &quot;{state.originalFolderName}&quot; this photo was in has been deleted</p>
      <p className="ps2-collision-sub">Choose an existing folder to recover it into, or create a new one:</p>
      {!state.customizingNewName ? (
        <div className="ps2-collision-actions">
          {state.liveFolders.length > 0 && (
            <div className="ps2-collision-row">
              <select value={state.selectedFolderId} disabled={state.busy} onChange={(e) => onSelectFolder(e.target.value)}>
                {state.liveFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <button type="button" className="ps2-collision-btn-primary" disabled={state.busy || !state.selectedFolderId} onClick={onUseExisting}>
                Put it here
              </button>
            </div>
          )}
          <button type="button" className="ps2-collision-btn-secondary" disabled={state.busy} onClick={() => onCreateNew("")}>
            Create a new &quot;{state.originalFolderName}&quot; folder
          </button>
          <button type="button" className="ps2-collision-btn-link" disabled={state.busy} onClick={onStartCustomizing}>
            Name the new folder myself…
          </button>
        </div>
      ) : (
        <div className="ps2-collision-row">
          <input type="text" placeholder={state.originalFolderName} value={state.newNameDraft} disabled={state.busy} onChange={(e) => onDraftChange(e.target.value)} />
          <button type="button" className="ps2-collision-btn-secondary" disabled={state.busy} onClick={() => onCreateNew(state.newNameDraft.trim())}>
            {state.busy ? "…" : "Create & restore"}
          </button>
        </div>
      )}
      {state.error && <p className="ps2-modal-error" style={{ marginBottom: 0 }}>{state.error}</p>}
    </div>
  );
}

function CollisionPanel({
  collision,
  onMerge,
  onRename,
  onDraftChange,
  onStartRename,
}: {
  collision: CollisionState;
  onMerge: () => void;
  onRename: (name: string) => void;
  onDraftChange: (draft: string) => void;
  onStartRename: () => void;
}) {
  return (
    <div className="ps2-collision">
      <p className="ps2-collision-title">Can&apos;t recover — a folder named &quot;{collision.conflictingFolderName}&quot; already exists</p>
      <p className="ps2-collision-sub">You created a new &quot;{collision.conflictingFolderName}&quot; folder after this one was trashed. Choose how to bring it back:</p>
      {!collision.renaming ? (
        <div className="ps2-collision-actions">
          <button type="button" className="ps2-collision-btn-primary" disabled={collision.busy} onClick={onMerge}>
            Merge into existing &quot;{collision.conflictingFolderName}&quot;
          </button>
          <button type="button" className="ps2-collision-btn-secondary" disabled={collision.busy} onClick={onStartRename}>
            Rename &amp; restore as &quot;{collision.renameDraft}&quot;
          </button>
        </div>
      ) : (
        <div className="ps2-collision-row">
          <input type="text" value={collision.renameDraft} disabled={collision.busy} onChange={(e) => onDraftChange(e.target.value)} />
          <button type="button" className="ps2-collision-btn-secondary" disabled={collision.busy || !collision.renameDraft.trim()} onClick={() => onRename(collision.renameDraft.trim())}>
            {collision.busy ? "…" : "Restore with this name"}
          </button>
        </div>
      )}
      {collision.error && <p className="ps2-modal-error" style={{ marginBottom: 0 }}>{collision.error}</p>}
    </div>
  );
}
