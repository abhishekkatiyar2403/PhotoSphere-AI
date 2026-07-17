"use client";

// Share & Guests v2 — redesign handoff (README.md "Share & Guests",
// PhotoSphere.dc.html Share screen). The prototype's single "Share & guests"
// screen combines a create-link card, an active-links/guest list, and guest
// management — which in the real app is split across /share (create) and
// /guests (pending OTP approvals + roster). This v2 page unifies both onto
// one screen, wired to the same real endpoints:
//   - create: guestsApi.create (folder multi-select + email + permission + expiry)
//   - approvals: accessRequestsApi.list/approve/deny (inline 6-digit OTP)
//   - roster: guestsApi.list/revoke/updatePermission/removeFolder/addFolders
// All auth-gate + 401 handling and the BUG-1 rule (a 401 on approve/deny is a
// business "invalid code", NOT an owner-session loss → never bounce to /login)
// are carried over from the classic /guests page exactly.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AccessRequestItem,
  accessRequestsApi,
  ApiError,
  authApi,
  collectionsApi,
  CreateGuestResponse,
  Folder,
  folderPhotosApi,
  FolderPhoto,
  foldersApi,
  GuestListItem,
  guestsApi,
  PermissionLevel,
} from "@/lib/api";
import Ps2Shell from "@/components/ps2/Shell";

const PERMISSION_OPTIONS: { value: PermissionLevel; label: string }[] = [
  { value: "view", label: "View only" },
  { value: "download", label: "Download" },
  { value: "download_all", label: "Download all" },
];
const PERMISSION_LEVELS: PermissionLevel[] = ["view", "download", "download_all"];
const EXPIRY_OPTIONS = [
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "", label: "Never" },
];

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

