"use client";

// v2 Search - the design's "describe the photo you remember" hero, backed
// by the real GET /api/search (a filename-substring filter, not actual
// semantic search - the backend may grow that later). Matches the design:
// results recompute live as you type, quoted suggestion chips fill the box,
// "Recently added" (8 photos) shows when the box is empty, the Search
// button just toasts the match count, and empty results get the dashed
// "Nothing matches that memory" card with accent suggestion chips.

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FolderPhoto, searchApi } from "@/lib/api";
import { PhotoViewerV2, type ViewerOrigin, type ViewerPhotoRef } from "@/components/v2/PhotoViewerV2";
import { SkeletonTiles } from "@/components/v2/SkeletonGrid";
import { useIsMobile } from "@/components/v2/useIsMobile";
import { useToast } from "@/components/v2/ToastProviderV2";

// Design shows the first 8 library photos under "Recently added" when the
// search box is empty.
const RECENT_LIMIT = 8;
// The design lists every match with no pager; one generous page stands in
// until the backend needs true paging here.
const MATCH_LIMIT = 100;
const SUGGESTIONS = ["warm sunset", "water", "night", "green", "desert"];

// useSearchParams() must sit inside a Suspense boundary in the Next 14 App
// Router (it opts the subtree into client-side rendering) - same pattern as
// v2 Browse's ?folder= deep link.
export default function SearchV2Page() {
  return (
    <Suspense fallback={null}>
      <SearchV2Inner />
    </Suspense>
  );
}

