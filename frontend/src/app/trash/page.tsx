"use client";

// Trash page (specs/trash-system.md, design/wireframes/trash-page.svg —
// Option A: dedicated /trash page, own top-bar entry, mirrors /activity and
// /search). Owner-gated like every other authed page. Photos/Folders tabs,
// each row showing "N days left" (urgent red styling under ~2 days, matching
// the wireframe), a Recover button, and a genuinely-irreversible Delete
// forever button. An Empty trash button up top with its own strong in-app
// confirm (window.confirm is NOT enough for something this irreversible —
// matches /organize's existing modal conventions, e.g. its delete-folder
// confirm). The restore-collision state (a folder-restore 409 with the
// conflict shape) is handled inline exactly as wireframed: "Merge into
// existing '<name>'" or "Rename & restore as '<name> (2)'".

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  isRestoreConflict,
  PhotoRestoreOnConflict,
  photosApi,
  RestoreConflictBody,
  trashApi,
  TrashFolderItem,
  TrashPhotoItem,
} from "@/lib/api";

const PAGE_LIMIT = 20;
const URGENT_DAYS = 2;

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

type Tab = "photos" | "folders";

// Per-folder-row restore-collision state, keyed by folder id. Holds the
// conflict payload plus an optional in-progress "rename" text-entry draft.
type CollisionState = {
  conflictingFolderId: string;
  conflictingFolderName: string;
  renaming: boolean; // true once the user picked "type a name" for the rename path
  renameDraft: string;
  busy: boolean;
  error: string | null;
};

// Photo-restore collision state (REVISED — backend commit 6443d87): a single
// trashed photo whose folder is ALSO trashed no longer cascades into
// restoring that folder. The choice here is "existing" (drop the photo into
// the live same-named folder) vs "new" (leave the trashed folder alone,
// create/use a brand-new folder for just this photo) — a different
// vocabulary from CollisionState's merge/rename, which is folder-restore-only.
type PhotoCollisionState = {
  conflictingFolderId: string;
  conflictingFolderName: string;
  customizingNewName: boolean; // true once the user opts to type a custom new-folder name
  newNameDraft: string;
  busy: boolean;
  error: string | null;
};

