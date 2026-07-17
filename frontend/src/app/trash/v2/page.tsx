"use client";

// Trash v2 — redesign handoff (README.md "Trash", PhotoSphere.dc.html Trash
// screen): desaturated rows with kind + deleted-date, an "N days left"
// countdown (red under 2 days), Recover / Delete forever per row, a header
// "Empty trash" with a strong confirm, and the italic-serif empty state.
// Photos and Folders are split into tabs (the API returns both sections).
// All restore machinery is carried over from the classic /trash page: the
// folder-restore merge/rename 409, the photo-restore existing/new 409, and
// the "original folder purged" folder-gone 409 — each resolved inline with
// the same api calls and vocabulary.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
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
import Ps2Shell from "@/components/ps2/Shell";

const PAGE_LIMIT = 20;
const URGENT_DAYS = 2;

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

type Tab = "photos" | "folders";

type CollisionState = {
  conflictingFolderName: string;
  renaming: boolean;
  renameDraft: string;
  busy: boolean;
  error: string | null;
};
type PhotoCollisionState = {
  conflictingFolderName: string;
  busy: boolean;
  error: string | null;
};
type FolderGoneState = {
  originalFolderName: string;
  liveFolders: { id: string; name: string }[];
  selectedFolderId: string;
  busy: boolean;
  error: string | null;
};

function deletedAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}

