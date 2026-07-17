"use client";

// Guests page (specs/guest-access-otp.md, design/wireframes/guest-management.svg
// - U2 Option C: single prioritized feed). Pending OTP-approval requests
// float to the top under an attention banner (email, IP/device, "requested
// N min ago", inline 6-digit OTP entry, Approve/Deny, attempts/expiry
// hint) - GET /api/access-requests?status=pending, then
// POST /api/access-requests/:id/approve|deny. Below that in the same
// stream: the guest roster (GET /api/guests) with status pills and one-tap
// Revoke (DELETE /api/guests/:id). "+ Share new folders" reaches /share.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AccessRequestItem,
  accessRequestsApi,
  ApiError,
  authApi,
  collectionsApi,
  Folder,
  foldersApi,
  GuestListItem,
  guestsApi,
  PermissionLevel,
} from "@/lib/api";

const PERMISSION_LEVELS: PermissionLevel[] = ["view", "download", "download_all"];

// Owner-session-loss detector. Use this ONLY on calls where a 401 genuinely
// means the OWNER's session is gone (the initial authApi.me() gate, the
// list() calls in load(), and revoke). Do NOT use it on the approve/deny
// endpoints: there a 401 is a business response ("Invalid code" for a wrong
// OTP), not an auth failure - bouncing the owner to /login on a mistyped
// digit is BUG-1. Approve/deny surface every error inline instead.
function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

