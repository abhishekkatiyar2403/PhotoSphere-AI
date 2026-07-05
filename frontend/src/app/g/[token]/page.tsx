"use client";

// Guest portal (specs/guest-access-otp.md, design/wireframes/guest-portal.svg
// - U3 Option B: preview-first, ONE PAGE for the guest's entire journey).
// This route is PUBLIC and deliberately NOT auth-gated the way
// /dashboard|/organize|/browse|/share|/guests are - there is no authApi.me()
// check and no redirect to /login here. It's for anonymous guests.
//
// Internal state machine ('landing' | 'waiting' | 'unlocked'), all on THIS
// page - no navigation between states, just local component state per the
// wireframe's "no page hop" requirement:
//  - landing: a static, decorative locked-preview grid (see the hard
//    constraint below) + "Request access" -> POST /api/invites/:token/request.
//  - waiting: poll GET /api/invites/requests/:requestId/status every 5s
//    (comfortably under the backend's 120/15min/IP budget - 5s polling for
//    even a full 15 minutes is 180 requests, so 5s is chosen with headroom,
//    not cut close to the limit). On 'approved', the SAME response is what
//    sets the httpOnly guest-session cookie on this browser (Day3.md's G7
//    handoff) - our only job is to include credentials, which apiFetch
//    already does for every call. On 'denied'/'expired': a clear message +
//    "Request again".
//  - unlocked: fetch the REAL scoped data for the first time - guestPortalApi.
//
// HARD PRIVACY CONSTRAINT (see build brief - do not relax): the pre-approval
// preview grid below is 100% decorative markup - a fixed count of gray/lock
// tiles - never fetched from any endpoint, never a real thumbnail or
// pre-signed URL. No guest.* API call of any kind happens before a session
// exists. This is intentional even though it looks static/unpolished.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  ApiError,
  GuestFolder,
  FolderPhoto,
  guestPortalApi,
  GuestPhotoDetail,
  invitesApi,
} from "@/lib/api";

const POLL_INTERVAL_MS = 5000; // safely under the 120/15min/IP status-poll budget
const PREVIEW_TILE_COUNT = 6; // a plausible tile count - NOT derived from any fetch

// 'probing' is the initial state: on mount we make ONE guest-scoped call
// (GET /api/guest/folders) to see if this browser already holds a live guest
// session (i.e. an already-approved guest re-visiting). 200 -> jump straight
// to 'unlocked'; 401/anything-else -> fall through to 'landing' (BUG-2 fix -
// a returning approved guest lands in their photos and never re-requests
// against a spent single-use invite). While probing we show the same
// decorative locked grid as 'landing' (no data behind it) with the CTA
// withheld, so nothing flickers and the privacy constraint is untouched.
type PortalState = "probing" | "landing" | "waiting" | "unlocked";
type ResolvedOutcome = "denied" | "expired" | null;

type PageLimit = 12;
const PAGE_LIMIT: PageLimit = 12;

