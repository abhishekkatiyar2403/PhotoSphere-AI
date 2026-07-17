"use client";

// Organize v2 — redesign handoff (README.md "Organize", PhotoSphere.dc.html
// Organize screen): a folder-card grid (3-col mosaic cards + name/count) with
// a "New folder" action and a dashed "unfiled" tray, plus a per-card kebab for
// Rename / Merge / Delete / Download all. Wired to the same real endpoints the
// classic /organize page uses (collectionsApi, foldersApi CRUD +
// merge/remove, unfiledPhotosApi count, downloadAllApi).
//
// Scope note: the classic /organize is a heavy photo workbench (per-photo
// Move / Reclassify, multi-select marquee, bulk move/delete). The design's
// Organize screen is folder-centric and doesn't depict that workbench, so
// this v2 page recreates the folder-management surface faithfully and links
// each card into Browse v2 for the actual photo grid. The photo-level
// workbench stays available via the top-bar "Classic UI" link. Folder create
// / rename / merge / delete keep the classic page's exact 409 handling
// (name-collision, and the F1 shared-with-guest block that routes to Guests).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  collectionsApi,
  downloadAllApi,
  Folder,
  foldersApi,
  unfiledPhotosApi,
} from "@/lib/api";
import Ps2Shell from "@/components/ps2/Shell";

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export default function OrganizeV2Page() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [unfiledCount, setUnfiledCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New folder
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Kebab + rename
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  // Merge / delete dialogs (same shape/handling as classic)
  const [mergeFolder, setMergeFolder] = useState<Folder | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeBlocked, setMergeBlocked] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);

  const [deleteFolder, setDeleteFolder] = useState<Folder | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const collectionIdRef = useRef<string | null>(null);
  useEffect(() => {
    collectionIdRef.current = collectionId;
  }, [collectionId]);

  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  const loadFolders = useCallback(async (cId: string | null) => {
    try {
      const [foldersRes, unfiledRes] = await Promise.all([
        cId ? foldersApi.list(cId) : Promise.resolve({ folders: [] as Folder[] }),
        unfiledPhotosApi.list({ limit: 1, offset: 0 }),
      ]);
      setFolders(foldersRes.folders);
      setUnfiledCount(unfiledRes.total);
      return foldersRes.folders;
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return [];
      }
      setError(err instanceof Error ? err.message : "Failed to load folders");
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (checking) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await collectionsApi.list();
        if (cancelled) return;
        const defaultCollection = res.collections.find((c) => c.isDefault) ?? res.collections[0] ?? null;
        setCollectionId(defaultCollection?.id ?? null);
        await loadFolders(defaultCollection?.id ?? null);
      } catch (err) {
        if (cancelled) return;
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load collections");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checking, loadFolders, router]);

  async function handleCreateFolder() {
    if (!collectionId) {
      setNewFolderError("No collection yet — upload a photo first.");
      return;
    }
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
      setNewFolderOpen(false);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 409) setNewFolderError("A folder with this name already exists");
      else if (err instanceof ApiError && err.status === 400) setNewFolderError(err.message || "Invalid folder name");
      else setNewFolderError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setCreatingFolder(false);
    }
  }

  function startRename(folder: Folder) {
    setOpenMenuId(null);
    setRenamingId(folder.id);
    setRenameDraft(folder.name);
    setRenameError(null);
  }

  async function commitRename(folder: Folder) {
    const name = renameDraft.trim();
    if (!name) {
      setRenameError("Folder name is required");
      return;
    }
    if (name === folder.name) {
      setRenamingId(null);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      const updated = await foldersApi.rename(folder.id, name);
      setFolders((prev) =>
        prev.map((f) => (f.id === folder.id ? { ...f, name: updated.name } : f)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      setRenamingId(null);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 409) setRenameError("A folder with that name already exists");
      else if (err instanceof ApiError && err.status === 400) setRenameError(err.message || "Invalid folder name");
      else setRenameError(err instanceof Error ? err.message : "Rename failed");
      setRenameBusy(false);
    }
  }

  function openMerge(folder: Folder) {
    setOpenMenuId(null);
    setMergeFolder(folder);
    setMergeTargetId("");
    setMergeError(null);
    setMergeBlocked(false);
    setMergeBusy(false);
  }

  async function confirmMerge() {
    if (!mergeFolder || !mergeTargetId) return;
    const source = mergeFolder;
    setMergeBusy(true);
    setMergeError(null);
    setMergeBlocked(false);
    try {
      await foldersApi.merge(source.id, mergeTargetId);
      setMergeFolder(null);
      await loadFolders(collectionIdRef.current);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 409) setMergeBlocked(true);
      else if (err instanceof ApiError && err.status === 400) setMergeError(err.message || "Cannot merge these folders");
      else setMergeError(err instanceof Error ? err.message : "Merge failed");
      setMergeBusy(false);
    }
  }

  function openDelete(folder: Folder) {
    setOpenMenuId(null);
    setDeleteFolder(folder);
    setDeleteError(null);
    setDeleteBlocked(false);
    setDeleteBusy(false);
  }

  async function confirmDelete() {
    if (!deleteFolder) return;
    const folder = deleteFolder;
    setDeleteBusy(true);
    setDeleteError(null);
    setDeleteBlocked(false);
    try {
      await foldersApi.remove(folder.id);
      setDeleteFolder(null);
      await loadFolders(collectionIdRef.current);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.status === 409) setDeleteBlocked(true);
      else setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setDeleteBusy(false);
    }
  }

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  const mergeTargets = mergeFolder ? folders.filter((f) => f.id !== mergeFolder.id) : [];

  return (
    <Ps2Shell active="organize" userName={user.name} classicHref="/organize">
      <main className="ps2-organize" data-testid="organize-v2" onClick={() => setOpenMenuId(null)}>
        <div className="ps2-organize-head">
          <h1 className="ps2-h1-page">Organize</h1>
          <button
            type="button"
            className="ps2-btn-ghost"
            data-testid="organize-new-folder-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setNewFolderOpen((v) => !v);
              setNewFolderError(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New folder
          </button>
        </div>

        {newFolderOpen && (
          <form
            className="ps2-inline-form"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateFolder();
            }}
          >
            <input
              className="ps2-input"
              style={{ flex: 1, maxWidth: 320 }}
              placeholder="New folder name…"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              data-testid="organize-new-folder-input"
              autoFocus
            />
            <button type="submit" className="ps2-btn-accent" disabled={creatingFolder} data-testid="organize-new-folder-submit">
              {creatingFolder ? "Creating…" : "Create"}
            </button>
            {newFolderError && <span className="ps2-inline-error" style={{ alignSelf: "center" }}>{newFolderError}</span>}
          </form>
        )}

        {error && <p className="ps2-error">{error}</p>}
        {loading && (
          <div className="ps2-loading">
            <span className="ps2-spinner" aria-hidden="true" />
            Loading folders…
          </div>
        )}

        {!loading && !error && (
          <div className="ps2-org-grid" data-testid="organize-v2-grid">
            {folders.map((folder) => {
              const isRenaming = renamingId === folder.id;
              return (
                <div key={folder.id} className="ps2-org-card" data-testid={`folder-card-${folder.name}`} onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="ps2-kebab"
                    data-testid={`folder-kebab-${folder.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId((cur) => (cur === folder.id ? null : folder.id));
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
                  </button>
                  {openMenuId === folder.id && (
                    <div className="ps2-kebab-menu" data-testid={`folder-menu-${folder.id}`}>
                      <button type="button" className="ps2-kebab-item" onClick={() => startRename(folder)}>Rename</button>
                      <button type="button" className="ps2-kebab-item" onClick={() => openMerge(folder)}>Merge into…</button>
                      {folder.photoCount > 0 && (
                        <button
                          type="button"
                          className="ps2-kebab-item"
                          onClick={() => {
                            setOpenMenuId(null);
                            window.location.assign(downloadAllApi.ownerFolderUrl(folder.id));
                          }}
                        >
                          Download all
                        </button>
                      )}
                      <button type="button" className="ps2-kebab-item ps2-kebab-danger" onClick={() => openDelete(folder)}>Delete</button>
                    </div>
                  )}

                  <Link href={`/browse/v2?folder=${encodeURIComponent(folder.id)}`} style={{ display: "block", color: "inherit" }}>
                    <div className="ps2-org-card-mosaic" aria-hidden="true">
                      <div className="ps2-org-card-mosaic-main" />
                      <div className="ps2-org-card-mosaic-side">
                        <div className="ps2-org-card-mosaic-cell" />
                        <div className="ps2-org-card-mosaic-cell" />
                      </div>
                    </div>
                  </Link>

                  <div className="ps2-org-card-foot">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      {isRenaming ? (
                        <>
                          <input
                            className="ps2-org-card-name-edit"
                            value={renameDraft}
                            autoFocus
                            disabled={renameBusy}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename(folder);
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            onBlur={() => commitRename(folder)}
                            data-testid={`folder-rename-input-${folder.id}`}
                          />
                          {renameError && <p className="ps2-inline-error">{renameError}</p>}
                        </>
                      ) : (
                        <>
                          <div className="ps2-org-card-name">{folder.name}</div>
                          <div className="ps2-org-card-meta">
                            {folder.photoCount} photo{folder.photoCount === 1 ? "" : "s"}
                            {folder.categoryType === "ai_generated" ? " · AI" : " · Custom"}
                          </div>
                        </>
                      )}
                    </div>
                    {!isRenaming && (
                      <Link href={`/browse/v2?folder=${encodeURIComponent(folder.id)}`} className="ps2-org-open">
                        Open →
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}

            {unfiledCount > 0 && (
              <Link
                href="/browse/v2?folder=__unfiled__"
                className="ps2-org-tray"
                data-testid="organize-unfiled-tray"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="ps2-org-tray-stack" aria-hidden="true">
                  <div className="ps2-org-tray-thumb">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
                  </div>
                  <div className="ps2-org-tray-thumb">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
                  </div>
                </div>
                <div className="ps2-org-tray-title">
                  {unfiledCount} unfiled photo{unfiledCount === 1 ? "" : "s"}
                </div>
                <div>Open to file them into folders →</div>
              </Link>
            )}

            {folders.length === 0 && unfiledCount === 0 && (
              <div className="ps2-empty" style={{ gridColumn: "1 / -1" }}>
                <div className="ps2-empty-title">No folders yet.</div>
                <div>Upload photos and PhotoSphere will sort them, or create a folder above.</div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Merge dialog — same consequence copy + F1 shared block as classic */}
      {mergeFolder && (
        <div className="ps2-modal-backdrop" data-testid="merge-dialog" onClick={(e) => { if (e.target === e.currentTarget && !mergeBusy) setMergeFolder(null); }}>
          <div className="ps2-modal">
            {mergeBlocked ? (
              <>
                <h3>Can&apos;t merge — shared with a guest</h3>
                <p className="ps2-modal-sub">
                  “{mergeFolder.name}” is currently shared with a guest. Revoke the share first, then merge.
                </p>
                <div className="ps2-modal-actions">
                  <Link href="/guests" className="ps2-btn-ghost">Go to Guests →</Link>
                  <button type="button" className="ps2-btn-ghost" onClick={() => setMergeFolder(null)}>Close</button>
                </div>
              </>
            ) : (
              <>
                <h3>Merge “{mergeFolder.name}” into another folder</h3>
                <p className="ps2-modal-sub">
                  All {mergeFolder.photoCount} photos move to the destination; “{mergeFolder.name}” is then removed.
                </p>
                <select
                  className="ps2-select"
                  style={{ width: "100%" }}
                  value={mergeTargetId}
                  disabled={mergeBusy}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                  data-testid="merge-target-select"
                >
                  <option value="" disabled>Choose a destination folder…</option>
                  {mergeTargets.map((f) => (
                    <option key={f.id} value={f.id}>{f.name} — {f.photoCount} photos</option>
                  ))}
                </select>
                {mergeTargets.length === 0 && <p className="ps2-modal-sub" style={{ marginTop: 10 }}>You have no other folder to merge into. Create one first.</p>}
                {mergeError && <p className="ps2-inline-error">{mergeError}</p>}
                <div className="ps2-modal-actions">
                  <button type="button" className="ps2-btn-accent" disabled={mergeBusy || !mergeTargetId} onClick={confirmMerge} data-testid="merge-confirm">
                    {mergeBusy ? "Merging…" : "Merge folders"}
                  </button>
                  <button type="button" className="ps2-btn-ghost" disabled={mergeBusy} onClick={() => setMergeFolder(null)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete dialog — photos move to Trash (recoverable 7 days); F1 block */}
      {deleteFolder && (
        <div className="ps2-modal-backdrop" data-testid="delete-dialog" onClick={(e) => { if (e.target === e.currentTarget && !deleteBusy) setDeleteFolder(null); }}>
          <div className="ps2-modal">
            {deleteBlocked ? (
              <>
                <h3>Can&apos;t delete — shared with a guest</h3>
                <p className="ps2-modal-sub">
                  “{deleteFolder.name}” is currently shared with a guest. Revoke the share first, then delete.
                </p>
                <div className="ps2-modal-actions">
                  <Link href="/guests" className="ps2-btn-ghost">Go to Guests →</Link>
                  <button type="button" className="ps2-btn-ghost" onClick={() => setDeleteFolder(null)}>Close</button>
                </div>
              </>
            ) : (
              <>
                <h3>Delete “{deleteFolder.name}”?</h3>
                <p className="ps2-modal-sub">
                  This folder and its {deleteFolder.photoCount} photo{deleteFolder.photoCount === 1 ? "" : "s"} move to
                  Trash — recoverable for 7 days, then permanently deleted.
                </p>
                {deleteError && <p className="ps2-inline-error">{deleteError}</p>}
                <div className="ps2-modal-actions">
                  <button type="button" className="ps2-btn-danger" disabled={deleteBusy} onClick={confirmDelete} data-testid="delete-confirm">
                    {deleteBusy ? "Deleting…" : "Delete folder"}
                  </button>
                  <button type="button" className="ps2-btn-ghost" disabled={deleteBusy} onClick={() => setDeleteFolder(null)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Ps2Shell>
  );
}
