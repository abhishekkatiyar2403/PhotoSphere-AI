"use client";

// v2 Share & guests - synced to PhotoSphere.dc.html (Share screen, lines
// 918-1032, + "Guest view preview" modal, lines 1294-1322). One screen:
// "Create a link" card (folder checklist + guest email + permission/expiry +
// generate) followed by the "Active & past guests" roster with status pills,
// per-guest Send/Resend, permission select, Revoke/Remove and folder tag
// chips with × removal.
//
// Real API wiring preserved: guestsApi (create/list/revoke/updatePermission/
// removeFolder), foldersApi/collectionsApi for the checklist, and the OTP
// approval queue (accessRequestsApi) which the design's prototype does not
// model but which is the only way a guest request can ever be approved - it
// is kept (restyled to the design language) rather than removed.
//
// "Send to guest" / "Resend" have no backend email endpoint - they are a
// local mock fallback (same pattern as lib/v2/featureFlags.ts): the button
// flips to "Sent ✓"/"sent just now" and a toast confirms, no email is sent.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AccessRequestItem,
  accessRequestsApi,
  ApiError,
  collectionsApi,
  CreateGuestResponse,
  Folder,
  folderPhotosApi,
  foldersApi,
  GuestListItem,
  guestsApi,
  PermissionLevel,
} from "@/lib/api";
import { useToast } from "@/components/v2/ToastProviderV2";
import { useIsMobile } from "@/components/v2/useIsMobile";
import { usePs2User } from "@/components/v2/Ps2UserContext";

const EXPIRY_LABELS: Record<string, string> = { "1": "1 day", "7": "7 days", "30": "30 days", "": "never" };

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
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

const fieldStyle: React.CSSProperties = {
  background: "var(--ps2-panel2)",
  border: "1px solid var(--ps2-border)",
  borderRadius: 11,
  padding: "12px 14px",
  fontSize: 14,
  color: "var(--ps2-text)",
  fontFamily: "inherit",
  outline: "none",
};

const upLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ps2-muted)",
  letterSpacing: ".08em",
  textTransform: "uppercase",
};

function SendIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4Z" />
    </svg>
  );
}

// useSearchParams() must sit inside a Suspense boundary in the Next 14 App
// Router - same pattern as v2 Browse's ?folder= deep link. Used here so the
// photo viewer's Share button can land here with its folder pre-selected.
export default function ShareV2Page() {
  return (
    <Suspense fallback={null}>
      <ShareV2Inner />
    </Suspense>
  );
}