export default function TrashV2Page() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  const [tab, setTab] = useState<Tab>("photos");
  const [photos, setPhotos] = useState<TrashPhotoItem[]>([]);
  const [photoTotal, setPhotoTotal] = useState(0);
  const [folders, setFolders] = useState<TrashFolderItem[]>([]);
  const [folderTotal, setFolderTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const [permDeleteTarget, setPermDeleteTarget] = useState<{ type: "photo" | "folder"; id: string; label: string } | null>(null);
  const [permDeleteBusy, setPermDeleteBusy] = useState(false);

  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);
  const [emptyBusy, setEmptyBusy] = useState(false);
  const [emptyError, setEmptyError] = useState<string | null>(null);

  const [folderCollisions, setFolderCollisions] = useState<Record<string, CollisionState>>({});
  const [photoCollisions, setPhotoCollisions] = useState<Record<string, PhotoCollisionState>>({});
  const [folderGoneStates, setFolderGoneStates] = useState<Record<string, FolderGoneState>>({});

  const [restoreToast, setRestoreToast] = useState<string | null>(null);
  useEffect(() => {
    if (!restoreToast) return;
    const t = setTimeout(() => setRestoreToast(null), 4000);
    return () => clearTimeout(t);
  }, [restoreToast]);

  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await trashApi.list({ limit: PAGE_LIMIT, offset: 0 });
      setPhotos(res.photos);
      setPhotoTotal(res.photoTotal);
      setFolders(res.folders);
      setFolderTotal(res.folderTotal);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load trash");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (checking) return;
    load();
  }, [checking, load]);

  function clearRowError(id: string) {
    setRowError((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function handleRecoverPhoto(photo: TrashPhotoItem) {
    setBusyId(photo.id);
    clearRowError(photo.id);
    try {
      const result = await photosApi.restore(photo.id);
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setPhotoTotal((prev) => Math.max(0, prev - 1));
      if (result.folder) setRestoreToast(`Restored “${photo.originalFilename}” to “${result.folder.name}”`);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (isRestoreConflict(err) && photo.folderId) {
        const body = err.body as RestoreConflictBody;
        setPhotoCollisions((prev) => ({ ...prev, [photo.id]: { conflictingFolderName: body.conflictingFolderName, busy: false, error: null } }));
      } else if (isFolderDeletedConflict(err)) {
        const body = err.body as FolderDeletedBody;
        setFolderGoneStates((prev) => ({
          ...prev,
          [photo.id]: {
            originalFolderName: body.originalFolderName,
            liveFolders: body.liveFolders,
            selectedFolderId: body.liveFolders[0]?.id ?? "",
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

  async function resolvePhotoCollision(photo: TrashPhotoItem, onConflict: PhotoRestoreOnConflict) {
    setPhotoCollisions((prev) => ({ ...prev, [photo.id]: { ...prev[photo.id], busy: true, error: null } }));
    try {
      const result = await photosApi.restore(photo.id, { onConflict });
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setPhotoTotal((prev) => Math.max(0, prev - 1));
      setPhotoCollisions((prev) => {
        const next = { ...prev };
        delete next[photo.id];
        return next;
      });
      if (result.folder) setRestoreToast(`Restored “${photo.originalFilename}” to “${result.folder.name}”`);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setPhotoCollisions((prev) => ({ ...prev, [photo.id]: { ...prev[photo.id], busy: false, error: err instanceof Error ? err.message : "Restore failed" } }));
    }
  }

  async function resolveFolderGone(photo: TrashPhotoItem, onConflict: PhotoRestoreOnConflict) {
    const state = folderGoneStates[photo.id];
    if (!state) return;
    if (onConflict === "existing" && !state.selectedFolderId) return;
    setFolderGoneStates((prev) => ({ ...prev, [photo.id]: { ...state, busy: true, error: null } }));
    try {
      const result = await photosApi.restore(photo.id, {
        onConflict,
        targetFolderId: onConflict === "existing" ? state.selectedFolderId : undefined,
      });
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setPhotoTotal((prev) => Math.max(0, prev - 1));
      setFolderGoneStates((prev) => {
        const next = { ...prev };
        delete next[photo.id];
        return next;
      });
      if (result.folder) setRestoreToast(`Restored “${photo.originalFilename}” to “${result.folder.name}”`);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setFolderGoneStates((prev) => ({ ...prev, [photo.id]: { ...prev[photo.id], busy: false, error: err instanceof Error ? err.message : "Restore failed" } }));
    }
  }

  async function handleRecoverFolder(folder: TrashFolderItem) {
    setBusyId(folder.id);
    clearRowError(folder.id);
    try {
      await foldersApi.restore(folder.id);
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      setFolderTotal((prev) => Math.max(0, prev - 1));
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (isRestoreConflict(err)) {
        const body = err.body as RestoreConflictBody;
        setFolderCollisions((prev) => ({
          ...prev,
          [folder.id]: { conflictingFolderName: body.conflictingFolderName, renaming: false, renameDraft: `${folder.name} (2)`, busy: false, error: null },
        }));
      } else {
        setRowError((prev) => ({ ...prev, [folder.id]: err instanceof Error ? err.message : "Restore failed" }));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function resolveFolderCollision(folder: TrashFolderItem, onConflict: "merge" | "rename", newName?: string) {
    setFolderCollisions((prev) => ({ ...prev, [folder.id]: { ...prev[folder.id], busy: true, error: null } }));
    try {
      await foldersApi.restore(folder.id, onConflict, newName);
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      setFolderTotal((prev) => Math.max(0, prev - 1));
      setFolderCollisions((prev) => {
        const next = { ...prev };
        delete next[folder.id];
        return next;
      });
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setFolderCollisions((prev) => ({ ...prev, [folder.id]: { ...prev[folder.id], busy: false, error: err instanceof Error ? err.message : "Restore failed" } }));
    }
  }

  async function confirmPermDelete() {
    if (!permDeleteTarget) return;
    setPermDeleteBusy(true);
    try {
      await trashApi.purgeOne(permDeleteTarget.type, permDeleteTarget.id);
      if (permDeleteTarget.type === "photo") {
        setPhotos((prev) => prev.filter((p) => p.id !== permDeleteTarget.id));
        setPhotoTotal((prev) => Math.max(0, prev - 1));
      } else {
        setFolders((prev) => prev.filter((f) => f.id !== permDeleteTarget.id));
        setFolderTotal((prev) => Math.max(0, prev - 1));
      }
      setPermDeleteTarget(null);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setRowError((prev) => ({ ...prev, [permDeleteTarget.id]: err instanceof Error ? err.message : "Permanent delete failed" }));
      setPermDeleteTarget(null);
    } finally {
      setPermDeleteBusy(false);
    }
  }

  async function confirmEmptyTrash() {
    setEmptyBusy(true);
    setEmptyError(null);
    try {
      await trashApi.emptyAll();
      setPhotos([]);
      setPhotoTotal(0);
      setFolders([]);
      setFolderTotal(0);
      setEmptyConfirmOpen(false);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setEmptyError(err instanceof Error ? err.message : "Empty trash failed");
    } finally {
      setEmptyBusy(false);
    }
  }

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  const isEmpty = photoTotal === 0 && folderTotal === 0;
  const activeItems = tab === "photos" ? photos : folders;

  return (
    <Ps2Shell active="trash" userName={user.name} classicHref="/trash">
      <main className="ps2-trash" data-testid="trash-v2">
        <div className="ps2-organize-head">
          <h1 className="ps2-h1-page">Trash</h1>
          {!isEmpty && (
            <button type="button" className="ps2-btn-danger" onClick={() => setEmptyConfirmOpen(true)} data-testid="trash-empty-all">
              Empty trash
            </button>
          )}
        </div>
        <div className="ps2-share-sub">Items are kept for 7 days, then removed forever.</div>

        {restoreToast && <div className="ps2-guest-attention" data-testid="trash-restore-toast">{restoreToast}</div>}

        {!isEmpty && (
          <div className="ps2-chip-row">
            <button type="button" className={`ps2-chip${tab === "photos" ? " ps2-chip-active" : ""}`} onClick={() => setTab("photos")} data-testid="trash-tab-photos">
              Photos<span className="ps2-chip-count">{photoTotal}</span>
            </button>
            <button type="button" className={`ps2-chip${tab === "folders" ? " ps2-chip-active" : ""}`} onClick={() => setTab("folders")} data-testid="trash-tab-folders">
              Folders<span className="ps2-chip-count">{folderTotal}</span>
            </button>
          </div>
        )}

        {error && <p className="ps2-error">{error}</p>}
        {loading && <div className="ps2-loading"><span className="ps2-spinner" aria-hidden="true" />Loading trash…</div>}

        {!loading && !error && isEmpty && (
          <div className="ps2-empty" data-testid="trash-empty">
            <div className="ps2-empty-title">Nothing in the trash.</div>
            <div>Deleted photos and folders land here for 7 days.</div>
          </div>
        )}

        {!loading && !error && !isEmpty && activeItems.length === 0 && (
          <div className="ps2-empty">
            <div className="ps2-empty-title">No {tab} in the trash.</div>
          </div>
        )}

        {!loading && !error && tab === "photos" &&
          photos.map((photo) => {
            const urgent = photo.daysRemaining <= URGENT_DAYS;
            const collision = photoCollisions[photo.id];
            const gone = folderGoneStates[photo.id];
            return (
              <div key={photo.id} data-testid={`trash-photo-${photo.id}`}>
                <div className="ps2-trash-row">
                  <div className="ps2-trash-thumb" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
                  </div>
                  <div className="ps2-trash-main">
                    <div className="ps2-trash-title">{photo.originalFilename}</div>
                    <div className="ps2-trash-kind">Photo · deleted {deletedAgo(photo.deletedAt)}</div>
                  </div>
                  <div className={`ps2-trash-countdown${urgent ? " ps2-trash-urgent" : ""}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                    {photo.daysRemaining} day{photo.daysRemaining === 1 ? "" : "s"} left
                  </div>
                  <button type="button" className="ps2-btn-ghost" disabled={busyId === photo.id} onClick={() => handleRecoverPhoto(photo)} data-testid={`trash-recover-photo-${photo.id}`}>Recover</button>
                  <button type="button" className="ps2-link-btn" style={{ color: "#e0607a" }} onClick={() => setPermDeleteTarget({ type: "photo", id: photo.id, label: photo.originalFilename })} data-testid={`trash-delete-photo-${photo.id}`}>Delete forever</button>
                </div>
                {rowError[photo.id] && <p className="ps2-inline-error">{rowError[photo.id]}</p>}

                {collision && (
                  <div className="ps2-guest-card" data-testid={`photo-collision-${photo.id}`}>
                    <p className="ps2-modal-sub" style={{ margin: 0 }}>
                      A live folder named “{collision.conflictingFolderName}” already exists.
                    </p>
                    <div className="ps2-modal-actions">
                      <button type="button" className="ps2-btn-accent" disabled={collision.busy} onClick={() => resolvePhotoCollision(photo, "existing")}>Put it in “{collision.conflictingFolderName}”</button>
                      <button type="button" className="ps2-btn-ghost" disabled={collision.busy} onClick={() => resolvePhotoCollision(photo, "new")}>Create a new folder</button>
                    </div>
                    {collision.error && <p className="ps2-inline-error">{collision.error}</p>}
                  </div>
                )}

                {gone && (
                  <div className="ps2-guest-card" data-testid={`folder-gone-${photo.id}`}>
                    <p className="ps2-modal-sub" style={{ margin: 0 }}>
                      The original folder “{gone.originalFolderName}” is gone for good. Pick where to restore this photo:
                    </p>
                    <div className="ps2-modal-actions" style={{ flexWrap: "wrap" }}>
                      <select
                        className="ps2-select"
                        value={gone.selectedFolderId}
                        disabled={gone.busy || gone.liveFolders.length === 0}
                        onChange={(e) => setFolderGoneStates((prev) => ({ ...prev, [photo.id]: { ...prev[photo.id], selectedFolderId: e.target.value } }))}
                      >
                        {gone.liveFolders.length === 0 && <option value="">No live folders</option>}
                        {gone.liveFolders.map((f) => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                      </select>
                      <button type="button" className="ps2-btn-accent" disabled={gone.busy || !gone.selectedFolderId} onClick={() => resolveFolderGone(photo, "existing")}>Restore here</button>
                      <button type="button" className="ps2-btn-ghost" disabled={gone.busy} onClick={() => resolveFolderGone(photo, "new")}>New folder instead</button>
                    </div>
                    {gone.error && <p className="ps2-inline-error">{gone.error}</p>}
                  </div>
                )}
              </div>
            );
          })}

        {!loading && !error && tab === "folders" &&
          folders.map((folder) => {
            const urgent = folder.daysRemaining <= URGENT_DAYS;
            const collision = folderCollisions[folder.id];
            return (
              <div key={folder.id} data-testid={`trash-folder-${folder.id}`}>
                <div className="ps2-trash-row">
                  <div className="ps2-trash-thumb" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /></svg>
                  </div>
                  <div className="ps2-trash-main">
                    <div className="ps2-trash-title">{folder.name}</div>
                    <div className="ps2-trash-kind">Folder · {folder.photoCount} photo{folder.photoCount === 1 ? "" : "s"} · deleted {deletedAgo(folder.deletedAt)}</div>
                  </div>
                  <div className={`ps2-trash-countdown${urgent ? " ps2-trash-urgent" : ""}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                    {folder.daysRemaining} day{folder.daysRemaining === 1 ? "" : "s"} left
                  </div>
                  <button type="button" className="ps2-btn-ghost" disabled={busyId === folder.id} onClick={() => handleRecoverFolder(folder)} data-testid={`trash-recover-folder-${folder.id}`}>Recover</button>
                  <button type="button" className="ps2-link-btn" style={{ color: "#e0607a" }} onClick={() => setPermDeleteTarget({ type: "folder", id: folder.id, label: folder.name })} data-testid={`trash-delete-folder-${folder.id}`}>Delete forever</button>
                </div>
                {rowError[folder.id] && <p className="ps2-inline-error">{rowError[folder.id]}</p>}

                {collision && (
                  <div className="ps2-guest-card" data-testid={`folder-collision-${folder.id}`}>
                    <p className="ps2-modal-sub" style={{ margin: 0 }}>
                      A live folder named “{collision.conflictingFolderName}” already exists.
                    </p>
                    {collision.renaming ? (
                      <div className="ps2-modal-actions">
                        <input className="ps2-input" value={collision.renameDraft} disabled={collision.busy} onChange={(e) => setFolderCollisions((prev) => ({ ...prev, [folder.id]: { ...prev[folder.id], renameDraft: e.target.value } }))} />
                        <button type="button" className="ps2-btn-accent" disabled={collision.busy || !collision.renameDraft.trim()} onClick={() => resolveFolderCollision(folder, "rename", collision.renameDraft.trim())}>Restore as this</button>
                      </div>
                    ) : (
                      <div className="ps2-modal-actions">
                        <button type="button" className="ps2-btn-accent" disabled={collision.busy} onClick={() => resolveFolderCollision(folder, "merge")}>Merge into existing</button>
                        <button type="button" className="ps2-btn-ghost" disabled={collision.busy} onClick={() => setFolderCollisions((prev) => ({ ...prev, [folder.id]: { ...prev[folder.id], renaming: true } }))}>Rename &amp; restore</button>
                      </div>
                    )}
                    {collision.error && <p className="ps2-inline-error">{collision.error}</p>}
                  </div>
                )}
              </div>
            );
          })}
      </main>

      {/* Permanent-delete confirm */}
      {permDeleteTarget && (
        <div className="ps2-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !permDeleteBusy) setPermDeleteTarget(null); }}>
          <div className="ps2-modal">
            <h3>Delete “{permDeleteTarget.label}” forever?</h3>
            <p className="ps2-modal-sub">This can&apos;t be undone. The {permDeleteTarget.type} will be permanently removed right now.</p>
            <div className="ps2-modal-actions">
              <button type="button" className="ps2-btn-danger" disabled={permDeleteBusy} onClick={confirmPermDelete} data-testid="trash-perm-delete-confirm">
                {permDeleteBusy ? "Deleting…" : "Delete forever"}
              </button>
              <button type="button" className="ps2-btn-ghost" disabled={permDeleteBusy} onClick={() => setPermDeleteTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Empty-trash confirm */}
      {emptyConfirmOpen && (
        <div className="ps2-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !emptyBusy) setEmptyConfirmOpen(false); }}>
          <div className="ps2-modal">
            <h3>Empty the entire trash?</h3>
            <p className="ps2-modal-sub">
              All {photoTotal} photo{photoTotal === 1 ? "" : "s"} and {folderTotal} folder{folderTotal === 1 ? "" : "s"} in
              the trash will be permanently deleted right now. This can&apos;t be undone.
            </p>
            {emptyError && <p className="ps2-inline-error">{emptyError}</p>}
            <div className="ps2-modal-actions">
              <button type="button" className="ps2-btn-danger" disabled={emptyBusy} onClick={confirmEmptyTrash} data-testid="trash-empty-confirm">
                {emptyBusy ? "Emptying…" : "Empty trash"}
              </button>
              <button type="button" className="ps2-btn-ghost" disabled={emptyBusy} onClick={() => setEmptyConfirmOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Ps2Shell>
  );
}