export default function TrashPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  const [tab, setTab] = useState<Tab>("photos");
  const [photos, setPhotos] = useState<TrashPhotoItem[]>([]);
  const [photoTotal, setPhotoTotal] = useState(0);
  const [folders, setFolders] = useState<TrashFolderItem[]>([]);
  const [folderTotal, setFolderTotal] = useState(0);
  const [offset, setOffset] = useState(0);
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

  // Brief, cheap confirmation of which folder a restored photo landed in —
  // auto-clears after a few seconds. Not required by spec, just nice.
  const [restoreToast, setRestoreToast] = useState<string | null>(null);
  useEffect(() => {
    if (!restoreToast) return;
    const t = setTimeout(() => setRestoreToast(null), 4000);
    return () => clearTimeout(t);
  }, [restoreToast]);

  useEffect(() => {
    authApi
      .me()
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  const load = useCallback(
    async (pageOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await trashApi.list({ limit: PAGE_LIMIT, offset: pageOffset });
        setPhotos(res.photos);
        setPhotoTotal(res.photoTotal);
        setFolders(res.folders);
        setFolderTotal(res.folderTotal);
        setOffset(res.offset);
      } catch (err) {
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load trash");
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    if (checking) return;
    let cancelled = false;
    (async () => {
      await load(0);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checking]);

  function clearRowError(id: string) {
    setRowError((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // ---- Recover a photo. If it 409s with the conflict shape (its folder is
  // ALSO trashed and restoring it collides), surface the SAME inline
  // merge/rename choice as a folder row, keyed by photo id. ----
  async function handleRecoverPhoto(photo: TrashPhotoItem) {
    setBusyId(photo.id);
    clearRowError(photo.id);
    try {
      const result = await photosApi.restore(photo.id);
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setPhotoTotal((prev) => Math.max(0, prev - 1));
      setPhotoCollisions((prev) => {
        if (!(photo.id in prev)) return prev;
        const next = { ...prev };
        delete next[photo.id];
        return next;
      });
      if (result.folder) {
        setRestoreToast(`Restored "${photo.originalFilename}" to "${result.folder.name}"`);
      }
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
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
      } else {
        setRowError((prev) => ({ ...prev, [photo.id]: err instanceof Error ? err.message : "Restore failed" }));
      }
    } finally {
      setBusyId(null);
    }
  }

  // ---- Resolve a photo-restore collision (REVISED — backend commit 6443d87):
  // calls the PHOTO restore endpoint itself with the chosen onConflict — the
  // photo's own trashed folder is never touched, never restored. "existing"
  // lands the photo in the live same-named folder; "new" creates/uses a
  // brand-new folder just for this photo (newName optional — the backend
  // auto-generates a safe name when omitted). ----
  async function resolvePhotoCollision(photo: TrashPhotoItem, onConflict: PhotoRestoreOnConflict, newName?: string) {
    const collision = photoCollisions[photo.id];
    if (!collision) return;
    setPhotoCollisions((prev) => ({ ...prev, [photo.id]: { ...collision, busy: true, error: null } }));
    try {
      const result = await photosApi.restore(photo.id, { onConflict, newName });
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      setPhotoTotal((prev) => Math.max(0, prev - 1));
      setPhotoCollisions((prev) => {
        const next = { ...prev };
        delete next[photo.id];
        return next;
      });
      if (result.folder) {
        setRestoreToast(`Restored "${photo.originalFilename}" to "${result.folder.name}"`);
      }
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setPhotoCollisions((prev) => ({
        ...prev,
        [photo.id]: {
          ...prev[photo.id],
          busy: false,
          error: err instanceof Error ? err.message : "Restore failed",
        },
      }));
    }
  }

  // ---- Recover a folder. Plain restore; on a 409 conflict, show the inline
  // merge/rename choice. ----
  async function handleRecoverFolder(folder: TrashFolderItem) {
    setBusyId(folder.id);
    clearRowError(folder.id);
    try {
      const { foldersApi } = await import("@/lib/api");
      await foldersApi.restore(folder.id);
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      setFolderTotal((prev) => Math.max(0, prev - 1));
      setFolderCollisions((prev) => {
        if (!(folder.id in prev)) return prev;
        const next = { ...prev };
        delete next[folder.id];
        return next;
      });
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
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
      const { foldersApi } = await import("@/lib/api");
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
      setFolderCollisions((prev) => ({
        ...prev,
        [folder.id]: {
          ...prev[folder.id],
          busy: false,
          error: err instanceof Error ? err.message : "Restore failed",
        },
      }));
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
      setRowError((prev) => ({
        ...prev,
        [permDeleteTarget.id]: err instanceof Error ? err.message : "Permanent delete failed",
      }));
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

  const isEmpty = photoTotal === 0 && folderTotal === 0;

  return (
    <main className="organize-shell trash-shell">
      <div className="organize-topbar">
        <h1>
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="trash-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Trash
        </h1>
        <div className="dashboard-topbar-right">
          <Link href="/upload" className="dashboard-guests-link">Upload</Link>
          <Link href="/organize" className="dashboard-guests-link">Organize</Link>
          <Link href="/browse" className="dashboard-guests-link">Browse</Link>
          <Link href="/search" className="dashboard-guests-link">Search</Link>
          <Link href="/guests" className="dashboard-guests-link">Guests</Link>
          <Link href="/activity" className="dashboard-guests-link">Activity</Link>
        </div>
      </div>

      <div className="trash-content">
        {restoreToast && (
          <p className="trash-restore-toast" data-testid="trash-restore-toast">
            {restoreToast}
          </p>
        )}
        <div className="trash-header">
          <div>
            <h2>Trash</h2>
            <p className="trash-subhead">Items are permanently purged automatically after 7 days.</p>
          </div>
          <button
            type="button"
            className="trash-empty-btn"
            data-testid="trash-empty-open"
            disabled={isEmpty}
            onClick={() => setEmptyConfirmOpen(true)}
          >
            Empty trash…
          </button>
        </div>

        <div className="trash-tabs">
          <button
            type="button"
            className={`trash-tab${tab === "photos" ? " active" : ""}`}
            data-testid="trash-tab-photos"
            onClick={() => setTab("photos")}
          >
            Photos ({photoTotal})
          </button>
          <button
            type="button"
            className={`trash-tab${tab === "folders" ? " active" : ""}`}
            data-testid="trash-tab-folders"
            onClick={() => setTab("folders")}
          >
            Folders ({folderTotal})
          </button>
        </div>

        {error && <p className="organize-new-folder-error">{error}</p>}
        {loading && <p className="organize-empty">Loading trash…</p>}

        {!loading && !error && isEmpty && <p className="organize-empty">Trash is empty.</p>}

        {!loading && !error && tab === "photos" && photos.length === 0 && photoTotal === 0 && !isEmpty && (
          <p className="organize-empty">No trashed photos.</p>
        )}

        {!loading && !error && tab === "photos" && photos.length > 0 && (
          <ul className="trash-list" data-testid="trash-photo-list">
            {photos.map((photo) => {
              const collision = photoCollisions[photo.id];
              const urgent = photo.daysRemaining <= URGENT_DAYS;
              return (
                <li key={photo.id} className={`trash-row${urgent ? " urgent" : ""}`} data-testid={`trash-photo-${photo.id}`}>
                  <div className="trash-row-main">
                    <div className="trash-row-thumb" />
                    <div>
                      <p className="trash-row-title">{photo.originalFilename}</p>
                      <p className="trash-row-meta">deleted {new Date(photo.deletedAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <div className="trash-row-actions">
                    <span className={`trash-days-badge${urgent ? " urgent" : ""}`}>
                      {photo.daysRemaining} day{photo.daysRemaining === 1 ? "" : "s"} left
                    </span>
                    <button
                      type="button"
                      className="trash-recover-btn"
                      data-testid={`trash-recover-photo-${photo.id}`}
                      disabled={busyId === photo.id}
                      onClick={() => handleRecoverPhoto(photo)}
                    >
                      {busyId === photo.id ? "…" : "Recover"}
                    </button>
                    <button
                      type="button"
                      className="trash-delete-forever-btn"
                      data-testid={`trash-purge-photo-${photo.id}`}
                      onClick={() =>
                        setPermDeleteTarget({ type: "photo", id: photo.id, label: photo.originalFilename })
                      }
                    >
                      Delete forever
                    </button>
                  </div>
                  {rowError[photo.id] && <p className="organize-new-folder-error trash-row-error">{rowError[photo.id]}</p>}
                  {collision && (
                    <PhotoCollisionPanel
                      collision={collision}
                      onUseExisting={() => resolvePhotoCollision(photo, "existing")}
                      onCreateNew={(name) => resolvePhotoCollision(photo, "new", name || undefined)}
                      onDraftChange={(draft) =>
                        setPhotoCollisions((prev) => ({ ...prev, [photo.id]: { ...prev[photo.id], newNameDraft: draft } }))
                      }
                      onStartCustomizing={() =>
                        setPhotoCollisions((prev) => ({ ...prev, [photo.id]: { ...prev[photo.id], customizingNewName: true } }))
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!loading && !error && tab === "folders" && folders.length === 0 && folderTotal === 0 && !isEmpty && (
          <p className="organize-empty">No trashed folders.</p>
        )}

        {!loading && !error && tab === "folders" && folders.length > 0 && (
          <ul className="trash-list" data-testid="trash-folder-list">
            {folders.map((folder) => {
              const collision = folderCollisions[folder.id];
              const urgent = folder.daysRemaining <= URGENT_DAYS;
              return (
                <li key={folder.id} className={`trash-row${urgent ? " urgent" : ""}`} data-testid={`trash-folder-${folder.id}`}>
                  <div className="trash-row-main">
                    <div>
                      <p className="trash-row-title">📁 {folder.name}</p>
                      <p className="trash-row-meta">
                        {folder.photoCount} photos · deleted {new Date(folder.deletedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="trash-row-actions">
                    <span className={`trash-days-badge${urgent ? " urgent" : ""}`}>
                      {folder.daysRemaining} day{folder.daysRemaining === 1 ? "" : "s"} left
                    </span>
                    <button
                      type="button"
                      className="trash-recover-btn"
                      data-testid={`trash-recover-folder-${folder.id}`}
                      disabled={busyId === folder.id}
                      onClick={() => handleRecoverFolder(folder)}
                    >
                      {busyId === folder.id ? "…" : "Recover"}
                    </button>
                    <button
                      type="button"
                      className="trash-delete-forever-btn"
                      data-testid={`trash-purge-folder-${folder.id}`}
                      onClick={() => setPermDeleteTarget({ type: "folder", id: folder.id, label: folder.name })}
                    >
                      Delete forever
                    </button>
                  </div>
                  {rowError[folder.id] && <p className="organize-new-folder-error trash-row-error">{rowError[folder.id]}</p>}
                  {collision && (
                    <CollisionPanel
                      collision={collision}
                      onMerge={() => resolveFolderCollision(folder, "merge")}
                      onRename={(name) => resolveFolderCollision(folder, "rename", name)}
                      onDraftChange={(draft) =>
                        setFolderCollisions((prev) => ({ ...prev, [folder.id]: { ...prev[folder.id], renameDraft: draft } }))
                      }
                      onStartRename={() =>
                        setFolderCollisions((prev) => ({ ...prev, [folder.id]: { ...prev[folder.id], renaming: true } }))
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Permanent single-item delete confirm — genuinely irreversible, red,
          explicit "cannot be undone" copy. Real confirm (not window.confirm),
          matching /organize's existing modal conventions. */}
      {permDeleteTarget && (
        <div
          className="organize-modal-backdrop"
          data-testid="trash-purge-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget && !permDeleteBusy) setPermDeleteTarget(null);
          }}
        >
          <div className="organize-modal trash-danger-modal">
            <h3>Delete &quot;{permDeleteTarget.label}&quot; forever?</h3>
            <p className="organize-modal-sub trash-danger-copy">
              This permanently deletes it right now. This cannot be undone.
            </p>
            <div className="organize-modal-actions">
              <button
                type="button"
                className="organize-modal-delete"
                data-testid="trash-purge-confirm"
                disabled={permDeleteBusy}
                onClick={confirmPermDelete}
              >
                {permDeleteBusy ? "Deleting…" : "Delete forever"}
              </button>
              <button
                type="button"
                className="organize-modal-cancel"
                disabled={permDeleteBusy}
                onClick={() => setPermDeleteTarget(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Empty-trash confirm — the strongest confirm on this page, since it
          purges EVERYTHING right now. A real in-app dialog per the task's
          explicit instruction (window.confirm is not enough here). */}
      {emptyConfirmOpen && (
        <div
          className="organize-modal-backdrop"
          data-testid="trash-empty-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget && !emptyBusy) setEmptyConfirmOpen(false);
          }}
        >
          <div className="organize-modal trash-danger-modal trash-empty-modal">
            <h3>Empty trash? This cannot be undone.</h3>
            <p className="organize-modal-sub trash-danger-copy">
              Permanently deletes {photoTotal} photo{photoTotal === 1 ? "" : "s"} and {folderTotal} folder
              {folderTotal === 1 ? "" : "s"} right now.
            </p>
            {emptyError && <p className="organize-new-folder-error">{emptyError}</p>}
            <div className="organize-modal-actions">
              <button
                type="button"
                className="trash-empty-confirm-btn"
                data-testid="trash-empty-confirm"
                disabled={emptyBusy}
                onClick={confirmEmptyTrash}
              >
                {emptyBusy ? "Emptying…" : "Empty trash now"}
              </button>
              <button
                type="button"
                className="organize-modal-cancel"
                disabled={emptyBusy}
                onClick={() => setEmptyConfirmOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// Photo-restore collision panel (REVISED — backend commit 6443d87). This is
// deliberately NOT the same copy as CollisionPanel below: restoring a single
// PHOTO never brings back the whole trashed folder anymore, so "Merge"/
// "Rename" language (which describes restoring/renaming an entire folder)
// would misdescribe what's actually happening. The real choice for a photo
// is: drop it into the live folder that already has this name, or leave the
// old trashed folder alone and get a fresh folder just for this one photo.
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
    <div className="trash-collision" data-testid="trash-photo-collision-panel">
      <p className="trash-collision-title">
        A folder named &quot;{collision.conflictingFolderName}&quot; already exists
      </p>
      <p className="trash-collision-sub">
        This photo&apos;s original folder is still in the trash and won&apos;t be restored. Choose where this photo
        should go instead:
      </p>
      {!collision.customizingNewName ? (
        <div className="trash-collision-actions">
          <button type="button" className="trash-collision-merge" disabled={collision.busy} onClick={onUseExisting}>
            Put it in the existing &quot;{collision.conflictingFolderName}&quot; folder
          </button>
          <button
            type="button"
            className="trash-collision-rename"
            disabled={collision.busy}
            onClick={() => onCreateNew("")}
          >
            Create a new folder for it
          </button>
          <button
            type="button"
            className="trash-collision-rename-link"
            disabled={collision.busy}
            onClick={onStartCustomizing}
          >
            Name the new folder myself…
          </button>
        </div>
      ) : (
        <div className="trash-collision-rename-row">
          <input
            type="text"
            placeholder={`${collision.conflictingFolderName} (recovered)`}
            value={collision.newNameDraft}
            disabled={collision.busy}
            onChange={(e) => onDraftChange(e.target.value)}
          />
          <button
            type="button"
            className="trash-collision-rename"
            disabled={collision.busy}
            onClick={() => onCreateNew(collision.newNameDraft.trim())}
          >
            {collision.busy ? "…" : "Create & restore"}
          </button>
        </div>
      )}
      {collision.error && <p className="organize-new-folder-error">{collision.error}</p>}
    </div>
  );
}

// Inline restore-collision panel, shared between a photo row and a folder
// row (per the wireframe's "Can't recover ... a folder named ... already
// exists" block): two primary choices — "Merge into existing '<name>'" or
// "Rename & restore as '<name> (2)'" — plus a free-text override for the
// rename target.
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
    <div className="trash-collision" data-testid="trash-collision-panel">
      <p className="trash-collision-title">
        Can&apos;t recover — a folder named &quot;{collision.conflictingFolderName}&quot; already exists
      </p>
      <p className="trash-collision-sub">
        You created a new &quot;{collision.conflictingFolderName}&quot; folder after this one was trashed. Choose how to
        bring it back:
      </p>
      {!collision.renaming ? (
        <div className="trash-collision-actions">
          <button type="button" className="trash-collision-merge" disabled={collision.busy} onClick={onMerge}>
            Merge into existing &quot;{collision.conflictingFolderName}&quot;
          </button>
          <button type="button" className="trash-collision-rename" disabled={collision.busy} onClick={onStartRename}>
            Rename &amp; restore as &quot;{collision.renameDraft}&quot;
          </button>
        </div>
      ) : (
        <div className="trash-collision-rename-row">
          <input
            type="text"
            value={collision.renameDraft}
            disabled={collision.busy}
            onChange={(e) => onDraftChange(e.target.value)}
          />
          <button
            type="button"
            className="trash-collision-rename"
            disabled={collision.busy || !collision.renameDraft.trim()}
            onClick={() => onRename(collision.renameDraft.trim())}
          >
            {collision.busy ? "…" : "Restore with this name"}
          </button>
        </div>
      )}
      {collision.error && <p className="organize-new-folder-error">{collision.error}</p>}
    </div>
  );
}