export default function GuestPortalPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [state, setState] = useState<PortalState>("probing");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [resolvedOutcome, setResolvedOutcome] = useState<ResolvedOutcome>(null);
  const [landingError, setLandingError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const gridRequestIdRef = useRef(0);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // ---- Load-time session probe (BUG-2 fix) ----
  // Exactly ONE guest-scoped call on mount to detect an existing valid guest
  // session. This is privacy-safe: a guest WITHOUT a session gets 401 and we
  // fall through to 'landing' (locked decorative grid only, no real data);
  // only a guest WITH a live session (already approved) gets 200 and is sent
  // to 'unlocked', where the existing unlocked-state effect fetches their real
  // scoped folders/photos. We do NOT fetch any photo/thumbnail data here - the
  // folders-list call whose 401 keeps everything locked is the only request.
  useEffect(() => {
    let cancelled = false;
    guestPortalApi
      .folders()
      .then(() => {
        if (cancelled) return;
        // Live session already exists -> go straight to the photos. The
        // unlocked-state effect will re-fetch folders (one extra list call,
        // no image data) and render exactly as the post-approval flow does.
        setState("unlocked");
      })
      .catch(() => {
        // 401 (no/expired/revoked session) or any transient error -> normal
        // locked landing. Never surfaces real data.
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
        // Secondary guard, kept as a harmless fallback. In practice the
        // load-time session probe above already routes an already-approved
        // guest to 'unlocked', and on a single-use invite (G6) a spent invite
        // 404s before this branch can fire (BUG-2 root cause) - so this is
        // effectively dead but left in as defense-in-depth. See MR draft.
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
              ? // A genuinely spent single-use invite (G6): a forwarded link,
                // or a revoked/expired guest re-clicking. An already-approved
                // guest with a live session never reaches here (the load-time
                // probe sends them straight to their photos).
                "This invite link has already been used or is no longer active. Ask the owner to share a new link."
              : "This invite link is invalid or has expired."
          : "Something went wrong. Please try again.";
      setLandingError(message);
    } finally {
      setRequesting(false);
    }
  }

  // ---- Waiting: poll status every 5s ----
  const pollStatus = useCallback(async (id: string) => {
    try {
      const res = await invitesApi.status(id);
      if (res.status === "approved" || res.status === "already_approved") {
        stopPolling();
        setState("unlocked");
        return;
      }
      if (res.status === "denied" || res.status === "expired") {
        stopPolling();
        setResolvedOutcome(res.status);
        setState("landing");
        return;
      }
      // status === 'pending' - keep polling.
    } catch {
      // Transient network/429 - keep polling silently rather than tearing
      // down the waiting UI on one bad tick; the interval will retry.
    }
  }, []);

  useEffect(() => {
    if (state !== "waiting" || !requestId) return;
    pollStatus(requestId); // check immediately, then on the interval
    pollRef.current = setInterval(() => pollStatus(requestId), POLL_INTERVAL_MS);
    return () => stopPolling();
  }, [state, requestId, pollStatus]);

  function handleRequestAgain() {
    setResolvedOutcome(null);
    setRequestId(null);
    setLandingError(null);
  }

  // ---- Unlocked: fetch real scoped data for the first time ----
  useEffect(() => {
    if (state !== "unlocked") return;
    let cancelled = false;
    setFoldersLoading(true);
    setFoldersError(null);
    guestPortalApi
      .folders()
      .then((res) => {
        if (cancelled) return;
        setFolders(res.folders);
        setSelectedFolderId((prev) => prev ?? res.folders[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setFoldersError(err instanceof Error ? err.message : "Failed to load your shared folders");
      })
      .finally(() => {
        if (!cancelled) setFoldersLoading(false);
      });
    return () => {
      cancelled = true;
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

  // ---- Photo detail viewer (minimal guest-scoped equivalent - see report
  // for why PhotoViewer wasn't reused directly) ----
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

  function handlePrevPage() {
    if (!selectedFolderId || photosOffset === 0) return;
    loadFolderPhotos(selectedFolderId, Math.max(0, photosOffset - PAGE_LIMIT));
  }

  function handleNextPage() {
    if (!selectedFolderId || photosOffset + PAGE_LIMIT >= photosTotal) return;
    loadFolderPhotos(selectedFolderId, photosOffset + PAGE_LIMIT);
  }

  return (
    <main className="portal-shell">
      <div className="portal-topbar">
        <h1>PhotoSphere AI</h1>
        <span>Shared photos</span>
      </div>

      <div className="portal-content">
        {state !== "unlocked" && (
          <>
            <div className="portal-heading">
              <h2>You&apos;ve been invited to view some photos</h2>
              <p>The owner approves your visit with a one-time code — no account or password needed.</p>
            </div>

            <p className="portal-preview-label">Preview — locked until approved</p>
            <div className="portal-locked-grid" data-testid="portal-locked-grid">
              {Array.from({ length: PREVIEW_TILE_COUNT }).map((_, i) => (
                <div key={i} className="portal-locked-tile" data-testid="portal-locked-tile">
                  <span className="portal-locked-tile-icon" aria-hidden="true">
                    🔒
                  </span>
                </div>
              ))}
            </div>

            <div className="portal-status-bar" data-testid="portal-status-bar">
              {state === "probing" && (
                <div className="portal-waiting" data-testid="portal-probing">
                  <div className="portal-spinner" aria-hidden="true" />
                  <div>
                    <h3>Loading…</h3>
                    <p>Checking whether you already have access to these photos.</p>
                  </div>
                </div>
              )}

              {state === "landing" && (
                <div className="portal-status-cta">
                  <h3>Ask for access to these photos</h3>
                  <p>
                    The owner approves with a one-time code — no account or password needed for you. Click below to
                    send a request.
                  </p>
                  {resolvedOutcome && (
                    <p className="portal-error" data-testid="portal-resolved-message">
                      {resolvedOutcome === "denied"
                        ? "Your request was denied."
                        : "Your request expired before it was approved."}
                    </p>
                  )}
                  {landingError && <p className="portal-error">{landingError}</p>}
                  <button
                    type="button"
                    className="portal-request-btn"
                    disabled={requesting}
                    onClick={resolvedOutcome ? handleRequestAgain : handleRequestAccess}
                    data-testid="portal-request-access-button"
                  >
                    {resolvedOutcome ? "Request again" : requesting ? "Requesting…" : "Request access"}
                  </button>
                </div>
              )}

              {state === "waiting" && (
                <div className="portal-waiting" data-testid="portal-waiting">
                  <div className="portal-spinner" aria-hidden="true" />
                  <div>
                    <h3>Waiting for owner approval…</h3>
                    <p>This checks automatically. The page unlocks the moment you&apos;re approved.</p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {state === "unlocked" && (
          <div data-testid="portal-unlocked">
            {foldersLoading && <p className="organize-empty">Loading your shared folders…</p>}
            {foldersError && <p className="portal-error">{foldersError}</p>}

            {!foldersLoading && !foldersError && folders.length === 0 && (
              <p className="organize-empty">No folders are currently shared with you.</p>
            )}

            {!foldersLoading && folders.length > 0 && (
              <>
                <div className="portal-folder-list" data-testid="portal-folder-list">
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      className={`portal-folder-chip${folder.id === selectedFolderId ? " active" : ""}`}
                      onClick={() => {
                        setSelectedFolderId(folder.id);
                        setPhotosOffset(0);
                      }}
                      data-testid={`portal-folder-chip-${folder.name}`}
                    >
                      {folder.name} ({folder.photoCount})
                    </button>
                  ))}
                </div>

                {selectedFolder && (
                  <div className="portal-unlocked-header">
                    <h3>{selectedFolder.name}</h3>
                    <span style={{ fontSize: 12, color: "#8a90a0" }}>
                      {selectedFolder.permissionLevel === "view" ? "View only" : "Download access"}
                    </span>
                  </div>
                )}

                {photosError && <p className="portal-error">{photosError}</p>}
                {photosLoading && <p className="organize-empty">Loading photos…</p>}

                {!photosLoading && photos.length === 0 && !photosError && (
                  <p className="organize-empty">No photos in this folder.</p>
                )}

                {!photosLoading && photos.length > 0 && (
                  <>
                    <div className="portal-grid" data-testid="portal-photo-grid">
                      {photos.map((photo) => (
                        <div key={photo.id} className="portal-card" data-testid={`portal-photo-card-${photo.id}`}>
                          <button
                            type="button"
                            className="portal-card-thumb"
                            onClick={() => setViewerPhotoId(photo.id)}
                            data-testid={`portal-photo-thumb-${photo.id}`}
                          >
                            {photo.thumbnailUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={photo.thumbnailUrl} alt={photo.originalFilename} />
                            ) : (
                              "no preview"
                            )}
                          </button>
                          <p className="portal-card-filename">{photo.originalFilename}</p>
                          {canDownload && (
                            <button
                              type="button"
                              className="portal-download-btn"
                              onClick={() => handleDownload(photo.id)}
                              data-testid={`portal-download-button-${photo.id}`}
                            >
                              Download
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="organize-pagination">
                      <button type="button" onClick={handlePrevPage} disabled={photosOffset === 0}>
                        ‹ Prev
                      </button>
                      <button
                        type="button"
                        onClick={handleNextPage}
                        disabled={photosOffset + PAGE_LIMIT >= photosTotal}
                      >
                        Next ›
                      </button>
                      <span>
                        Showing {photosTotal === 0 ? 0 : photosOffset + 1}–
                        {Math.min(photosOffset + PAGE_LIMIT, photosTotal)} of {photosTotal}
                      </span>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {viewerPhotoId && (
        <div
          className="viewer-backdrop"
          data-testid="guest-photo-viewer"
          onClick={(e) => {
            if (e.target === e.currentTarget) setViewerPhotoId(null);
          }}
        >
          <div className="viewer-shell">
            <button
              type="button"
              className="viewer-close"
              aria-label="Close"
              onClick={() => setViewerPhotoId(null)}
              data-testid="guest-viewer-close"
            >
              ✕
            </button>
            <div
              className="viewer-image-area"
              onClick={(e) => {
                if (e.target === e.currentTarget) setViewerPhotoId(null);
              }}
            >
              {viewerLoading && <p className="viewer-loading">Loading…</p>}
              {!viewerLoading && viewerError && <p className="viewer-error">{viewerError}</p>}
              {!viewerLoading && !viewerError && viewerDetail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="viewer-image"
                  src={viewerDetail.original.url}
                  alt={viewerDetail.originalFilename}
                  data-testid="guest-viewer-image"
                />
              )}
            </div>
            <aside className="viewer-info">
              <h3 className="viewer-info-filename">{viewerDetail?.originalFilename ?? ""}</h3>
              <p className="viewer-info-row">
                <span className="label">Date taken</span>
                <span>{formatTakenAt(viewerDetail?.exif.takenAt)}</span>
              </p>
              {(viewerDetail?.exif.cameraMake || viewerDetail?.exif.cameraModel) && (
                <p className="viewer-info-row">
                  <span className="label">Camera</span>
                  <span>
                    {[viewerDetail?.exif.cameraMake, viewerDetail?.exif.cameraModel].filter(Boolean).join(" ")}
                  </span>
                </p>
              )}
              {canDownload && viewerDetail && (
                <>
                  <button
                    type="button"
                    className="portal-download-btn"
                    disabled={downloadState.busy}
                    onClick={() => handleDownload(viewerDetail.id)}
                    data-testid="guest-viewer-download-button"
                  >
                    {downloadState.busy ? "Preparing…" : "Download this photo"}
                  </button>
                  {downloadState.error && <p className="portal-error">{downloadState.error}</p>}
                </>
              )}
            </aside>
          </div>
        </div>
      )}
    </main>
  );
}

function formatTakenAt(takenAt: string | null | undefined): string {
  if (!takenAt) return "Unknown";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString();
}
