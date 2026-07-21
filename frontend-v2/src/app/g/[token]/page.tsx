"use client";

// Guest shared-link view - synced to PhotoSphere.dc.html's guest view
// (lines 1294-1322): the PhotoSphere v2 dark theme, a "Guest view ·
// view-only · no account needed" accent header strip, the folder name in
// Instrument Serif, a "Shared … · N photos" meta line, a 3-column square
// photo grid, and the "Shared via PhotoSphere — downloads disabled by the
// owner" logo footer.
//
// The full guest journey and its API wiring are unchanged from before the
// redesign: an internal state machine ('probing' | 'landing' | 'waiting' |
// 'unlocked') all on THIS page - no navigation between states.
//  - probing: ONE guest-scoped call (GET /api/guest/folders) to detect an
//    existing live guest session; 200 -> 'unlocked', 401 -> 'landing'.
//  - landing: a decorative locked-preview grid + "Request access" ->
//    POST /api/invites/:token/request. HARD PRIVACY CONSTRAINT: the locked
//    grid is 100% decorative - never a real thumbnail or pre-signed URL; no
//    guest.* API call of any kind happens before a session exists.
//  - waiting: SSE connection to GET /api/invites/requests/:requestId/stream
//    (server pushes the instant the owner approves/denies, or the OTP
//    expires/auto-denies — see routes/accessRequests.ts's publishEvent
//    calls) — no polling. The approved status response (fetched on every
//    push, via the same GET /status call as before) is what sets the
//    httpOnly guest-session cookie.
//  - unlocked: fetch the REAL scoped data via guestPortalApi, then keep an
//    SSE connection to GET /api/guest/stream open so an owner's live
//    permission change/revoke shows up without the guest ever refreshing —
//    also no polling. See lib/sse.ts for why this is built on Redis pub/sub
//    (correct at N horizontally-scaled API instances, not just single-box).

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  ApiError,
  API_BASE_URL,
  downloadAllApi,
  GuestFolder,
  FolderPhoto,
  guestPortalApi,
  GuestPhotoDetail,
  invitesApi,
} from "@/lib/api";
import { Ps2Logo } from "@/components/v2/Ps2Logo";

const PREVIEW_TILE_COUNT = 6; // a plausible tile count - NOT derived from any fetch

type PortalState = "probing" | "landing" | "waiting" | "unlocked";
type ResolvedOutcome = "denied" | "expired" | "revoked" | null;

const PAGE_LIMIT = 12;

const accentBtnStyle: React.CSSProperties = {
  borderRadius: 11,
  border: "none",
  background: "var(--ps2-accent)",
  color: "#141118",
  padding: "12px 20px",
  fontSize: 13.5,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "transform .2s",
};

const outlineBtnStyle: React.CSSProperties = {
  borderRadius: 9,
  border: "1px solid var(--ps2-border)",
  background: "transparent",
  color: "var(--ps2-text)",
  padding: "9px 14px",
  fontSize: 12.5,
  fontFamily: "inherit",
  cursor: "pointer",
  transition: "border-color .2s",
};