function ShareV2Inner() {
  const searchParams = useSearchParams();
  const prefillFolderId = searchParams.get("folder");
  const showToast = useToast();
  const isMobile = useIsMobile();
  const user = usePs2User();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [foldersError, setFoldersError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [guestEmail, setGuestEmail] = useState("");
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("view");
  const [expiresInDays, setExpiresInDays] = useState("7");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [freshLink, setFreshLink] = useState<(CreateGuestResponse & { email: string; permLabel: string; expiryLabel: string }) | null>(null);
  const [copied, setCopied] = useState(false);
  const [freshSent, setFreshSent] = useState(false);

  const [pending, setPending] = useState<AccessRequestItem[]>([]);
  const [guests, setGuests] = useState<GuestListItem[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [otpInputs, setOtpInputs] = useState<Record<string, string>>({});
  const [actionState, setActionState] = useState<Record<string, { busy: boolean; error: string | null }>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // Local "sent" mock (no email-send endpoint yet - see header comment).
  const [sentMap, setSentMap] = useState<Record<string, string>>({});
  // Revoked guests dismissed via "Remove" (no delete endpoint - local hide).
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  // "See what your guest sees" preview - the design opens it from the section
  // header, previewing the first checklist-selected folder (or the first
  // folder). Covers come from the real folderPhotosApi.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFolder, setPreviewFolder] = useState<Folder | null>(null);
  const [previewCovers, setPreviewCovers] = useState<string[]>([]);

  async function openGuestPreview() {
    const folder = folders.find((f) => selectedIds.has(f.id)) ?? folders[0] ?? null;
    setPreviewFolder(folder);
    setPreviewCovers([]);
    setPreviewOpen(true);
    if (!folder) return;
    try {
      const res = await folderPhotosApi.list(folder.id, { limit: 3, offset: 0 });
      setPreviewCovers(res.photos.map((p) => p.thumbnailUrl).filter((u): u is string => !!u).slice(0, 3));
    } catch {
      // Preview covers are decorative - stay empty on failure.
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setFoldersLoading(true);
      setFoldersError(null);
      try {
        const collectionsRes = await collectionsApi.list();
        if (cancelled) return;
        const defaultCollection = collectionsRes.collections.find((c) => c.isDefault) ?? collectionsRes.collections[0] ?? null;
        if (!defaultCollection) {
          setFolders([]);
          return;
        }
        const foldersRes = await foldersApi.list(defaultCollection.id);
        if (cancelled) return;
        setFolders(foldersRes.folders);
        if (prefillFolderId && foldersRes.folders.some((f) => f.id === prefillFolderId)) {
          setSelectedIds(new Set([prefillFolderId]));
        }
      } catch (err) {
        if (cancelled || isAuthError(err)) return;
        setFoldersError(err instanceof Error ? err.message : "Failed to load folders");
      } finally {
        if (!cancelled) setFoldersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRoster = useCallback(async () => {
    setRosterLoading(true);
    setRosterError(null);
    try {
      const [pendingRes, guestsRes] = await Promise.all([accessRequestsApi.list("pending"), guestsApi.list()]);
      setPending(pendingRes.requests);
      setGuests(guestsRes.guests);
    } catch (err) {
      if (isAuthError(err)) return;
      setRosterError(err instanceof Error ? err.message : "Failed to load guests");
    } finally {
      setRosterLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

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
  const canGenerate = selectedIds.size > 0 && guestEmail.trim().length > 0;

  async function generateInviteLink() {
    if (!canGenerate) {
      showToast("Pick at least one folder and enter a guest email.");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setCopied(false);
    setFreshSent(false);
    try {
      const email = guestEmail.trim();
      const res = await guestsApi.create({
        guestEmail: email,
        folderIds: [...selectedIds],
        permissionLevel,
        expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
      });
      setFreshLink({
        ...res,
        email,
        permLabel: permissionLevel === "view" ? "view only" : "view & download",
        expiryLabel: expiresInDays === "" ? "never" : `in ${EXPIRY_LABELS[expiresInDays]}`,
      });
      setSelectedIds(new Set());
      setGuestEmail("");
      loadRoster();
    } catch (err) {
      if (isAuthError(err)) return;
      setSubmitError(err instanceof Error ? err.message : "Failed to create share");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyFreshLink() {
    if (!freshLink) return;
    try {
      await navigator.clipboard.writeText(freshLink.inviteUrl);
    } catch {
      // Clipboard API unavailable - the link is still visible.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function sendFreshLink() {
    if (!freshLink) return;
    setFreshSent(true);
    setSentMap((prev) => ({ ...prev, [freshLink.guestId]: "just now" }));
    showToast(`Link sent to ${freshLink.email}.`);
  }

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
      await loadRoster();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Approval failed";
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: message } }));
      if (err instanceof ApiError && err.status === 403) await loadRoster();
    }
  }

  async function handleDeny(requestId: string) {
    setActionState((prev) => ({ ...prev, [requestId]: { busy: true, error: null } }));
    try {
      await accessRequestsApi.deny(requestId);
      setPending((prev) => prev.filter((r) => r.id !== requestId));
      await loadRoster();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Deny failed";
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: message } }));
    }
  }

  function handleSend(guest: GuestListItem) {
    setSentMap((prev) => ({ ...prev, [guest.id]: "just now" }));
    showToast(`Link sent to ${guest.email}`);
  }

  async function handleRevoke(guest: GuestListItem) {
    if (guest.status === "revoked" || guest.status === "expired") {
      setRemovedIds((prev) => new Set(prev).add(guest.id));
      return;
    }
    try {
      await guestsApi.revoke(guest.id);
      await loadRoster();
    } catch (err) {
      if (isAuthError(err)) return;
      setRowErrors((prev) => ({ ...prev, [guest.id]: err instanceof Error ? err.message : "Revoke failed" }));
    }
  }

  async function handleChangePermission(guest: GuestListItem, level: PermissionLevel) {
    try {
      await guestsApi.updatePermission(guest.id, level);
      await loadRoster();
    } catch (err) {
      if (isAuthError(err)) return;
      setRowErrors((prev) => ({ ...prev, [guest.id]: err instanceof Error ? err.message : "Couldn't change permission" }));
    }
  }

  async function handleRemoveFolder(guest: GuestListItem, folderId: string) {
    try {
      await guestsApi.removeFolder(guest.id, folderId);
      await loadRoster();
    } catch (err) {
      if (isAuthError(err)) return;
      setRowErrors((prev) => ({ ...prev, [guest.id]: err instanceof Error ? err.message : "Couldn't remove folder access" }));
    }
  }

  const visibleGuests = guests.filter((g) => !removedIds.has(g.id));

  return (
    <main style={{ padding: "38px 32px 60px", maxWidth: 1000, width: "100%", margin: "0 auto", position: "relative", zIndex: 1 }}>
      <style>{`
        .sgx-folder-row:hover{background:color-mix(in oklab, var(--ps2-accent) 8%, transparent)}
        .sgx-input:focus{border-color:var(--ps2-accent)}
        .sgx-generate:hover{transform:translateY(-2px)}
        .sgx-copy:hover{border-color:var(--ps2-accent)}
        .sgx-sheen:hover{transform:translateY(-2px);box-shadow:0 8px 22px color-mix(in oklab, var(--ps2-accent) 45%, transparent);background-position:-50% 0}
        .sgx-preview-btn:hover{color:var(--ps2-accent);border-color:var(--ps2-accent)}
        .sgx-guest-card:hover{border-color:var(--ps2-accent)}
        .sgx-send:hover{transform:translateY(-1px)}
        .sgx-revoke:hover{border-color:#e87f8f;color:#e87f8f}
        .sgx-tag-x:hover{color:#e87f8f}
        .sgx-modal-x:hover{color:var(--ps2-text)}
      `}</style>

      <h1 style={{ fontFamily: "var(--ps2-font-serif)", fontWeight: 400, fontSize: 36, margin: 0, animation: "ps2Up .6s both" }}>Share &amp; guests</h1>
      <div style={{ fontSize: 14, color: "var(--ps2-muted)", margin: "8px 0 28px", animation: "ps2Up .6s both .05s" }}>
        Guest links let anyone view (or download) a folder — no account needed.
      </div>

      <div
        style={{
          borderRadius: 18,
          background: "linear-gradient(120deg, color-mix(in oklab, var(--ps2-accent) 10%, var(--ps2-panel)), var(--ps2-panel) 65%)",
          border: "1px solid var(--ps2-border)",
          padding: 22,
          animation: "ps2In .6s both .1s",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Create a link</div>

        <div style={{ ...upLabelStyle, marginBottom: 8 }}>Folders to share</div>
        <div style={{ maxHeight: 190, overflowY: "auto", borderRadius: 12, border: "1px solid var(--ps2-border)", background: "var(--ps2-panel2)" }}>
          {foldersLoading && <div style={{ padding: "11px 14px", fontSize: 13.5, color: "var(--ps2-muted)" }}>Loading folders…</div>}
          {foldersError && <div style={{ padding: "11px 14px", fontSize: 13.5, color: "#e87f8f" }}>{foldersError}</div>}
          {!foldersLoading && !foldersError && folders.length === 0 && (
            <div style={{ padding: "11px 14px", fontSize: 13.5, color: "var(--ps2-muted)" }}>No folders yet — organize some photos first.</div>
          )}
          {folders.map((folder) => {
            const checked = selectedIds.has(folder.id);
            return (
              <div
                key={folder.id}
                className="sgx-folder-row"
                onClick={() => toggleFolder(folder.id)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", cursor: "pointer", borderBottom: "1px solid var(--ps2-border)", transition: "background .2s" }}
              >
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 5,
                    border: `1.5px solid ${checked ? "var(--ps2-accent)" : "var(--ps2-border)"}`,
                    background: checked ? "var(--ps2-accent)" : "transparent",
                    display: "grid",
                    placeItems: "center",
                    flex: "none",
                  }}
                >
                  {checked && (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#141118" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </div>
                <span style={{ flex: 1, fontSize: 13.5 }}>{folder.name}</span>
                <span style={{ fontSize: 12, color: "var(--ps2-muted)" }}>{folder.photoCount}</span>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 8 }}>
          {selectedFolders.length} folder{selectedFolders.length === 1 ? "" : "s"} · {tallyPhotoCount} photo{tallyPhotoCount === 1 ? "" : "s"} selected
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 16 }}>
          <label style={upLabelStyle}>Guest email</label>
          <input type="email" className="sgx-input" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} placeholder="client@example.com" style={fieldStyle} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginTop: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={upLabelStyle}>Permission</label>
            <select value={permissionLevel} onChange={(e) => setPermissionLevel(e.target.value as PermissionLevel)} style={{ ...fieldStyle, cursor: "pointer" }}>
              <option value="view">View only</option>
              <option value="download">View &amp; download</option>
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={upLabelStyle}>Link expires</label>
            <select value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} style={{ ...fieldStyle, cursor: "pointer" }}>
              <option value="1">In 1 day</option>
              <option value="7">In 7 days</option>
              <option value="30">In 30 days</option>
              <option value="">Never</option>
            </select>
          </div>
        </div>

        {submitError && <div style={{ marginTop: 12, fontSize: 12.5, color: "#e87f8f" }}>{submitError}</div>}

        <button
          type="button"
          className={canGenerate ? "sgx-generate" : undefined}
          onClick={generateInviteLink}
          style={{
            marginTop: 18,
            borderRadius: 11,
            border: "none",
            background: canGenerate ? "var(--ps2-accent)" : "color-mix(in oklab, var(--ps2-text) 12%, transparent)",
            color: "#141118",
            padding: "13px 20px",
            fontSize: 14,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: canGenerate ? "pointer" : "default",
            transition: "transform .2s",
          }}
        >
          Generate invite link
        </button>

        {freshLink && (
          <div
            style={{
              marginTop: 18,
              borderRadius: 14,
              background: "var(--ps2-panel2)",
              border: "1px solid color-mix(in oklab, var(--ps2-accent) 35%, var(--ps2-border))",
              padding: 16,
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
              animation: "ps2Up .35s cubic-bezier(.2,.8,.2,1) both",
            }}
          >
            <div style={{ width: 38, height: 38, flex: "none", borderRadius: 10, background: "color-mix(in oklab, var(--ps2-accent) 18%, transparent)", display: "grid", placeItems: "center", color: "var(--ps2-accent)" }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>Link ready for {freshLink.email}</div>
              <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {freshLink.inviteUrl.replace(/^https?:\/\//, "")} · {freshLink.permLabel} · expires {freshLink.expiryLabel}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flex: "none" }}>
              <button
                type="button"
                className="sgx-copy"
                onClick={copyFreshLink}
                style={{ borderRadius: 9, border: "1px solid var(--ps2-border)", background: "transparent", color: "var(--ps2-text)", padding: "9px 14px", fontSize: 12.5, fontFamily: "inherit", cursor: "pointer", transition: "border-color .2s" }}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
              <button
                type="button"
                className="sgx-sheen"
                onClick={sendFreshLink}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  borderRadius: 9,
                  border: "none",
                  background: "linear-gradient(120deg, var(--ps2-accent) 35%, color-mix(in oklab, white 55%, var(--ps2-accent)) 50%, var(--ps2-accent) 65%)",
                  backgroundSize: "220% 100%",
                  backgroundPosition: "150% 0",
                  color: "#141118",
                  padding: "9px 16px",
                  fontSize: 12.5,
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  transition: "transform .2s, box-shadow .2s, background-position .8s ease",
                }}
              >
                <SendIcon />
                {freshSent ? "Sent ✓" : "Send to guest"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* OTP approval queue - real backend requirement (accessRequestsApi),
          not present in the prototype; kept so guest requests can be approved. */}
      {pending.length > 0 && (
        <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {pending.length} request{pending.length === 1 ? "" : "s"} need your approval — enter the code your guest received.
          </div>
          {pending.map((request) => {
            const otp = otpInputs[request.id] ?? "";
            const state = actionState[request.id] ?? { busy: false, error: null };
            return (
              <div key={request.id} style={{ borderRadius: 15, background: "var(--ps2-panel)", border: "1px solid color-mix(in oklab, var(--ps2-accent) 35%, var(--ps2-border))", padding: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{request.guest.email}</div>
                <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 2 }}>
                  {request.ipAddress ? `IP ${request.ipAddress} · ` : ""}
                  {timeAgo(request.createdAt)}
                </div>
                {request.multipleDevicesDetected && (
                  <div style={{ fontSize: 12, color: "#e8a15c", marginTop: 8 }}>
                    ⚠ This invite link was opened from {request.distinctDeviceCount} different devices/networks before this request was resolved.
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 11, flexWrap: "wrap" }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6-digit code"
                    className="sgx-input"
                    value={otp}
                    onChange={(e) => setOtpInputs((prev) => ({ ...prev, [request.id]: e.target.value.replace(/\D/g, "") }))}
                    style={{ ...fieldStyle, padding: "8px 12px", fontSize: 12.5, width: 110, letterSpacing: ".12em" }}
                  />
                  <button
                    type="button"
                    className="sgx-send"
                    disabled={state.busy}
                    onClick={() => handleApprove(request.id)}
                    style={{ borderRadius: 9, border: "none", background: "var(--ps2-accent)", color: "#141118", padding: "8px 14px", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", transition: "transform .2s" }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="sgx-revoke"
                    disabled={state.busy}
                    onClick={() => handleDeny(request.id)}
                    style={{ borderRadius: 9, border: "1px solid var(--ps2-border)", background: "transparent", color: "var(--ps2-text)", padding: "8px 14px", fontSize: 12.5, fontFamily: "inherit", cursor: "pointer", transition: "border-color .2s,color .2s" }}
                  >
                    Deny
                  </button>
                </div>
                {state.error && <div style={{ marginTop: 8, fontSize: 12, color: "#e87f8f" }}>{state.error}</div>}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 34, animation: "ps2Up .6s both .2s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Active &amp; past guests</div>
          <button
            type="button"
            className="sgx-preview-btn"
            onClick={openGuestPreview}
            style={{ display: "flex", alignItems: "center", gap: 7, borderRadius: 9, border: "1px solid var(--ps2-border)", background: "transparent", color: "var(--ps2-muted)", padding: "8px 13px", fontSize: 12, fontFamily: "inherit", cursor: "pointer", transition: "color .2s, border-color .2s" }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            See what your guest sees
          </button>
        </div>
        {rosterLoading && <div style={{ fontSize: 13.5, color: "var(--ps2-muted)" }}>Loading…</div>}
        {rosterError && <div style={{ fontSize: 13.5, color: "#e87f8f" }}>{rosterError}</div>}
        {!rosterLoading && !rosterError && visibleGuests.length === 0 && (
          <div style={{ fontSize: 13.5, color: "var(--ps2-muted)" }}>No guests yet — create a share to invite one.</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!rosterLoading &&
            visibleGuests.map((guest) => {
              const revokedLike = guest.status === "revoked" || guest.status === "expired";
              const statusLabel = guest.status === "pending" ? "Pending" : guest.status === "active" ? "Active" : guest.status === "expired" ? "Expired" : "Revoked";
              const statusBg =
                guest.status === "pending"
                  ? "color-mix(in oklab, #e8a15c 22%, transparent)"
                  : guest.status === "active"
                    ? "color-mix(in oklab, #7fd8a8 22%, transparent)"
                    : "color-mix(in oklab, var(--ps2-text) 10%, transparent)";
              const statusFg = guest.status === "pending" ? "#e8a15c" : guest.status === "active" ? "#7fd8a8" : "var(--ps2-muted)";
              const sent = sentMap[guest.id];
              const metaLine = sent ? `sent ${sent}` : guest.lastAccessAt ? `last seen ${timeAgo(guest.lastAccessAt)}` : `invited ${timeAgo(guest.createdAt)}`;
              const permValue = guest.permissionLevel === "view" ? "view" : "download";
              return (
                <div key={guest.id} className="sgx-guest-card" style={{ borderRadius: 15, background: "var(--ps2-panel)", border: "1px solid var(--ps2-border)", padding: 16, transition: "border-color .2s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{guest.email}</div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 99, background: statusBg, color: statusFg }}>{statusLabel}</span>
                    <span style={{ fontSize: 12, color: "var(--ps2-muted)" }}>{metaLine}</span>
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                      {!revokedLike && (
                        <button
                          type="button"
                          className="sgx-send"
                          onClick={() => handleSend(guest)}
                          style={{ display: "flex", alignItems: "center", gap: 7, borderRadius: 9, border: "none", background: "var(--ps2-accent)", color: "#141118", padding: "8px 14px", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", transition: "transform .2s" }}
                        >
                          <SendIcon />
                          {sent ? "Resend" : "Send"}
                        </button>
                      )}
                      <select
                        value={permValue}
                        onChange={(e) => handleChangePermission(guest, e.target.value as PermissionLevel)}
                        disabled={revokedLike}
                        style={{ background: "var(--ps2-panel2)", border: "1px solid var(--ps2-border)", borderRadius: 9, padding: "8px 10px", fontSize: 12.5, color: "var(--ps2-text)", fontFamily: "inherit", cursor: "pointer" }}
                      >
                        <option value="view">view</option>
                        <option value="download">download</option>
                      </select>
                      <button
                        type="button"
                        className="sgx-revoke"
                        onClick={() => handleRevoke(guest)}
                        style={{ borderRadius: 9, border: "1px solid var(--ps2-border)", background: "transparent", color: "var(--ps2-text)", padding: "8px 14px", fontSize: 12.5, fontFamily: "inherit", cursor: "pointer", transition: "border-color .2s,color .2s" }}
                      >
                        {revokedLike ? "Remove" : "Revoke"}
                      </button>
                    </div>
                  </div>
                  {rowErrors[guest.id] && <div style={{ marginTop: 8, fontSize: 12, color: "#e87f8f" }}>{rowErrors[guest.id]}</div>}
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 11 }}>
                    {guest.folders.map((folder) => (
                      <span key={folder.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "4px 6px 4px 11px", borderRadius: 99, background: "var(--ps2-panel2)", border: "1px solid var(--ps2-border)", color: "var(--ps2-muted)" }}>
                        {folder.name}
                        <button
                          type="button"
                          className="sgx-tag-x"
                          onClick={() => handleRemoveFolder(guest, folder.id)}
                          style={{ border: "none", background: "transparent", color: "var(--ps2-muted)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 4px", borderRadius: "50%", transition: "color .2s" }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {previewOpen && (
        <div
          onClick={() => setPreviewOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 460, background: "rgba(5,6,10,.65)", backdropFilter: "blur(10px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, animation: "ps2In .2s both" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 540, maxWidth: "94vw", borderRadius: 20, background: "var(--ps2-panel)", border: "1px solid var(--ps2-border)", boxShadow: "var(--ps2-shadow)", overflow: "hidden", animation: "ps2Up .25s cubic-bezier(.2,.8,.2,1) both" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 18px", background: "color-mix(in oklab, var(--ps2-accent) 10%, var(--ps2-panel2))", borderBottom: "1px solid var(--ps2-border)" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ps2-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span style={{ fontSize: 12.5, color: "var(--ps2-text)" }}>Guest view · view-only · no account needed</span>
              <button
                type="button"
                className="sgx-modal-x"
                onClick={() => setPreviewOpen(false)}
                style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--ps2-muted)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 4 }}
              >
                ×
              </button>
            </div>
            <div style={{ padding: 22 }}>
              <div style={{ fontFamily: "var(--ps2-font-serif)", fontSize: 26 }}>{previewFolder?.name ?? "Northern Coastlines"}</div>
              <div style={{ fontSize: 12.5, color: "var(--ps2-muted)", margin: "4px 0 16px" }}>
                Shared by {user.name} · {previewFolder?.photoCount ?? 0} photo{(previewFolder?.photoCount ?? 0) === 1 ? "" : "s"} · link expires in 7 days
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                {previewCovers.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={src} alt="" style={{ width: "100%", aspectRatio: "1", borderRadius: 10, objectFit: "cover" }} />
                ))}
                {previewCovers.length === 0 &&
                  Array.from({ length: 3 }).map((_, i) => <div key={i} style={{ width: "100%", aspectRatio: "1", borderRadius: 10, background: "var(--ps2-tile)" }} />)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: 11.5, color: "var(--ps2-muted)" }}>
                <svg width="16" height="16" viewBox="0 0 36 36">
                  <defs>
                    <linearGradient id="sgxLogoG" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="var(--ps2-accent)" />
                      <stop offset="100%" stopColor="var(--ps2-purple)" />
                    </linearGradient>
                  </defs>
                  <circle cx="18" cy="16" r="9.5" fill="url(#sgxLogoG)" />
                  <path d="M4 20 A14 5.5 0 0 0 32 20" stroke="url(#sgxLogoG)" strokeWidth="1.8" fill="none" strokeLinecap="round" transform="rotate(-14 18 20)" />
                </svg>
                Shared via PhotoSphere — downloads disabled by the owner
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