export default function GuestsPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  const [pending, setPending] = useState<AccessRequestItem[]>([]);
  const [guests, setGuests] = useState<GuestListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-request OTP input + action state, keyed by access_request id.
  const [otpInputs, setOtpInputs] = useState<Record<string, string>>({});
  const [actionState, setActionState] = useState<Record<string, { busy: boolean; error: string | null }>>({});
  const [revokeState, setRevokeState] = useState<Record<string, { busy: boolean; error: string | null }>>({});
  const [permissionState, setPermissionState] = useState<Record<string, { busy: boolean; error: string | null }>>({});

  // ---- Per-folder access management (bug report: after a guest was
  // approved, there was no way to later share MORE folders with them, or
  // remove access to just one). ----
  const [removeFolderState, setRemoveFolderState] = useState<
    Record<string, { busy: boolean; error: string | null }>
  >({}); // keyed by `${guestId}:${folderId}`
  const [addFoldersTarget, setAddFoldersTarget] = useState<GuestListItem | null>(null);
  const [ownerFolders, setOwnerFolders] = useState<Folder[]>([]);
  const [ownerFoldersLoading, setOwnerFoldersLoading] = useState(false);
  const [ownerFoldersError, setOwnerFoldersError] = useState<string | null>(null);
  const [addFoldersSelected, setAddFoldersSelected] = useState<Set<string>>(new Set());
  const [addFoldersBusy, setAddFoldersBusy] = useState(false);
  const [addFoldersError, setAddFoldersError] = useState<string | null>(null);

  // ---- Auth gate (same pattern as /organize, /browse, /dashboard, /share) ----
  useEffect(() => {
    authApi
      .me()
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [pendingRes, guestsRes] = await Promise.all([
        accessRequestsApi.list("pending"),
        guestsApi.list(),
      ]);
      setPending(pendingRes.requests);
      setGuests(guestsRes.guests);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setLoadError(err instanceof Error ? err.message : "Failed to load guests");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (checking) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [checking, load]);

  async function handleApprove(requestId: string) {
    const otp = (otpInputs[requestId] ?? "").trim();
    if (!/^\d{6}$/.test(otp)) {
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: "Enter the 6-digit code" } }));
      return;
    }
    setActionState((prev) => ({ ...prev, [requestId]: { busy: true, error: null } }));
    try {
      await accessRequestsApi.approve(requestId, otp);
      setPending((prev) => prev.filter((r) => r.id !== requestId));
      await load();
    } catch (err) {
      // DELIBERATELY no isAuthError()->/login here (BUG-1). The approve
      // endpoint's errors are all business responses about the OTP, NOT the
      // owner's own session:
      //   401 "Invalid code"      -> wrong OTP; show inline, owner retries.
      //   403 "request denied"    -> 3rd wrong attempt auto-denied the request.
      //   403 "expired" / "OTP expired" -> the code timed out.
      // Every case stays on the page with an inline message. On a 403 the
      // request is now terminal (auto-denied/expired), so refresh the list to
      // drop it out of the pending stream.
      const message = err instanceof Error ? err.message : "Approval failed";
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: message } }));
      if (err instanceof ApiError && err.status === 403) {
        await load();
      }
    }
  }

  async function handleDeny(requestId: string) {
    setActionState((prev) => ({ ...prev, [requestId]: { busy: true, error: null } }));
    try {
      await accessRequestsApi.deny(requestId);
      setPending((prev) => prev.filter((r) => r.id !== requestId));
      await load();
    } catch (err) {
      // Same as approve: deny is an operation on the request, not an
      // owner-session gate. Its errors (403/409 on an already-resolved
      // request) surface inline; we never treat them as "owner logged out".
      const message = err instanceof Error ? err.message : "Deny failed";
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: message } }));
    }
  }

  async function handleRevoke(guestId: string) {
    setRevokeState((prev) => ({ ...prev, [guestId]: { busy: true, error: null } }));
    try {
      await guestsApi.revoke(guestId);
      await load();
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      const message = err instanceof Error ? err.message : "Revoke failed";
      setRevokeState((prev) => ({ ...prev, [guestId]: { busy: false, error: message } }));
    }
  }

  // ---- Change an existing guest's permission level (bug report: previously
  // the only option once shared was Revoke — no way to e.g. start someone at
  // "view" and later upgrade them to "download" without tearing the share
  // down and re-inviting from scratch). ----
  async function handleChangePermission(guestId: string, permissionLevel: PermissionLevel) {
    setPermissionState((prev) => ({ ...prev, [guestId]: { busy: true, error: null } }));
    try {
      await guestsApi.updatePermission(guestId, permissionLevel);
      await load();
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      const message = err instanceof Error ? err.message : "Couldn't change permission";
      setPermissionState((prev) => ({ ...prev, [guestId]: { busy: false, error: message } }));
    }
  }

  // ---- Remove this guest's access to ONE specific folder (distinct from
  // Revoke, which cuts off everything). ----
  async function handleRemoveFolder(guestId: string, folderId: string) {
    const key = `${guestId}:${folderId}`;
    setRemoveFolderState((prev) => ({ ...prev, [key]: { busy: true, error: null } }));
    try {
      await guestsApi.removeFolder(guestId, folderId);
      await load();
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      const message = err instanceof Error ? err.message : "Couldn't remove folder access";
      setRemoveFolderState((prev) => ({ ...prev, [key]: { busy: false, error: message } }));
    }
  }

  // ---- Share additional folders with an existing guest. Opens a small
  // picker of the owner's folders NOT already shared with this guest. ----
  async function openAddFolders(guest: GuestListItem) {
    setAddFoldersTarget(guest);
    setAddFoldersSelected(new Set());
    setAddFoldersError(null);
    setOwnerFoldersLoading(true);
    setOwnerFoldersError(null);
    try {
      const { collections } = await collectionsApi.list();
      const defaultCollection = collections.find((c) => c.isDefault) ?? collections[0];
      if (!defaultCollection) {
        setOwnerFolders([]);
        return;
      }
      const { folders } = await foldersApi.list(defaultCollection.id);
      setOwnerFolders(folders);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setOwnerFoldersError(err instanceof Error ? err.message : "Failed to load folders");
    } finally {
      setOwnerFoldersLoading(false);
    }
  }

  function closeAddFolders() {
    if (addFoldersBusy) return;
    setAddFoldersTarget(null);
  }

  function toggleAddFolder(folderId: string) {
    setAddFoldersSelected((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  async function confirmAddFolders() {
    if (!addFoldersTarget || addFoldersSelected.size === 0) return;
    setAddFoldersBusy(true);
    setAddFoldersError(null);
    try {
      await guestsApi.addFolders(addFoldersTarget.id, Array.from(addFoldersSelected));
      setAddFoldersTarget(null);
      await load();
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setAddFoldersError(err instanceof Error ? err.message : "Couldn't add folders");
    } finally {
      setAddFoldersBusy(false);
    }
  }

  if (checking) return null;

  return (
    <main className="guests-shell">
      <div className="organize-topbar">
        <h1>
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="guests-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Guests
        </h1>
        <div className="dashboard-topbar-right">
          <Link href="/v2/share" className="dashboard-guests-link" data-testid="guests-try-v2-link">
            ✨ Try new design
          </Link>
          <Link href="/upload" className="dashboard-guests-link" data-testid="guests-upload-link">
            Upload
          </Link>
          <Link href="/organize" className="dashboard-guests-link" data-testid="guests-organize-link">
            Organize
          </Link>
          <Link href="/browse" className="dashboard-guests-link" data-testid="guests-browse-link">
            Browse
          </Link>
          <Link href="/search" className="dashboard-guests-link" data-testid="guests-search-link">
            Search
          </Link>
          <Link href="/activity" className="dashboard-guests-link" data-testid="guests-activity-link">
            Activity
          </Link>
          <Link href="/trash" className="dashboard-guests-link" data-testid="guests-trash-link">
            Trash
          </Link>
        </div>
      </div>

      <div className="guests-content">
        <div className="guests-head">
          <h2>Guest activity</h2>
          <Link href="/share" className="guests-new-share-link" data-testid="guests-new-share-link">
            + Share new folders
          </Link>
        </div>

        {loading && <p className="organize-empty">Loading…</p>}
        {loadError && <p className="share-error">{loadError}</p>}

        {!loading && !loadError && (
          <>
            {pending.length > 0 && (
              <>
                <div className="guests-attention-banner" data-testid="guests-attention-banner">
                  {pending.length} request{pending.length === 1 ? "" : "s"} need your approval — enter the code you
                  received to let each guest in.
                </div>

                {pending.map((request) => {
                  const otp = otpInputs[request.id] ?? "";
                  const state = actionState[request.id] ?? { busy: false, error: null };
                  const folderNames = guests.find((g) => g.id === request.guest.id)?.folders.map((f) => f.name) ?? [];
                  return (
                    <div key={request.id} className="guests-pending-card" data-testid={`guests-pending-card-${request.id}`}>
                      <div className="guests-pending-head">
                        <span className="email">{request.guest.email}</span>
                      </div>
                      <div className="guests-pending-meta">
                        {folderNames.length > 0 ? `wants ${folderNames.join(", ")} · ` : ""}
                        {request.ipAddress ? `IP ${request.ipAddress} · ` : ""}
                        {request.deviceInfo?.userAgent ? `${request.deviceInfo.userAgent} · ` : ""}
                        {timeAgo(request.createdAt)}
                      </div>

                      {request.multipleDevicesDetected && (
                        <p className="guests-multidevice-warning" data-testid={`guests-multidevice-warning-${request.id}`}>
                          ⚠ This invite link was opened from {request.distinctDeviceCount} different devices/networks
                          before this request was resolved — possibly forwarded to someone else. Review before approving.
                        </p>
                      )}

                      <div className="guests-pending-actions">
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="6-digit code"
                          className="guests-otp-input"
                          value={otp}
                          onChange={(e) =>
                            setOtpInputs((prev) => ({ ...prev, [request.id]: e.target.value.replace(/\D/g, "") }))
                          }
                          data-testid={`guests-otp-input-${request.id}`}
                        />
                        <button
                          type="button"
                          className="guests-approve-btn"
                          disabled={state.busy}
                          onClick={() => handleApprove(request.id)}
                          data-testid={`guests-approve-button-${request.id}`}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="guests-deny-btn"
                          disabled={state.busy}
                          onClick={() => handleDeny(request.id)}
                          data-testid={`guests-deny-button-${request.id}`}
                        >
                          Deny
                        </button>
                      </div>

                      {state.error && <p className="guests-pending-error">{state.error}</p>}
                    </div>
                  );
                })}
              </>
            )}

            <h3 className="guests-roster-head">Active &amp; past guests</h3>

            {guests.length === 0 ? (
              <p className="guests-empty">No guests yet — create a share to invite one.</p>
            ) : (
              guests.map((guest) => {
                const revoke = revokeState[guest.id] ?? { busy: false, error: null };
                const permission = permissionState[guest.id] ?? { busy: false, error: null };
                const canRevoke = guest.status !== "revoked";
                const canChangePermission = guest.status !== "revoked" && guest.permissionLevel != null;
                return (
                  <div key={guest.id} className={`guests-roster-row${guest.status === "revoked" ? " revoked" : ""}`} data-testid={`guests-roster-row-${guest.id}`}>
                    <span className="email">{guest.email}</span>
                    <span className="meta">
                      {guest.permissionLevel ? `${guest.permissionLevel} · ` : ""}
                      {guest.lastAccessAt ? `last seen ${timeAgo(guest.lastAccessAt)}` : "not seen yet"}
                    </span>
                    <span className={`guests-status-pill ${guest.status}`}>{guest.status}</span>
                    {canChangePermission && (
                      <select
                        className="guests-permission-select"
                        value={guest.permissionLevel ?? ""}
                        disabled={permission.busy}
                        onChange={(e) => handleChangePermission(guest.id, e.target.value as PermissionLevel)}
                        data-testid={`guests-permission-select-${guest.id}`}
                      >
                        {PERMISSION_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    )}
                    {canRevoke && (
                      <button
                        type="button"
                        className="guests-revoke-btn"
                        disabled={revoke.busy}
                        onClick={() => handleRevoke(guest.id)}
                        data-testid={`guests-revoke-button-${guest.id}`}
                      >
                        Revoke
                      </button>
                    )}
                    {revoke.error && <p className="guests-pending-error">{revoke.error}</p>}
                    {permission.error && <p className="guests-pending-error">{permission.error}</p>}

                    {/* Per-folder access — removable chips + "add more" (bug
                        report: no way to share more folders or remove one
                        after the fact). Hidden once fully revoked. */}
                    {guest.status !== "revoked" && (
                      <div className="guests-folder-chips">
                        {guest.folders.length === 0 ? (
                          <span className="guests-folder-empty">no folders</span>
                        ) : (
                          guest.folders.map((folder) => {
                            const removeKey = `${guest.id}:${folder.id}`;
                            const removeState = removeFolderState[removeKey] ?? { busy: false, error: null };
                            return (
                              <span key={folder.id} className="guests-folder-chip">
                                {folder.name}
                                <button
                                  type="button"
                                  className="guests-folder-chip-remove"
                                  disabled={removeState.busy}
                                  onClick={() => handleRemoveFolder(guest.id, folder.id)}
                                  data-testid={`guests-remove-folder-${guest.id}-${folder.id}`}
                                  title={`Remove access to "${folder.name}"`}
                                >
                                  ×
                                </button>
                              </span>
                            );
                          })
                        )}
                        <button
                          type="button"
                          className="guests-add-folders-btn"
                          onClick={() => openAddFolders(guest)}
                          data-testid={`guests-add-folders-${guest.id}`}
                        >
                          + Add folders
                        </button>
                      </div>
                    )}
                    {Object.entries(removeFolderState)
                      .filter(([key, s]) => key.startsWith(`${guest.id}:`) && s.error)
                      .map(([key, s]) => (
                        <p key={key} className="guests-pending-error">
                          {s.error}
                        </p>
                      ))}
                  </div>
                );
              })
            )}
          </>
        )}
      </div>

      {/* "Add folders" picker — the owner's folders NOT already shared with
          this guest, checkbox multi-select, added at the guest's current
          permission level. */}
      {addFoldersTarget && (
        <div
          className="organize-modal-backdrop"
          data-testid="add-folders-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAddFolders();
          }}
        >
          <div className="organize-modal">
            <h3>Share more folders with {addFoldersTarget.email}</h3>
            {ownerFoldersLoading && <p className="organize-empty">Loading your folders…</p>}
            {ownerFoldersError && <p className="organize-new-folder-error">{ownerFoldersError}</p>}
            {addFoldersError && <p className="organize-new-folder-error">{addFoldersError}</p>}
            {!ownerFoldersLoading && !ownerFoldersError && (
              <>
                {(() => {
                  const alreadyShared = new Set(addFoldersTarget.folders.map((f) => f.id));
                  const candidates = ownerFolders.filter((f) => !alreadyShared.has(f.id));
                  if (candidates.length === 0) {
                    return <p className="organize-empty">Every folder is already shared with this guest.</p>;
                  }
                  return (
                    <div className="add-folders-list">
                      {candidates.map((folder) => (
                        <label key={folder.id} className="add-folders-item">
                          <input
                            type="checkbox"
                            checked={addFoldersSelected.has(folder.id)}
                            disabled={addFoldersBusy}
                            onChange={() => toggleAddFolder(folder.id)}
                            data-testid={`add-folders-checkbox-${folder.id}`}
                          />
                          {folder.name} ({folder.photoCount})
                        </label>
                      ))}
                    </div>
                  );
                })()}
              </>
            )}
            <div className="organize-modal-actions">
              <button
                type="button"
                className="organize-modal-delete"
                data-testid="add-folders-confirm"
                disabled={addFoldersBusy || addFoldersSelected.size === 0}
                onClick={confirmAddFolders}
              >
                {addFoldersBusy ? "Adding…" : `Add ${addFoldersSelected.size || ""} folder${addFoldersSelected.size === 1 ? "" : "s"}`}
              </button>
              <button type="button" className="organize-modal-cancel" disabled={addFoldersBusy} onClick={closeAddFolders}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