export default function ShareV2Page() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  const [folders, setFolders] = useState<Folder[]>([]);

  // Create-share form
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [guestEmail, setGuestEmail] = useState("");
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("download");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateGuestResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // Roster + pending
  const [pending, setPending] = useState<AccessRequestItem[]>([]);
  const [guests, setGuests] = useState<GuestListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [otpInputs, setOtpInputs] = useState<Record<string, string>>({});
  const [actionState, setActionState] = useState<Record<string, { busy: boolean; error: string | null }>>({});
  const [revokeState, setRevokeState] = useState<Record<string, { busy: boolean; error: string | null }>>({});
  const [permissionBusy, setPermissionBusy] = useState<Record<string, boolean>>({});
  const [removeFolderBusy, setRemoveFolderBusy] = useState<Record<string, boolean>>({});

  // Guest-view preview ("See what your guest sees" — README/design). Shows
  // the REAL first few photos in the guest's first shared folder, fetched
  // via the same folderPhotosApi the owner's own Browse view uses — no
  // fabricated data, and nothing the guest couldn't already see themselves.
  const [previewGuest, setPreviewGuest] = useState<GuestListItem | null>(null);
  const [previewPhotos, setPreviewPhotos] = useState<FolderPhoto[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function openGuestPreview(guest: GuestListItem) {
    setPreviewGuest(guest);
    setPreviewPhotos([]);
    setPreviewError(null);
    const folder = guest.folders[0];
    if (!folder) return;
    setPreviewLoading(true);
    try {
      const res = await folderPhotosApi.list(folder.id, { limit: 3, offset: 0 });
      setPreviewPhotos(res.photos);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to load preview");
    } finally {
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  const loadFolders = useCallback(async () => {
    try {
      const collectionsRes = await collectionsApi.list();
      const defaultCollection =
        collectionsRes.collections.find((c) => c.isDefault) ?? collectionsRes.collections[0] ?? null;
      if (!defaultCollection) {
        setFolders([]);
        return;
      }
      const foldersRes = await foldersApi.list(defaultCollection.id);
      setFolders(foldersRes.folders);
    } catch (err) {
      if (isAuthError(err)) router.replace("/login");
    }
  }, [router]);

  const loadGuests = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [pendingRes, guestsRes] = await Promise.all([accessRequestsApi.list("pending"), guestsApi.list()]);
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
  }, [router]);

  useEffect(() => {
    if (checking) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await Promise.all([loadFolders(), loadGuests()]);
    })();
    return () => {
      cancelled = true;
    };
  }, [checking, loadFolders, loadGuests]);

  function toggleFolder(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedFolders = folders.filter((f) => selectedIds.has(f.id));
  const tallyPhotoCount = selectedFolders.reduce((sum, f) => sum + f.photoCount, 0);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (selectedIds.size === 0) {
      setSubmitError("Select at least one folder to share.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    setCopied(false);
    try {
      const res = await guestsApi.create({
        guestEmail,
        folderIds: [...selectedIds],
        permissionLevel,
        expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
      });
      setResult(res);
      setSelectedIds(new Set());
      setGuestEmail("");
      await loadGuests();
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setSubmitError(err instanceof Error ? err.message : "Failed to create share");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (non-secure context) — link still selectable.
    }
  }

  // BUG-1: never bounce owner to /login on approve/deny errors — they're
  // business responses about the OTP, not owner-session loss.
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
      await loadGuests();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Approval failed";
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: message } }));
      if (err instanceof ApiError && err.status === 403) await loadGuests();
    }
  }

  async function handleDeny(requestId: string) {
    setActionState((prev) => ({ ...prev, [requestId]: { busy: true, error: null } }));
    try {
      await accessRequestsApi.deny(requestId);
      setPending((prev) => prev.filter((r) => r.id !== requestId));
      await loadGuests();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Deny failed";
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: message } }));
    }
  }

  async function handleRevoke(guestId: string) {
    setRevokeState((prev) => ({ ...prev, [guestId]: { busy: true, error: null } }));
    try {
      await guestsApi.revoke(guestId);
      await loadGuests();
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setRevokeState((prev) => ({ ...prev, [guestId]: { busy: false, error: err instanceof Error ? err.message : "Revoke failed" } }));
    }
  }

  async function handleChangePermission(guestId: string, level: PermissionLevel) {
    setPermissionBusy((prev) => ({ ...prev, [guestId]: true }));
    try {
      await guestsApi.updatePermission(guestId, level);
      await loadGuests();
    } catch (err) {
      if (isAuthError(err)) router.replace("/login");
    } finally {
      setPermissionBusy((prev) => ({ ...prev, [guestId]: false }));
    }
  }

  async function handleRemoveFolder(guestId: string, folderId: string) {
    const key = `${guestId}:${folderId}`;
    setRemoveFolderBusy((prev) => ({ ...prev, [key]: true }));
    try {
      await guestsApi.removeFolder(guestId, folderId);
      await loadGuests();
    } catch (err) {
      if (isAuthError(err)) router.replace("/login");
    } finally {
      setRemoveFolderBusy((prev) => ({ ...prev, [key]: false }));
    }
  }

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  return (
    <Ps2Shell active="share" userName={user.name} classicHref="/share">
      <main className="ps2-share" data-testid="share-v2">
        <h1 className="ps2-h1-page ps2-anim-up">Share &amp; guests</h1>
        <div className="ps2-share-sub">Guest links let anyone view (or download) a folder — no account needed.</div>

        {/* Create a share */}
        <form className="ps2-share-create" data-testid="share-create" onSubmit={handleCreate}>
          <h3>Create a link</h3>
          <div className="ps2-share-form-grid">
            <div className="ps2-share-full">
              <div className="ps2-field-label" style={{ marginBottom: 6 }}>Folders to share</div>
              {folders.length === 0 ? (
                <p className="ps2-modal-sub" style={{ margin: 0 }}>No folders yet — organize some photos first.</p>
              ) : (
                <div className="ps2-folder-picker" data-testid="share-folder-list">
                  {folders.map((folder) => (
                    <label key={folder.id} className="ps2-folder-pick-row">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(folder.id)}
                        onChange={() => toggleFolder(folder.id)}
                        data-testid={`share-folder-checkbox-${folder.name}`}
                      />
                      <span>{folder.name}</span>
                      <span className="count">{folder.photoCount}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="ps2-share-tally" data-testid="share-tally">
                {selectedFolders.length} folder{selectedFolders.length === 1 ? "" : "s"} · {tallyPhotoCount} photo
                {tallyPhotoCount === 1 ? "" : "s"} selected
              </div>
            </div>

            <div className="ps2-field ps2-share-full">
              <span className="ps2-field-label">Guest email</span>
              <input
                type="email"
                required
                className="ps2-input"
                placeholder="client@example.com"
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                data-testid="share-guest-email"
              />
            </div>

            <div className="ps2-field">
              <span className="ps2-field-label">Permission</span>
              <select className="ps2-select" value={permissionLevel} onChange={(e) => setPermissionLevel(e.target.value as PermissionLevel)} data-testid="share-permission-level">
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="ps2-field">
              <span className="ps2-field-label">Link expires</span>
              <select className="ps2-select" value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} data-testid="share-expiry">
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.label} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          {submitError && <p className="ps2-inline-error">{submitError}</p>}

          <div style={{ marginTop: 16 }}>
            <button type="submit" className="ps2-btn-accent" disabled={submitting || selectedIds.size === 0 || !guestEmail} data-testid="share-submit">
              {submitting ? "Generating…" : "Generate invite link"}
            </button>
          </div>

          {result && (
            <div className="ps2-share-result" data-testid="share-result">
              <div className="ps2-field-label">Shareable link</div>
              <div className="ps2-share-result-row">
                <input type="text" readOnly value={result.inviteUrl} data-testid="share-invite-url" />
                <button type="button" className="ps2-btn-accent" onClick={handleCopy} data-testid="share-copy-button">
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </form>

        {/* Pending approvals */}
        {loading && (
          <div className="ps2-loading"><span className="ps2-spinner" aria-hidden="true" />Loading guests…</div>
        )}
        {loadError && <p className="ps2-error">{loadError}</p>}

        {!loading && !loadError && (
          <>
            {pending.length > 0 && (
              <>
                <div className="ps2-guest-attention" data-testid="guests-attention-banner">
                  {pending.length} request{pending.length === 1 ? "" : "s"} need your approval — enter the code each
                  guest received to let them in.
                </div>
                {pending.map((request) => {
                  const otp = otpInputs[request.id] ?? "";
                  const state = actionState[request.id] ?? { busy: false, error: null };
                  return (
                    <div key={request.id} className="ps2-guest-card" data-testid={`guests-pending-card-${request.id}`}>
                      <div className="ps2-guest-card-head">
                        <span className="ps2-guest-email">{request.guest.email}</span>
                        <span className="ps2-guest-meta">
                          {request.ipAddress ? `IP ${request.ipAddress} · ` : ""}
                          {timeAgo(request.createdAt)}
                        </span>
                        <div className="ps2-guest-actions">
                          <input
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="6-digit code"
                            className="ps2-otp-input"
                            value={otp}
                            onChange={(e) => setOtpInputs((prev) => ({ ...prev, [request.id]: e.target.value.replace(/\D/g, "") }))}
                            data-testid={`guests-otp-input-${request.id}`}
                          />
                          <button type="button" className="ps2-btn-accent" disabled={state.busy} onClick={() => handleApprove(request.id)} data-testid={`guests-approve-button-${request.id}`}>Approve</button>
                          <button type="button" className="ps2-btn-ghost" disabled={state.busy} onClick={() => handleDeny(request.id)} data-testid={`guests-deny-button-${request.id}`}>Deny</button>
                        </div>
                      </div>
                      {request.multipleDevicesDetected && (
                        <p className="ps2-guest-warn" data-testid={`guests-multidevice-warning-${request.id}`}>
                          ⚠ This invite link was opened from {request.distinctDeviceCount} different devices/networks before
                          being resolved — possibly forwarded. Review before approving.
                        </p>
                      )}
                      {state.error && <p className="ps2-inline-error">{state.error}</p>}
                    </div>
                  );
                })}
              </>
            )}

            <div className="ps2-section-label">Active &amp; past guests</div>
            {guests.length === 0 ? (
              <p className="ps2-modal-sub">No guests yet — create a link above to invite one.</p>
            ) : (
              guests.map((guest) => {
                const revoke = revokeState[guest.id] ?? { busy: false, error: null };
                const canRevoke = guest.status !== "revoked";
                const canChangePermission = guest.status !== "revoked" && guest.permissionLevel != null;
                return (
                  <div key={guest.id} className={`ps2-guest-card${guest.status === "revoked" ? " ps2-guest-revoked" : ""}`} data-testid={`guests-roster-row-${guest.id}`}>
                    <div className="ps2-guest-card-head">
                      <span className="ps2-guest-email">{guest.email}</span>
                      <span className={`ps2-status-pill ${guest.status}`}>{guest.status}</span>
                      <span className="ps2-guest-meta">
                        {guest.lastAccessAt ? `last seen ${timeAgo(guest.lastAccessAt)}` : "not seen yet"}
                      </span>
                      <div className="ps2-guest-actions">
                        {canChangePermission && (
                          <select
                            className="ps2-select"
                            value={guest.permissionLevel ?? ""}
                            disabled={permissionBusy[guest.id]}
                            onChange={(e) => handleChangePermission(guest.id, e.target.value as PermissionLevel)}
                            data-testid={`guests-permission-select-${guest.id}`}
                          >
                            {PERMISSION_LEVELS.map((level) => (
                              <option key={level} value={level}>{level}</option>
                            ))}
                          </select>
                        )}
                        {guest.status !== "revoked" && guest.folders.length > 0 && (
                          <button type="button" className="ps2-btn-ghost" onClick={() => openGuestPreview(guest)} data-testid={`guests-preview-button-${guest.id}`}>
                            See what they see
                          </button>
                        )}
                        {canRevoke && (
                          <button type="button" className="ps2-btn-ghost" disabled={revoke.busy} onClick={() => handleRevoke(guest.id)} data-testid={`guests-revoke-button-${guest.id}`}>Revoke</button>
                        )}
                      </div>
                    </div>
                    {revoke.error && <p className="ps2-inline-error">{revoke.error}</p>}
                    {guest.status !== "revoked" && (
                      <div className="ps2-chip-list">
                        {guest.folders.length === 0 ? (
                          <span className="ps2-guest-meta">no folders</span>
                        ) : (
                          guest.folders.map((folder) => {
                            const key = `${guest.id}:${folder.id}`;
                            return (
                              <span key={folder.id} className="ps2-folder-chip">
                                {folder.name}
                                <button
                                  type="button"
                                  className="ps2-folder-chip-x"
                                  disabled={removeFolderBusy[key]}
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
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </>
        )}
      </main>

      {previewGuest && (
        <div className="ps2-modal-overlay" onClick={() => setPreviewGuest(null)}>
          <div className="ps2-modal ps2-guest-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ps2-guest-preview-head">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ps2-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
              Guest view · {previewGuest.permissionLevel === "view" ? "view only" : previewGuest.permissionLevel ?? "view only"}
            </div>
            <div style={{ padding: "18px 4px 4px" }}>
              <div className="ps2-modal-title" style={{ fontSize: 22, marginBottom: 4 }}>
                {previewGuest.folders[0]?.name ?? "Shared folder"}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ps2-muted)", marginBottom: 16 }}>
                Shared with {previewGuest.email}
              </div>
              {previewLoading && <p className="ps2-modal-sub">Loading…</p>}
              {previewError && <p className="ps2-inline-error">{previewError}</p>}
              {!previewLoading && !previewError && (
                <div className="ps2-guest-preview-grid">
                  {previewPhotos.map((p) => (
                    p.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={p.id} src={p.thumbnailUrl} alt={p.originalFilename} className="ps2-guest-preview-thumb" />
                    ) : (
                      <div key={p.id} className="ps2-dup-thumb-fallback">{p.originalFilename}</div>
                    )
                  ))}
                  {previewPhotos.length === 0 && <p className="ps2-modal-sub">This folder has no photos yet.</p>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Ps2Shell>
  );
}