export default function GuestPortalPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [state, setState] = useState<PortalState>("probing");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [resolvedOutcome, setResolvedOutcome] = useState<ResolvedOutcome>(null);
  const [landingError, setLandingError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  // ---- Unlocked-state data (only ever fetched once state === 'unlocked') ----
  const [folders, setFolders] = useState<GuestFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  const [photos, setPhotos] = useState<FolderPhoto[]>([]);
  const [photosTotal, setPhotosTotal] = useState(0);
  const [photosOffset, setPhotosOffset] = useState(0);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosError, setPhotosError] = useState<string | null>(null);

  const [viewerPhotoId, setViewerPhotoId] = useState<string | null>(null);
  const [viewerDetail, setViewerDetail] = useState<GuestPhotoDetail | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });

  // Multi-select "Download selected" (works at `download` level). Reset when
  // the page/folder changes.
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [bulkDownloadBusy, setBulkDownloadBusy] = useState(false);
  const [bulkDownloadError, setBulkDownloadError] = useState<string | null>(null);

  const gridRequestIdRef = useRef(0);

  // ---- Load-time session probe ----
  useEffect(() => {
    let cancelled = false;
    guestPortalApi
      .folders()
      .then(() => {
        if (cancelled) return;
        setState("unlocked");
      })
      .catch(() => {
        if (cancelled) return;
        setState("landing");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Landing: request access ----
  async function handleRequestAccess() {
    setRequesting(true);
    setLandingError(null);
    try {
      const res = await invitesApi.request(token);
      if (res.status === "already_approved") {
        setState("unlocked");
        return;
      }
      setRequestId(res.requestId);
      setState("waiting");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.status === 429
            ? "Too many requests — please wait a bit and try again."
            : err.status === 404
              ? "This invite link has already been used or is no longer active. Ask the owner to share a new link."
              : "This invite link is invalid or has expired."
          : "Something went wrong. Please try again.";
      setLandingError(message);
    } finally {
      setRequesting(false);
    }
  }

  // ---- Waiting: check status on real-time push, not a poll ----
  const pollStatus = useCallback(async (id: string) => {
    try {
      const res = await invitesApi.status(id);
      if (res.status === "approved" || res.status === "already_approved") {
        setState("unlocked");
        return;
      }
      if (res.status === "denied" || res.status === "expired") {
        setResolvedOutcome(res.status);
        setState("landing");
        return;
      }
    } catch {
      // Transient network/429 - the next SSE push (or reconnect) tries again.
    }
  }, []);

  useEffect(() => {
    if (state !== "waiting" || !requestId) return;
    const source = new EventSource(`${API_BASE_URL}/api/invites/requests/${requestId}/stream`, {
      withCredentials: true,
    });
    // onopen covers both the very first connect (no push has happened yet,
    // so check the current status directly) and every reconnect (in case an
    // event was published while the connection was briefly down) — treating
    // "connected" itself as "go check the authoritative state now" means no
    // event can ever be silently missed, unlike relying on message payloads
    // alone.
    source.onopen = () => pollStatus(requestId);
    source.onmessage = () => pollStatus(requestId);
    return () => source.close();
  }, [state, requestId, pollStatus]);

  function handleRequestAgain() {
    setResolvedOutcome(null);
    setRequestId(null);
    setLandingError(null);
  }

  // ---- Unlocked: fetch real scoped data, then keep it live via SSE ----
  // An open EventSource to GET /api/guest/stream replaces the old
  // fixed-interval refetch: a permission change (view -> download) or a
  // revoke made by the owner pushes a message the instant it happens (see
  // routes/guests.ts's publishEvent calls), which just triggers a normal
  // refetch of GET /folders here rather than trying to interpret each event
  // type client-side — a fresh fetch is cheap and always exactly correct.
  // A plain data update handles a permission change (canDownload/
  // canDownloadAll below derive from the new folders list automatically);
  // a 401 (owner fully revoked this guest) falls all the way back to
  // 'landing' — the same locked preview shown before the request was ever
  // approved — never leaving a stale unlocked view on screen.
  useEffect(() => {
    if (state !== "unlocked") return;
    let cancelled = false;

    async function refreshFolders(isFirstLoad: boolean) {
      if (isFirstLoad) setFoldersLoading(true);
      try {
        const res = await guestPortalApi.folders();
        if (cancelled) return;
        setFolders(res.folders);
        setFoldersError(null);
        setSelectedFolderId((prev) => (prev && res.folders.some((f) => f.id === prev) ? prev : (res.folders[0]?.id ?? null)));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          // Owner revoked this guest entirely - drop back to the locked
          // landing state, exactly like a guest who was never approved.
          source.close();
          setFolders([]);
          setSelectedFolderId(null);
          setPhotos([]);
          setResolvedOutcome("revoked");
          setState("landing");
          return;
        }
        if (isFirstLoad) setFoldersError(err instanceof Error ? err.message : "Failed to load your shared folders");
        // A transient error on a background refresh keeps the last-known
        // folders on screen rather than clearing a working view.
      } finally {
        if (!cancelled && isFirstLoad) setFoldersLoading(false);
      }
    }

    const source = new EventSource(`${API_BASE_URL}/api/guest/stream`, { withCredentials: true });
    // onopen fires on the initial connect AND on every reconnect - treating
    // "(re)connected" itself as "refetch now" means a change published
    // during a brief disconnect is never silently missed.
    source.onopen = () => refreshFolders(false);
    source.onmessage = () => refreshFolders(false);

    refreshFolders(true);
    return () => {
      cancelled = true;
      source.close();
    };
  }, [state]);

  const loadFolderPhotos = useCallback(async (folderId: string, offset: number) => {
    const reqId = ++gridRequestIdRef.current;
    setPhotosLoading(true);
    setPhotosError(null);
    try {
      const res = await guestPortalApi.folderPhotos(folderId, { limit: PAGE_LIMIT, offset });
      if (reqId !== gridRequestIdRef.current) return;
      setPhotos(res.photos);
      setPhotosTotal(res.total);
      setPhotosOffset(res.offset);
      setSelectedPhotoIds(new Set());
      setBulkDownloadError(null);
    } catch (err) {
      if (reqId !== gridRequestIdRef.current) return;
      setPhotosError(err instanceof Error ? err.message : "Failed to load photos");
    } finally {
      if (reqId === gridRequestIdRef.current) setPhotosLoading(false);
    }
  }, []);

  useEffect(() => {
    if (state !== "unlocked" || !selectedFolderId) return;
    loadFolderPhotos(selectedFolderId, 0);
  }, [state, selectedFolderId, loadFolderPhotos]);

  const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null;
  const canDownload = selectedFolder ? selectedFolder.permissionLevel !== "view" : false;
  // The bulk "Download all" is shown ONLY at exactly `download_all` - a
  // credentialed top-level navigation to the guest zip-stream endpoint.
  const canDownloadAll = selectedFolder?.permissionLevel === "download_all";
  const permLabel = state !== "unlocked" || !selectedFolder || selectedFolder.permissionLevel === "view" ? "view-only" : "view & download";

  // ---- Photo detail viewer ----
  useEffect(() => {
    if (!viewerPhotoId) {
      setViewerDetail(null);
      return;
    }
    let cancelled = false;
    setViewerLoading(true);
    setViewerError(null);
    setDownloadState({ busy: false, error: null });
    guestPortalApi
      .photo(viewerPhotoId)
      .then((res) => {
        if (cancelled) return;
        setViewerDetail(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setViewerError(err instanceof Error ? err.message : "Failed to load photo");
      })
      .finally(() => {
        if (!cancelled) setViewerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewerPhotoId]);

  async function handleDownload(photoId: string) {
    setDownloadState({ busy: true, error: null });
    try {
      const res = await guestPortalApi.download(photoId);
      window.open(res.download.url, "_blank", "noopener,noreferrer");
      setDownloadState({ busy: false, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      setDownloadState({ busy: false, error: message });
    }
  }

  function toggleSelectPhoto(photoId: string) {
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  async function handleBulkDownload() {
    const ids = Array.from(selectedPhotoIds);
    if (ids.length === 0) return;
    setBulkDownloadBusy(true);
    setBulkDownloadError(null);
    try {
      await guestPortalApi.downloadMany(ids);
    } catch (err) {
      setBulkDownloadError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBulkDownloadBusy(false);
    }
  }

  function handlePrevPage() {
    if (!selectedFolderId || photosOffset === 0) return;
    loadFolderPhotos(selectedFolderId, Math.max(0, photosOffset - PAGE_LIMIT));
  }

  function handleNextPage() {
    if (!selectedFolderId || photosOffset + PAGE_LIMIT >= photosTotal) return;
    loadFolderPhotos(selectedFolderId, photosOffset + PAGE_LIMIT);
  }

  return (
    <div className="ps2" data-theme="dark" style={{ minHeight: "100vh", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "48px 20px 60px" }}>
      <style>{`
        .ggx-cta:hover{transform:translateY(-2px)}
        .ggx-outline:hover{border-color:var(--ps2-accent)}
        .ggx-chip:hover{border-color:var(--ps2-accent)}
        .ggx-thumb:hover img{transform:scale(1.04)}
      `}</style>

      <main
        style={{
          width: 540,
          maxWidth: "94vw",
          borderRadius: 20,
          background: "var(--ps2-panel)",
          border: "1px solid var(--ps2-border)",
          boxShadow: "var(--ps2-shadow)",
          overflow: "hidden",
          animation: "ps2Up .5s cubic-bezier(.2,.8,.2,1) both",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 18px", background: "color-mix(in oklab, var(--ps2-accent) 10%, var(--ps2-panel2))", borderBottom: "1px solid var(--ps2-border)" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ps2-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span style={{ fontSize: 12.5, color: "var(--ps2-text)" }}>Guest view · {permLabel} · no account needed</span>
        </div>

        <div style={{ padding: 22 }}>
          {state !== "unlocked" && (
            <>
              <div style={{ fontFamily: "var(--ps2-font-serif)", fontSize: 26 }}>You&apos;ve been invited to view some photos</div>
              <div style={{ fontSize: 12.5, color: "var(--ps2-muted)", margin: "4px 0 16px" }}>
                The owner approves your visit with a one-time code — no account or password needed.
              </div>

              {/* Decorative locked preview - never real data (privacy constraint). */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }} data-testid="portal-locked-grid">
                {Array.from({ length: PREVIEW_TILE_COUNT }).map((_, i) => (
                  <div
                    key={i}
                    data-testid="portal-locked-tile"
                    style={{ width: "100%", aspectRatio: "1", borderRadius: 10, background: "var(--ps2-tile)", display: "grid", placeItems: "center", color: "var(--ps2-muted)" }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 18 }} data-testid="portal-status-bar">
                {state === "probing" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }} data-testid="portal-probing">
                    <div
                      aria-hidden="true"
                      style={{ width: 22, height: 22, flex: "none", borderRadius: "50%", border: "2px solid var(--ps2-border)", borderTopColor: "var(--ps2-accent)", animation: "ps2Spin .9s linear infinite" }}
                    />
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>Loading…</div>
                      <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 2 }}>Checking whether you already have access to these photos.</div>
                    </div>
                  </div>
                )}

                {state === "landing" && (
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Ask for access to these photos</div>
                    <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 2 }}>
                      The owner approves with a one-time code — no account or password needed for you. Click below to send a request.
                    </div>
                    {resolvedOutcome && (
                      <div style={{ fontSize: 12.5, color: "#e87f8f", marginTop: 10 }} data-testid="portal-resolved-message">
                        {resolvedOutcome === "denied"
                          ? "Your request was denied."
                          : resolvedOutcome === "revoked"
                            ? "The owner has revoked your access to these photos."
                            : "Your request expired before it was approved."}
                      </div>
                    )}
                    {landingError && <div style={{ fontSize: 12.5, color: "#e87f8f", marginTop: 10 }}>{landingError}</div>}
                    <button
                      type="button"
                      className="ggx-cta"
                      disabled={requesting}
                      onClick={resolvedOutcome ? handleRequestAgain : handleRequestAccess}
                      data-testid="portal-request-access-button"
                      style={{ ...accentBtnStyle, marginTop: 14 }}
                    >
                      {resolvedOutcome ? "Request again" : requesting ? "Requesting…" : "Request access"}
                    </button>
                  </div>
                )}

                {state === "waiting" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }} data-testid="portal-waiting">
                    <div
                      aria-hidden="true"
                      style={{ width: 22, height: 22, flex: "none", borderRadius: "50%", border: "2px solid var(--ps2-border)", borderTopColor: "var(--ps2-accent)", animation: "ps2Spin .9s linear infinite" }}
                    />
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>Waiting for owner approval…</div>
                      <div style={{ fontSize: 12, color: "var(--ps2-muted)", marginTop: 2 }}>This checks automatically. The page unlocks the moment you&apos;re approved.</div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {state === "unlocked" && (
            <div data-testid="portal-unlocked">
              {foldersLoading && <div style={{ fontSize: 13.5, color: "var(--ps2-muted)" }}>Loading your shared folders…</div>}
              {foldersError && <div style={{ fontSize: 13.5, color: "#e87f8f" }}>{foldersError}</div>}
              {!foldersLoading && !foldersError && folders.length === 0 && (
                <div style={{ fontSize: 13.5, color: "var(--ps2-muted)" }}>No folders are currently shared with you.</div>
              )}

              {!foldersLoading && folders.length > 0 && (
                <>
                  {folders.length > 1 && (
                    <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 16 }} data-testid="portal-folder-list">
                      {folders.map((folder) => {
                        const active = folder.id === selectedFolderId;
                        return (
                          <button
                            key={folder.id}
                            type="button"
                            className="ggx-chip"
                            data-testid={`portal-folder-chip-${folder.name}`}
                            onClick={() => {
                              setSelectedFolderId(folder.id);
                              setPhotosOffset(0);
                            }}
                            style={{
                              fontSize: 11.5,
                              padding: "5px 12px",
                              borderRadius: 99,
                              background: active ? "var(--ps2-accent)" : "var(--ps2-panel2)",
                              border: `1px solid ${active ? "var(--ps2-accent)" : "var(--ps2-border)"}`,
                              color: active ? "#141118" : "var(--ps2-muted)",
                              fontFamily: "inherit",
                              cursor: "pointer",
                              transition: "border-color .2s",
                            }}
                          >
                            {folder.name} ({folder.photoCount})
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {selectedFolder && (
                    <>
                      <div style={{ fontFamily: "var(--ps2-font-serif)", fontSize: 26 }}>{selectedFolder.name}</div>
                      <div style={{ fontSize: 12.5, color: "var(--ps2-muted)", margin: "4px 0 16px" }}>
                        Shared with you · {selectedFolder.photoCount} photo{selectedFolder.photoCount === 1 ? "" : "s"}
                      </div>
                    </>
                  )}

                  {(canDownload || canDownloadAll) && photos.length > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }} data-testid="portal-select-toolbar">
                      {canDownloadAll && selectedFolder && selectedFolder.photoCount > 0 && (
                        <button
                          type="button"
                          className="ggx-cta"
                          data-testid="portal-download-all"
                          onClick={() => window.location.assign(downloadAllApi.guestFolderUrl(selectedFolder.id))}
                          style={{ ...accentBtnStyle, padding: "9px 16px", fontSize: 12.5, borderRadius: 9 }}
                        >
                          Download all
                        </button>
                      )}
                      {canDownload && (
                        <>
                          <button type="button" className="ggx-outline" onClick={() => setSelectedPhotoIds(new Set(photos.map((p) => p.id)))} style={outlineBtnStyle}>
                            Select all on page
                          </button>
                          {selectedPhotoIds.size > 0 && (
                            <>
                              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{selectedPhotoIds.size} selected</span>
                              <button
                                type="button"
                                className="ggx-cta"
                                data-testid="portal-download-selected"
                                disabled={bulkDownloadBusy}
                                onClick={handleBulkDownload}
                                style={{ ...accentBtnStyle, padding: "9px 16px", fontSize: 12.5, borderRadius: 9 }}
                              >
                                {bulkDownloadBusy ? "Preparing…" : "Download selected"}
                              </button>
                              <button type="button" className="ggx-outline" onClick={() => setSelectedPhotoIds(new Set())} style={{ ...outlineBtnStyle, color: "var(--ps2-muted)" }}>
                                Clear
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {bulkDownloadError && <div style={{ fontSize: 12.5, color: "#e87f8f", marginBottom: 10 }}>{bulkDownloadError}</div>}

                  {photosError && <div style={{ fontSize: 13.5, color: "#e87f8f" }}>{photosError}</div>}
                  {photosLoading && <div style={{ fontSize: 13.5, color: "var(--ps2-muted)" }}>Loading photos…</div>}
                  {!photosLoading && photos.length === 0 && !photosError && (
                    <div style={{ fontSize: 13.5, color: "var(--ps2-muted)" }}>No photos in this folder.</div>
                  )}

                  {!photosLoading && photos.length > 0 && (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }} data-testid="portal-photo-grid">
                        {photos.map((photo) => {
                          const selected = selectedPhotoIds.has(photo.id);
                          return (
                            <div key={photo.id} style={{ position: "relative" }} data-testid={`portal-photo-card-${photo.id}`}>
                              <button
                                type="button"
                                className="ggx-thumb"
                                onClick={() => setViewerPhotoId(photo.id)}
                                data-testid={`portal-photo-thumb-${photo.id}`}
                                style={{
                                  display: "block",
                                  width: "100%",
                                  aspectRatio: "1",
                                  borderRadius: 10,
                                  overflow: "hidden",
                                  border: selected ? "2px solid var(--ps2-accent)" : "none",
                                  padding: 0,
                                  background: "var(--ps2-tile)",
                                  cursor: "pointer",
                                  color: "var(--ps2-muted)",
                                  fontSize: 11,
                                  fontFamily: "inherit",
                                }}
                              >
                                {photo.thumbnailUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={photo.thumbnailUrl} alt={photo.originalFilename} style={{ width: "100%", height: "100%", objectFit: "cover", transition: "transform .3s" }} />
                                ) : (
                                  "no preview"
                                )}
                              </button>
                              {canDownload && (
                                <div
                                  onClick={() => toggleSelectPhoto(photo.id)}
                                  data-testid={`portal-select-${photo.id}`}
                                  style={{
                                    position: "absolute",
                                    top: 8,
                                    left: 8,
                                    width: 18,
                                    height: 18,
                                    borderRadius: 5,
                                    border: `1.5px solid ${selected ? "var(--ps2-accent)" : "rgba(255,255,255,.5)"}`,
                                    background: selected ? "var(--ps2-accent)" : "rgba(10,11,16,.45)",
                                    display: "grid",
                                    placeItems: "center",
                                    cursor: "pointer",
                                  }}
                                >
                                  {selected && (
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#141118" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M20 6 9 17l-5-5" />
                                    </svg>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {photosTotal > PAGE_LIMIT && (
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
                          <button type="button" className="ggx-outline" onClick={handlePrevPage} disabled={photosOffset === 0} style={{ ...outlineBtnStyle, color: "var(--ps2-muted)" }}>
                            ‹ Prev
                          </button>
                          <button
                            type="button"
                            className="ggx-outline"
                            onClick={handleNextPage}
                            disabled={photosOffset + PAGE_LIMIT >= photosTotal}
                            style={{ ...outlineBtnStyle, color: "var(--ps2-muted)" }}
                          >
                            Next ›
                          </button>
                          <span style={{ fontSize: 12, color: "var(--ps2-muted)" }}>
                            Showing {photosTotal === 0 ? 0 : photosOffset + 1}–{Math.min(photosOffset + PAGE_LIMIT, photosTotal)} of {photosTotal}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: 11.5, color: "var(--ps2-muted)" }}>
            <Ps2Logo size={16} gradientId="ggxLogoG" />
            {state === "unlocked" && canDownload ? "Shared via PhotoSphere" : "Shared via PhotoSphere — downloads disabled by the owner"}
          </div>
        </div>
      </main>

      {viewerPhotoId && (
        <div
          data-testid="guest-photo-viewer"
          onClick={(e) => {
            if (e.target === e.currentTarget) setViewerPhotoId(null);
          }}
          style={{ position: "fixed", inset: 0, zIndex: 460, background: "rgba(5,6,10,.65)", backdropFilter: "blur(10px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, animation: "ps2In .2s both" }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 720, maxWidth: "94vw", maxHeight: "90vh", overflowY: "auto", borderRadius: 20, background: "var(--ps2-panel)", border: "1px solid var(--ps2-border)", boxShadow: "var(--ps2-shadow)", padding: 22, animation: "ps2Up .25s cubic-bezier(.2,.8,.2,1) both" }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontFamily: "var(--ps2-font-serif)", fontSize: 22, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{viewerDetail?.originalFilename ?? ""}</div>
              <button
                type="button"
                aria-label="Close"
                data-testid="guest-viewer-close"
                onClick={() => setViewerPhotoId(null)}
                style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--ps2-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4 }}
              >
                ×
              </button>
            </div>
            {viewerLoading && <div style={{ fontSize: 13.5, color: "var(--ps2-muted)" }}>Loading…</div>}
            {!viewerLoading && viewerError && <div style={{ fontSize: 13.5, color: "#e87f8f" }}>{viewerError}</div>}
            {!viewerLoading && !viewerError && viewerDetail && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={viewerDetail.original.url}
                alt={viewerDetail.originalFilename}
                data-testid="guest-viewer-image"
                style={{ width: "100%", borderRadius: 14, objectFit: "contain", maxHeight: "60vh", background: "var(--ps2-bg)" }}
              />
            )}
            {viewerDetail && (
              <div style={{ fontSize: 12.5, color: "var(--ps2-muted)", marginTop: 12 }}>
                Date taken · {formatTakenAt(viewerDetail.exif.takenAt)}
                {(viewerDetail.exif.cameraMake || viewerDetail.exif.cameraModel) && (
                  <> · {[viewerDetail.exif.cameraMake, viewerDetail.exif.cameraModel].filter(Boolean).join(" ")}</>
                )}
              </div>
            )}
            {canDownload && viewerDetail && (
              <div style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className="ggx-cta"
                  disabled={downloadState.busy}
                  onClick={() => handleDownload(viewerDetail.id)}
                  data-testid="guest-viewer-download-button"
                  style={{ ...accentBtnStyle, padding: "10px 18px", fontSize: 13 }}
                >
                  {downloadState.busy ? "Preparing…" : "Download this photo"}
                </button>
                {downloadState.error && <div style={{ fontSize: 12.5, color: "#e87f8f", marginTop: 8 }}>{downloadState.error}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTakenAt(takenAt: string | null | undefined): string {
  if (!takenAt) return "Unknown";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString();
}