function SearchV2Inner() {
  const searchParams = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";
  const isMobile = useIsMobile();
  const showToast = useToast();

  const [q, setQ] = useState(initialQ);
  const [photos, setPhotos] = useState<FolderPhoto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [viewerOrigin, setViewerOrigin] = useState<ViewerOrigin | null>(null);

  const requestIdRef = useRef(0);
  const trimmedQ = q.trim();

  // Live search, like the design's onQ - debounced slightly so each
  // keystroke doesn't fire its own request.
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const timer = setTimeout(
      async () => {
        setLoading(true);
        setError(null);
        try {
          const res = await searchApi.search({
            q: trimmedQ || undefined,
            limit: trimmedQ ? MATCH_LIMIT : RECENT_LIMIT,
            offset: 0,
          });
          if (requestId !== requestIdRef.current) return;
          setPhotos(res.photos);
          setTotal(res.total);
        } catch (err) {
          if (requestId !== requestIdRef.current) return;
          setError(err instanceof Error ? err.message : "Search failed");
          setPhotos([]);
          setTotal(0);
        } finally {
          if (requestId === requestIdRef.current) setLoading(false);
        }
      },
      trimmedQ ? 250 : 0
    );
    return () => clearTimeout(timer);
  }, [trimmedQ]);

  const searchEmpty = !!trimmedQ && !loading && !error && photos.length === 0;
  const searchLabel = trimmedQ ? `${total} matches for “${trimmedQ}”` : "Recently added";

  const viewerPhotos: ViewerPhotoRef[] = photos.map((p) => ({
    id: p.id,
    originalFilename: p.originalFilename,
    status: p.status,
    duplicateOfLabel: null,
    thumbSrc: p.thumbnailUrl,
  }));

  return (
    <div className="ps2-content" style={{ maxWidth: 1100, paddingTop: 44 }}>
      <style>{`
        .ps2x-sugg:hover{border-color:var(--ps2-accent);color:var(--ps2-accent)}
        .ps2x-sugg-accent:hover{border-color:var(--ps2-accent);background:color-mix(in oklab, var(--ps2-accent) 10%, transparent)}
        .ps2x-search-tile{transition:transform .3s}
        .ps2x-search-tile:hover{transform:scale(1.03)}
      `}</style>
      <div className="ps2-search-hero" style={{ paddingTop: 0 }}>
        <div className="ps2-search-eyebrow">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l2.1 6.4L21 10l-6.4 2.1L12 19l-2.1-6.9L3 10l6.9-1.6L12 2z" />
          </svg>
          Semantic search
        </div>
        <h1 className="ps2-search-title" style={{ fontSize: 38 }}>
          Describe the photo you remember.
        </h1>

        <form
          className="ps2-search-pill-form"
          onSubmit={(e) => {
            e.preventDefault();
            showToast(`${total}${total === 1 ? " match found" : " matches found"}`);
          }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--ps2-muted)" strokeWidth="2" strokeLinecap="round" style={{ flex: "none" }}>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            className="ps2-search-pill-input"
            type="text"
            placeholder="warm sunset over water, last spring…"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            style={{ fontSize: 16, padding: "12px 0" }}
          />
          <button type="submit" className="ps2-search-pill-btn" style={{ padding: "12px 22px", fontSize: 14, borderRadius: 13 }}>
            Search
          </button>
        </form>

        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}>
          {SUGGESTIONS.map((label) => (
            <button
              key={label}
              type="button"
              className="ps2x-sugg"
              onClick={() => setQ(label)}
              style={{
                borderRadius: 99,
                border: "1px dashed var(--ps2-border)",
                background: "transparent",
                color: "var(--ps2-muted)",
                padding: "7px 14px",
                fontSize: 12.5,
                fontFamily: "inherit",
                cursor: "pointer",
                transition: "all .25s",
              }}
            >
              {"“"}
              {label}
              {"”"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 38 }}>
        {!loading && !error && (
          <div style={{ fontSize: 13, color: "var(--ps2-muted)", marginBottom: 14 }}>{searchLabel}</div>
        )}

        {loading && <SkeletonTiles count={8} />}
        {error && !loading && <p className="ps2-error">{error}</p>}

        {searchEmpty && (
          <div
            style={{
              borderRadius: 20,
              border: "1.5px dashed var(--ps2-border)",
              padding: "46px 30px",
              textAlign: "center",
              color: "var(--ps2-muted)",
              marginBottom: 14,
            }}
          >
            <div style={{ fontFamily: "var(--ps2-font-serif)", fontStyle: "italic", fontSize: 22, color: "var(--ps2-text)", marginBottom: 8 }}>
              Nothing matches that memory — yet.
            </div>
            <div style={{ fontSize: 13, marginBottom: 16 }}>Try one of these instead:</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              {SUGGESTIONS.map((label) => (
                <button
                  key={label}
                  type="button"
                  className="ps2x-sugg-accent"
                  onClick={() => setQ(label)}
                  style={{
                    borderRadius: 99,
                    border: "1px dashed color-mix(in oklab, var(--ps2-accent) 45%, var(--ps2-border))",
                    background: "transparent",
                    color: "var(--ps2-accent)",
                    padding: "7px 14px",
                    fontSize: 12.5,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    transition: "all .25s",
                  }}
                >
                  {"“"}
                  {label}
                  {"”"}
                </button>
              ))}
            </div>
          </div>
        )}

        {!loading && !error && photos.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2,1fr)" : "repeat(4,1fr)", gap: 12 }}>
            {photos.map((photo, i) => (
              <button
                key={photo.id}
                type="button"
                className="ps2x-search-tile"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setViewerOrigin({ rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }, src: photo.thumbnailUrl });
                  setViewerIndex(i);
                }}
                style={{
                  position: "relative",
                  borderRadius: 14,
                  overflow: "hidden",
                  cursor: "pointer",
                  aspectRatio: "4/3",
                  background: "var(--ps2-tile)",
                  border: "none",
                  padding: 0,
                  display: "block",
                  width: "100%",
                }}
              >
                {photo.thumbnailUrl && (
                  <img src={photo.thumbnailUrl} alt={photo.originalFilename} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                )}
                {photo.aiLabels[0] && (
                  <span style={{ position: "absolute", left: 10, bottom: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10.5, background: "rgba(6,7,12,.6)", backdropFilter: "blur(8px)", color: "#f4f5f8", borderRadius: 99, padding: "3px 9px" }}>
                      {photo.aiLabels[0]}
                    </span>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {viewerIndex !== null && (
        <PhotoViewerV2
          photos={viewerPhotos}
          index={viewerIndex}
          origin={viewerOrigin}
          onIndexChange={setViewerIndex}
          onClose={() => {
            setViewerIndex(null);
            setViewerOrigin(null);
          }}
        />
      )}
    </div>
  );
}
