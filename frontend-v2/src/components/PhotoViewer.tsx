"use client";

// Photo viewer (specs/week7-8-dashboard-browser-viewer.md "Photo viewer" -
// built directly against the interaction spec, no wireframe round; see the
// spec's "Wireframe judgment" section for why). Fullscreen image + EXIF
// panel, reachable from any grid (/browse and /organize's non-Unfiled
// cards) - a single shared component so "reachable from any grid" is a
// real, tested property rather than two near-duplicate implementations.
//
// Navigation is scoped to the currently-loaded page of photos only (no
// cross-page/-folder fetch - explicit Non-goal). The caller owns the photo
// list and the "which index is open" state; this component is otherwise
// self-contained (fetches full detail per photo on open, per the spec's
// documented default over eager prefetching).

import { useEffect, useRef, useState } from "react";
import { photosApi, PhotoDetail } from "@/lib/api";

export type ViewerPhotoRef = {
  id: string;
  originalFilename: string;
  status: string;
  duplicateOfLabel?: string | null;
};

export function PhotoViewer({
  photos,
  index,
  onIndexChange,
  onClose,
}: {
  photos: ViewerPhotoRef[];
  index: number;
  onIndexChange: (nextIndex: number) => void;
  onClose: () => void;
}) {
  const current = photos[index] ?? null;
  const [detail, setDetail] = useState<PhotoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stale-fetch guard: navigating prev/next quickly (or closing mid-fetch)
  // must not let an older GET /api/photos/:id response clobber a newer one -
  // same requestId-ref pattern /organize uses for its grid fetch.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!current) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setDetail(null);

    photosApi
      .get(current.id)
      .then((res) => {
        if (requestId !== requestIdRef.current) return; // superseded by a newer nav/close
        setDetail(res);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load photo");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const hasPrev = index > 0;
  const hasNext = index < photos.length - 1;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && hasPrev) {
        onIndexChange(index - 1);
      } else if (e.key === "ArrowRight" && hasNext) {
        onIndexChange(index + 1);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [hasPrev, hasNext, index, onClose, onIndexChange]);

  if (!current) return null;

  const isUnfiled = current.status === "failed" || current.status === "duplicate";

  return (
    <div
      className="viewer-backdrop"
      data-testid="photo-viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="viewer-shell">
        <button type="button" className="viewer-close" data-testid="viewer-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div
          className="viewer-image-area"
          onClick={(e) => {
            // Backdrop-click-to-close: the shell fills the full overlay (no
            // exposed margin to click), so "clicking the backdrop" means
            // clicking this area itself rather than the image or a nav
            // button - anywhere in viewer-image-area that isn't the <img>
            // or a nav button counts as backdrop.
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {hasPrev && (
            <button
              type="button"
              className="viewer-nav viewer-nav-prev"
              data-testid="viewer-prev"
              aria-label="Previous photo"
              onClick={() => onIndexChange(index - 1)}
            >
              ‹
            </button>
          )}

          {loading && <p className="viewer-loading">Loading…</p>}
          {!loading && error && <p className="viewer-error">{error}</p>}
          {!loading && !error && detail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="viewer-image"
              src={viewerImageUrl(detail)}
              alt={detail.originalFilename}
              data-testid="viewer-image"
            />
          )}

          {hasNext && (
            <button
              type="button"
              className="viewer-nav viewer-nav-next"
              data-testid="viewer-next"
              aria-label="Next photo"
              onClick={() => onIndexChange(index + 1)}
            >
              ›
            </button>
          )}
        </div>

        <aside className="viewer-info" data-testid="viewer-info">
          <h3 className="viewer-info-filename">{current.originalFilename}</h3>

          {isUnfiled ? (
            <p className="viewer-info-row">
              <span className="label">Status</span>
              <span>
                {current.status === "failed"
                  ? "Classification failed"
                  : `Duplicate${current.duplicateOfLabel ? ` of ${current.duplicateOfLabel}` : ""}`}
              </span>
            </p>
          ) : (
            <p className="viewer-info-row">
              <span className="label">Folder</span>
              <span>{detail?.folder?.name ?? "Unfiled"}</span>
            </p>
          )}

          {/* Why this photo is here instead of a normal category folder —
              backend's computeReason (lib/photoCard.ts); null for a
              normally-filed photo, so this covers Unfiled AND a low-
              confidence/unmapped "Uncategorized" folder alike. */}
          {detail?.reason && (
            <p className="viewer-info-row viewer-info-reason">
              <span className="label">Why</span>
              <span>{detail.reason}</span>
            </p>
          )}

          <p className="viewer-info-row">
            <span className="label">Date taken</span>
            <span>{formatTakenAt(detail?.exif.takenAt)}</span>
          </p>

          {(detail?.exif.cameraMake || detail?.exif.cameraModel) && (
            <p className="viewer-info-row">
              <span className="label">Camera</span>
              <span>{[detail?.exif.cameraMake, detail?.exif.cameraModel].filter(Boolean).join(" ")}</span>
            </p>
          )}

          {detail?.exif.gpsLat != null && detail?.exif.gpsLng != null && (
            <p className="viewer-info-row">
              <span className="label">GPS</span>
              <span>
                {detail.exif.gpsLat.toFixed(5)}, {detail.exif.gpsLng.toFixed(5)}
              </span>
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

// Prefer the largest generated thumbnail (always a plain JPEG, produced by
// the worker's own pipeline) over the raw original file's URL — most
// browsers (everything except Safari) simply cannot render HEIC in an <img>
// at all, so a HEIC original's presigned URL shows as a broken image no
// matter how valid the file is. Only fall back to the original when no
// thumbnail exists yet (e.g. still processing, or a genuinely undecodable
// HEIC where thumbnailing itself had to skip — that original will still
// fail to render in most browsers, but there's nothing better to show).
function viewerImageUrl(detail: PhotoDetail): string {
  return detail.thumbnails["1200"] ?? detail.thumbnails["400"] ?? detail.thumbnails["150"] ?? detail.original.url;
}

function formatTakenAt(takenAt: string | null | undefined): string {
  if (!takenAt) return "Unknown";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString();
}
