"use client";

// Cinematic fullscreen viewer for the v2 redesign - same real fetch-per-photo
// pattern as the classic <PhotoViewer> (photosApi.get per index, stale-fetch
// guard, ←/→/Esc), synced to the PhotoSphere design's Photo viewer overlay:
// blurred color-tinted backdrop built from the photo itself, floating arrow
// nav (wrap-around, like the design's `step` modulo), a 250px side panel
// (AI tags / Details / Edit / Comments / actions) and a bottom filmstrip.
//
// Favorites/comments/rename/editor persistence/video have no backing
// endpoint in lib/api.ts yet (no favorite, comment, or generic photo-update
// route) - see lib/v2/featureFlags.ts. Each is fully built and usable today
// via a local (per-browser) fallback; flipping its flag on swaps in the real
// API call once the backend supports it. AI tags / file size / video
// duration have no backend field either, so they use a deterministic
// per-photo mock (same featureFlags posture). Download is fully real
// (detail.download.url).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type TouchEvent, type TransitionEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { photosApi, PhotoDetail } from "@/lib/api";
import { usePs2User } from "@/components/v2/Ps2UserContext";
import { useToast } from "@/components/v2/ToastProviderV2";
import { useFavorites } from "@/components/v2/useFavorites";
import { usePhotoRename } from "@/components/v2/usePhotoRename";
import { usePhotoComments } from "@/components/v2/usePhotoComments";
import { isVideoFile } from "@/lib/v2/isVideoFile";

export type ViewerPhotoRef = {
  id: string;
  originalFilename: string;
  status: string;
  duplicateOfLabel?: string | null;
  // Grid thumbnail for the design's bottom filmstrip. Optional - photos
  // without one render a neutral placeholder tile instead.
  thumbSrc?: string | null;
};

// The clicked tile's on-screen position/size + thumbnail, captured by the
// caller (grid onClick handler) right before opening the viewer - drives the
// FLIP "tile grows into the fullscreen viewer" entrance (the design's
// flipOpen), instead of a plain fade. Optional: viewers opened without a
// known tile just play the design's psIn scale-in on the overlay itself.
export type ViewerOrigin = {
  rect: { top: number; left: number; width: number; height: number };
  src: string | null;
};

const EDITOR_DEFAULT = { brightness: 100, contrast: 100, saturation: 100 };
// The design's aiEnhance preset: editB 106 / editC 112 / editSat 124.
const EDITOR_ENHANCED = { brightness: 106, contrast: 112, saturation: 124 };

// Design-matching viewer chrome that the shared globals.css classes don't
// cover (keyframes, hover states, the 250px side panel + mobile stacking).
const VIEWER_CSS = `
@keyframes ps2ViewerIn{from{opacity:0;transform:scale(.965)}to{opacity:1;transform:none}}
@keyframes ps2VidProg{from{width:0}to{width:100%}}
.ps2v-side{width:250px;flex:none;color:#eef0f4;display:flex;flex-direction:column;gap:18px}
.ps2v-fav:hover{transform:scale(1.1)}
.ps2v-ghost-btn:hover{background:rgba(255,255,255,.1) !important}
.ps2v-reset-link{color:var(--ps2-accent);text-decoration:none}
.ps2v-reset-link:hover{color:#eef0f4}
.ps2v-strip-thumb{width:56px;height:42px;flex:none;border-radius:8px;object-fit:cover;cursor:pointer;transition:transform .25s, box-shadow .25s}
.ps2v-strip-thumb:hover{transform:scale(1.12)}
.ps2-viewer-play-btn:hover{opacity:1 !important;background:rgba(10,11,16,.75) !important}
@media (max-width: 760px){
  .ps2v-side{width:100%}
  .ps2-viewer-nav{display:none}
}
`;

export function PhotoViewerV2({
  photos,
  index,
  onIndexChange,
  onClose,
  origin,
}: {
  photos: ViewerPhotoRef[];
  index: number;
  onIndexChange: (nextIndex: number) => void;
  onClose: () => void;
  onDeleted?: (photoId: string) => void;
  origin?: ViewerOrigin | null;
}) {
  const current = photos[index] ?? null;
  const router = useRouter();
  const user = usePs2User();
  const showToast = useToast();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { titleFor, rename } = usePhotoRename();
  const { comments, postComment } = usePhotoComments(current?.id ?? null);

  const [detail, setDetail] = useState<PhotoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [editor, setEditor] = useState(EDITOR_DEFAULT);
  const [videoPlaying, setVideoPlaying] = useState(false);

  // Editor/rename/comment-draft/video-playing state is per-photo scratch
  // state, not persisted (except rename/comments via their own hooks) - it
  // should never leak from one photo to the next when navigating with the
  // arrows, matching the design's step()/open() resets.
  useEffect(() => {
    setEditor(EDITOR_DEFAULT);
    setVideoPlaying(false);
    setRenaming(false);
    setCommentDraft("");
  }, [current?.id]);

  // ---- FLIP entrance: pin a flying <img> exactly over the origin tile,
  // then animate it to the settled centered/contained size via a CSS
  // transition on plain top/left/width/height. Runs once per mount, not on
  // prev/next - navigating inside the viewer just swaps the image normally.
  //
  // This writes to the DOM directly through a ref rather than via useState:
  // two setState calls in the same effect get batched into a single commit
  // in React 18, so the browser never actually paints the "pinned" frame
  // before the "settled" styles land - the transition has no starting point
  // to animate from, so it silently no-ops and transitionend never fires
  // (which would otherwise permanently hide the rest of the viewer chrome).
  // useLayoutEffect + a plain DOM write guarantees the pinned frame paints
  // first; the rAF after it guarantees a second, later frame for the
  // transition to actually interpolate between. ----
  const [showFlyer, setShowFlyer] = useState(!!origin?.src);
  const [chromeVisible, setChromeVisible] = useState(!origin?.src);
  const flyingRef = useRef<HTMLImageElement>(null);
  const revealedRef = useRef(false);

  function reveal() {
    if (revealedRef.current) return;
    revealedRef.current = true;
    setChromeVisible(true);
    setShowFlyer(false);
  }

  useLayoutEffect(() => {
    if (!origin?.src) return;
    const el = flyingRef.current;
    if (!el) {
      reveal();
      return;
    }

    el.style.transition = "none";
    el.style.top = `${origin.rect.top}px`;
    el.style.left = `${origin.rect.left}px`;
    el.style.width = `${origin.rect.width}px`;
    el.style.height = `${origin.rect.height}px`;
    el.style.borderRadius = "14px";

    const raf = requestAnimationFrame(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isMobile = vw <= 760;
      const maxW = vw * (isMobile ? 0.94 : 0.62);
      const maxH = vh * (isMobile ? 0.5 : 0.6);
      el.style.transition =
        "top .45s cubic-bezier(.2,.8,.2,1), left .45s cubic-bezier(.2,.8,.2,1), width .45s cubic-bezier(.2,.8,.2,1), height .45s cubic-bezier(.2,.8,.2,1), border-radius .45s";
      el.style.top = `${(vh - maxH) / 2}px`;
      el.style.left = `${(vw - maxW) / 2}px`;
      el.style.width = `${maxW}px`;
      el.style.height = `${maxH}px`;
      el.style.borderRadius = "14px";
    });

    // Safety net: if transitionend never fires for some reason (e.g. the
    // origin rect exactly equals the settled size, so no property actually
    // changes), don't leave the viewer stuck with its chrome invisible.
    const fallback = window.setTimeout(reveal, 600);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFlipTransitionEnd(e: TransitionEvent<HTMLImageElement>) {
    if (e.propertyName !== "width") return; // fires once per animated property - act on just one
    reveal();
  }

  // ---- Swipe-down-to-close (mobile) - the design's viewerSwipe > 80
  // gesture. Only starts when the touch begins on the image itself (not the
  // nav arrows/header/side panel), so it can't hijack a tap on a button.
  // Purely a touch gesture - inert on desktop, where these events never
  // fire. ----
  const dragStartYRef = useRef<number | null>(null);
  const dragDeltaRef = useRef(0);
  const DISMISS_THRESHOLD = 80;

  function handleImageTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    dragStartYRef.current = e.touches[0].clientY;
    dragDeltaRef.current = 0;
  }

  function handleImageTouchMove(e: TouchEvent) {
    if (dragStartYRef.current == null) return;
    dragDeltaRef.current = e.touches[0].clientY - dragStartYRef.current;
  }

  function handleImageTouchEnd() {
    if (dragStartYRef.current == null) return;
    dragStartYRef.current = null;
    if (dragDeltaRef.current > DISMISS_THRESHOLD) onClose();
    dragDeltaRef.current = 0;
  }

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
        if (requestId !== requestIdRef.current) return;
        setDetail(res);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load photo");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [current?.id]);

  // Wrap-around navigation, like the design's step():
  // (viewer + d + n) % n - the arrows and ←/→ never dead-end.
  const count = photos.length;

  function step(d: number) {
    if (count < 1) return;
    onIndexChange((index + d + count) % count);
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, index, onClose, onIndexChange]);

  if (!current) return null;

  const imageUrl = detail ? viewerImageUrl(detail) : null;
  const isVideo = isVideoFile(current.originalFilename);
  const displayTitle = titleFor(current.id, current.originalFilename);
  const favorited = isFavorite(current.id);

  const place = detail?.folder?.name ?? "Unfiled";
  const dateTaken = formatTakenAt(detail?.exif.takenAt);
  const meta = detail ? `${place} · ${dateTaken}` : "";
  const tags = mockTags(current.id);
  const size = mockSize(current.id);

  function handleDownload() {
    if (!detail) return;
    showToast(`Downloading “${displayTitle}”…`);
    window.location.assign(detail.download.url);
  }

  // Shares by folder (the real guest model - see share/page.tsx), not a
  // single-photo link, since lib/api.ts has no single-photo share endpoint.
  // Lands on Share with this photo's folder pre-selected.
  function handleShare() {
    if (!detail?.folder) return;
    router.push(`/v2/share?folder=${encodeURIComponent(detail.folder.id)}`);
  }

  function startRename() {
    setRenameDraft(displayTitle);
    setRenaming(true);
  }

  function commitRename() {
    const title = renameDraft.trim();
    if (title && current) rename(current.id, title);
    setRenaming(false);
  }

  function handleEnhance() {
    setEditor(EDITOR_ENHANCED);
    showToast("AI enhance applied ✨");
  }

  function handleResetEditor() {
    setEditor(EDITOR_DEFAULT);
  }

  function handleCommentSubmit() {
    if (!commentDraft.trim()) return;
    postComment(user.name, commentDraft);
    setCommentDraft("");
  }

  const editActive = editor.brightness !== 100 || editor.contrast !== 100 || editor.saturation !== 100;
  const imageFilter = `brightness(${editor.brightness}%) contrast(${editor.contrast}%) saturate(${editor.saturation}%)`;

  const sectionLabel: CSSProperties = {
    fontSize: 11,
    letterSpacing: ".1em",
    textTransform: "uppercase",
    opacity: 0.5,
    marginBottom: 9,
  };

  // Portal out of .ps2-content, whose stacking context would trap the
  // overlay beneath the sticky topbar — but stay inside the .ps2 wrapper so
  // the --ps2-* design tokens and scoped rules still apply. The design's
  // viewer is a top-level fixed layer covering all chrome.
  const portalTarget = document.querySelector(".ps2") ?? document.body;
  return createPortal(
    <div
      className="ps2-viewer-backdrop"
      style={
        // The design's psIn scale-in on the overlay. Skipped when the FLIP
        // flyer runs - a transform on this ancestor would create a new
        // containing block for the flyer's position:fixed, breaking its
        // viewport-relative coordinates mid-flight.
        origin?.src ? undefined : { animation: "ps2ViewerIn .35s cubic-bezier(.2,.8,.2,1) both" }
      }
    >
      <style>{VIEWER_CSS}</style>

      {showFlyer && origin?.src && (
        // The flying shared-element itself - sits above everything else
        // while it animates from the clicked tile's rect to the settled,
        // centered size; unmounts once the transition ends (handleFlipTransitionEnd
        // or the fallback timer). Geometry (top/left/width/height/border-radius)
        // is written imperatively in the layout effect above, not via React
        // state - see that effect's comment for why.
        <img
          ref={flyingRef}
          src={origin.src}
          alt=""
          onTransitionEnd={handleFlipTransitionEnd}
          style={{ position: "fixed", zIndex: 310, objectFit: "cover", pointerEvents: "none" }}
        />
      )}

      <div
        className="ps2-viewer-header"
        style={{ opacity: chromeVisible ? 1 : 0, transition: "opacity .25s ease" }}
      >
        <div style={{ minWidth: 0 }}>
          {renaming ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              style={{
                background: "rgba(255,255,255,.08)",
                border: "1px solid var(--ps2-accent)",
                borderRadius: 8,
                padding: "5px 9px",
                fontSize: 14,
                fontFamily: "inherit",
                color: "#eef0f4",
                outline: "none",
                width: 240,
              }}
            />
          ) : (
            <div
              onClick={startRename}
              title="Click to rename"
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600, cursor: "text" }}
            >
              {displayTitle}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.45 }}>
                <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </div>
          )}
          <div style={{ fontSize: 12, opacity: 0.6 }}>{meta}</div>
        </div>
        <button type="button" className="ps2-viewer-close" onClick={onClose} aria-label="Close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div
        className="ps2-viewer-body"
        style={{ padding: "0 24px", overflowY: "auto", opacity: chromeVisible ? 1 : 0, transition: "opacity .25s ease" }}
      >
        {imageUrl && (
          <div className="ps2-viewer-ambient" aria-hidden="true">
            <img src={imageUrl} alt="" style={{ transition: "opacity .3s" }} />
          </div>
        )}

        <button type="button" className="ps2-viewer-nav" onClick={() => step(-1)} aria-label="Previous photo">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>

        <div
          onTouchStart={handleImageTouchStart}
          onTouchMove={handleImageTouchMove}
          onTouchEnd={handleImageTouchEnd}
          style={{
            flex: 1,
            maxHeight: "60vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 0,
            position: "relative",
          }}
        >
          {loading && <p style={{ color: "#eef0f4" }}>Loading…</p>}
          {!loading && error && <p style={{ color: "#e87f8f" }}>{error}</p>}
          {!loading && !error && imageUrl && (
            <img
              src={imageUrl}
              alt={displayTitle}
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                borderRadius: 14,
                boxShadow: "0 40px 120px rgba(0,0,0,.7)",
                animation: "ps2ViewerIn .4s both",
                filter: imageFilter,
                transition: "filter .25s",
              }}
            />
          )}

          {!loading && !error && imageUrl && isVideo && (
            <>
              <div
                className="ps2-viewer-play-btn"
                onClick={() => setVideoPlaying((v) => !v)}
                role="button"
                aria-label={videoPlaying ? "Pause" : "Play"}
                style={{
                  width: 74,
                  height: 74,
                  background: "rgba(10,11,16,.55)",
                  backdropFilter: "blur(8px)",
                  border: "1.5px solid rgba(255,255,255,.35)",
                  transition: "transform .25s, background .25s, opacity .3s",
                  opacity: videoPlaying ? 0.35 : 1,
                }}
              >
                {videoPlaying ? (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="#f4f5f8">
                    <rect x="6" y="5" width="4" height="14" rx="1.2" />
                    <rect x="14" y="5" width="4" height="14" rx="1.2" />
                  </svg>
                ) : (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="#f4f5f8">
                    <path d="M8 5v14l11-7Z" />
                  </svg>
                )}
              </div>
              <div
                style={{
                  position: "absolute",
                  right: 14,
                  bottom: 14,
                  fontSize: 11,
                  color: "#f4f5f8",
                  background: "rgba(10,11,16,.6)",
                  borderRadius: 99,
                  padding: "3px 10px",
                }}
              >
                {mockDuration(current.id)}
              </div>
              {videoPlaying && (
                <div
                  style={{
                    position: "absolute",
                    left: "8%",
                    right: "8%",
                    bottom: 8,
                    height: 4,
                    borderRadius: 99,
                    background: "rgba(255,255,255,.2)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      borderRadius: 99,
                      background: "var(--ps2-accent)",
                      animation: "ps2VidProg 8s linear forwards",
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <div className="ps2v-side">
          <div>
            <div style={sectionLabel}>AI tags</div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {tags.map((t) => (
                <span
                  key={t}
                  style={{
                    fontSize: 12,
                    border: "1px solid rgba(255,255,255,.18)",
                    borderRadius: 99,
                    padding: "5px 12px",
                    background: "rgba(255,255,255,.05)",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div style={sectionLabel}>Details</div>
            <div style={{ fontSize: 13, lineHeight: 2, opacity: 0.85 }}>
              {place}
              <br />
              {dateTaken}
              <br />
              {size} · RAW + JPEG
            </div>
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 9 }}>
              <div style={{ ...sectionLabel, marginBottom: 0 }}>Edit</div>
              {editActive && (
                <a
                  href="#"
                  className="ps2v-reset-link"
                  onClick={(e) => {
                    e.preventDefault();
                    handleResetEditor();
                  }}
                  style={{ fontSize: 11 }}
                >
                  Reset
                </a>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, opacity: 0.8 }}>
                <span style={{ width: 56, flex: "none" }}>Light</span>
                <input
                  type="range"
                  min={60}
                  max={140}
                  value={editor.brightness}
                  onChange={(e) => setEditor((s) => ({ ...s, brightness: Number(e.target.value) }))}
                  style={{ flex: 1, accentColor: "var(--ps2-accent)" }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, opacity: 0.8 }}>
                <span style={{ width: 56, flex: "none" }}>Contrast</span>
                <input
                  type="range"
                  min={60}
                  max={140}
                  value={editor.contrast}
                  onChange={(e) => setEditor((s) => ({ ...s, contrast: Number(e.target.value) }))}
                  style={{ flex: 1, accentColor: "var(--ps2-accent)" }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, opacity: 0.8 }}>
                <span style={{ width: 56, flex: "none" }}>Color</span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={editor.saturation}
                  onChange={(e) => setEditor((s) => ({ ...s, saturation: Number(e.target.value) }))}
                  style={{ flex: 1, accentColor: "var(--ps2-accent)" }}
                />
              </div>
            </div>
            <button type="button" className="ps2-viewer-enhance-btn" onClick={handleEnhance} style={{ marginTop: 12 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2l2.1 6.4L21 10l-6.4 2.1L12 19l-2.1-6.9L3 10l6.9-1.6L12 2z" />
              </svg>
              AI enhance
            </button>
          </div>

          <div>
            <div style={sectionLabel}>Comments</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 130, overflowY: "auto" }}>
              {comments.map((c, i) => (
                <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 600 }}>{c.by}</span>{" "}
                  <span style={{ opacity: 0.5, fontSize: 11 }}>{formatCommentWhen(c.at)}</span>
                  <br />
                  {c.text}
                </div>
              ))}
            </div>
            <input
              className="ps2-viewer-comment-input"
              value={commentDraft}
              placeholder="Add a comment…"
              onChange={(e) => setCommentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCommentSubmit();
              }}
              style={{ marginTop: 10 }}
            />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="ps2v-fav"
              title="Favorite"
              onClick={() => toggleFavorite(current.id)}
              style={{
                width: 40,
                flex: "none",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,.18)",
                background: "transparent",
                color: favorited ? "#e87f8f" : "#eef0f4",
                padding: 0,
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                transition: "transform .2s",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={favorited ? "#e87f8f" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8Z" />
              </svg>
            </button>
            <button
              type="button"
              className="ps2v-ghost-btn"
              onClick={handleDownload}
              disabled={!detail}
              style={{
                flex: 1,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,.18)",
                background: "transparent",
                color: "#eef0f4",
                padding: 10,
                fontFamily: "inherit",
                fontSize: 12.5,
                cursor: "pointer",
                transition: "background .2s",
              }}
            >
              Download
            </button>
            <button
              type="button"
              onClick={handleShare}
              disabled={!detail?.folder}
              title={detail && !detail.folder ? "Unfiled photos aren't shareable - file it into a folder first" : undefined}
              style={{
                flex: 1,
                borderRadius: 10,
                border: "none",
                background: "var(--ps2-accent)",
                color: "#141118",
                padding: 10,
                fontFamily: "inherit",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Share
            </button>
          </div>
        </div>

        <button type="button" className="ps2-viewer-nav" onClick={() => step(1)} aria-label="Next photo">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "center",
          padding: "16px 24px 20px",
          overflowX: "auto",
          opacity: chromeVisible ? 1 : 0,
          transition: "opacity .25s ease",
        }}
      >
        {photos.map((p, i) =>
          p.thumbSrc ? (
            <img
              key={p.id}
              className="ps2v-strip-thumb"
              src={p.thumbSrc}
              alt=""
              onClick={() => onIndexChange(i)}
              style={{ opacity: i === index ? 1 : 0.45, boxShadow: i === index ? "0 0 0 2px var(--ps2-accent)" : "none" }}
            />
          ) : (
            <div
              key={p.id}
              className="ps2v-strip-thumb"
              onClick={() => onIndexChange(i)}
              style={{
                background: "rgba(255,255,255,.08)",
                opacity: i === index ? 1 : 0.45,
                boxShadow: i === index ? "0 0 0 2px var(--ps2-accent)" : "none",
              }}
            />
          ),
        )}
      </div>
    </div>,
    portalTarget,
  );
}

function viewerImageUrl(detail: PhotoDetail): string {
  return detail.thumbnails["1200"] ?? detail.thumbnails["400"] ?? detail.thumbnails["150"] ?? detail.original.url;
}

// Design date format: "Jun 28, 2026".
function formatTakenAt(takenAt: string | null | undefined): string {
  if (!takenAt) return "Unknown";
  const d = new Date(takenAt);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatCommentWhen(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const seconds = (Date.now() - d.getTime()) / 1000;
  if (seconds < 60) return "just now";
  return d.toLocaleString();
}

// ---- Deterministic per-photo mocks for fields the backend doesn't expose
// yet (AI tags, file size, video duration) - same posture as
// lib/v2/featureFlags.ts: real UI, local fallback data, swap for the API
// field once it exists. Hash-of-id keeps a photo's tags/size stable across
// opens instead of reshuffling every render. ----
const TAG_POOL = [
  "sunset", "mountains", "alpenglow", "dusk", "ridge", "water", "fjord",
  "desert", "warm", "forest", "green", "morning", "night", "stars",
  "sunrise", "golden", "cold", "ice",
];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function mockTags(id: string): string[] {
  const h = hashId(id);
  return [0, 1, 2].map((k) => TAG_POOL[(h + k * 5) % TAG_POOL.length]);
}

function mockSize(id: string): string {
  const h = hashId(id);
  return `${(15 + (h % 130) / 10).toFixed(1)} MB`;
}

function mockDuration(id: string): string {
  return ["0:42", "1:15", "0:28"][hashId(id) % 3];
}
