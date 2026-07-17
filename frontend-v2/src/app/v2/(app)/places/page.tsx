"use client";

// v2 Places - GPS coordinates only exist on the single-photo detail
// endpoint (PhotoDetail.exif.gpsLat/gpsLng), not the list/grid response -
// see lib/v2/featureFlags.ts's placesGpsList. This fetches the library then
// one photosApi.get() per photo to find real coordinates - an accepted N+1
// cost for a personal-library-sized collection, not something that scales
// to tens of thousands of photos without the backend adding those fields
// to the list response.
//
// No real map/tiles/API key - the design's stylized non-interactive map
// (radial background, faint grid, glow blobs), with pins placed by a simple
// equirectangular projection of the real lat/lng. Pin accent colors and
// sizes cycle like the design's. Clicking a pin (or a mobile list row)
// opens that cluster's photos in the viewer - the design's pins jump to a
// filtered Browse chip, but these clusters have no backend filter to link
// to yet.

import { useEffect, useState } from "react";
import { ApiError, FolderPhoto, photosApi, searchApi } from "@/lib/api";
import { PhotoViewerV2, type ViewerPhotoRef } from "@/components/v2/PhotoViewerV2";
import { useIsMobile } from "@/components/v2/useIsMobile";

// Backend caps list limits at 100 (values above fail validation).
const LIBRARY_FETCH_LIMIT = 100;

// The design cycles pin accent colors (accent, purple, teal, amber) and
// alternates pin sizes. Purple stands in for the old "blue" slot now that
// the primary accent itself is blue - keeps all four pins distinguishable.
const PIN_COLORS = ["var(--ps2-accent)", "#b06bc0", "#7fd8c8", "#e8a15c"];

type PlacePin = {
  key: string;
  lat: number;
  lng: number;
  photos: FolderPhoto[];
};

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

// ~11km grid - close enough that photos from the same outing/city cluster
// into one pin, coarse enough that GPS jitter doesn't split them apart.
function clusterKey(lat: number, lng: number): string {
  return `${lat.toFixed(1)},${lng.toFixed(1)}`;
}

function pinPosition(lat: number, lng: number): { left: string; top: string } {
  return {
    left: `${((lng + 180) / 360) * 100}%`,
    top: `${((90 - lat) / 180) * 100}%`,
  };
}

export default function PlacesV2Page() {
  const isMobile = useIsMobile();
  const [pins, setPins] = useState<PlacePin[]>([]);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await searchApi.search({ limit: LIBRARY_FETCH_LIMIT, offset: 0 });
        if (cancelled) return;
        const details = await Promise.all(res.photos.map((p) => photosApi.get(p.id).catch(() => null)));
        if (cancelled) return;

        const clusters = new Map<string, PlacePin>();
        res.photos.forEach((p, i) => {
          const d = details[i];
          if (!d || d.exif.gpsLat == null || d.exif.gpsLng == null) return;
          const key = clusterKey(d.exif.gpsLat, d.exif.gpsLng);
          const existing = clusters.get(key);
          if (existing) existing.photos.push(p);
          else clusters.set(key, { key, lat: d.exif.gpsLat, lng: d.exif.gpsLng, photos: [p] });
        });
        setPins(Array.from(clusters.values()));
        setScanned(res.photos.length);
      } catch (err) {
        if (cancelled) return;
        if (isAuthError(err)) return;
        setError(err instanceof Error ? err.message : "Failed to load places");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedPin = pins.find((p) => p.key === selectedKey) ?? null;
  const totalLocated = pins.reduce((sum, p) => sum + p.photos.length, 0);

  function openPin(key: string) {
    setSelectedKey(key);
    setViewerIndex(0);
  }

  const viewerPhotos: ViewerPhotoRef[] = (selectedPin?.photos ?? []).map((p) => ({
    id: p.id,
    originalFilename: p.originalFilename,
    status: p.status,
    duplicateOfLabel: null,
    thumbSrc: p.thumbnailUrl,
  }));

  return (
    <div className="ps2-content" style={{ paddingTop: 38 }}>
      <h1 className="ps2-browse-title">Places</h1>
      <div style={{ fontSize: 14, color: "var(--ps2-muted)", margin: "8px 0 26px" }}>Your photos, pinned where they happened.</div>

      {error && <p className="ps2-error">{error}</p>}

      {loading ? (
        <div className="ps2-skeleton" style={{ height: isMobile ? 300 : 520, borderRadius: 24 }} />
      ) : (
        <>
          <div className="ps2-places-map">
            <div
              style={{
                position: "absolute",
                left: "12%",
                top: "18%",
                width: "34%",
                height: "44%",
                borderRadius: "50%",
                background: "radial-gradient(closest-side, color-mix(in oklab, var(--ps2-accent) 7%, transparent), transparent)",
                filter: "blur(10px)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: "58%",
                top: "40%",
                width: "30%",
                height: "40%",
                borderRadius: "50%",
                background: "radial-gradient(closest-side, rgba(127,168,232,.08), transparent)",
                filter: "blur(10px)",
              }}
            />
            {pins.map((pin, i) => {
              const cover = pin.photos[0];
              const pos = pinPosition(pin.lat, pin.lng);
              const color = PIN_COLORS[i % PIN_COLORS.length];
              const size = i % 3 === 0 ? 58 : 52;
              return (
                <button
                  type="button"
                  key={pin.key}
                  className="ps2-places-pin"
                  style={{ left: pos.left, top: pos.top }}
                  onClick={() => openPin(pin.key)}
                >
                  <span className="ps2-places-pin-photo" style={{ width: size, height: size, borderColor: color }}>
                    {cover.thumbnailUrl && <img src={cover.thumbnailUrl} alt="" />}
                    <span className="ps2-places-pin-count" style={{ background: color }}>
                      {pin.photos.length}
                    </span>
                  </span>
                  <span className="ps2-places-pin-label">
                    {pin.lat.toFixed(2)}, {pin.lng.toFixed(2)}
                  </span>
                </button>
              );
            })}
            <div className="ps2-places-map-caption">
              {pins.length === 0
                ? `Scanned ${scanned} photo${scanned === 1 ? "" : "s"} - none had GPS data yet.`
                : `${pins.length} place${pins.length === 1 ? "" : "s"} · ${totalLocated} photo${totalLocated === 1 ? "" : "s"} located by AI`}
            </div>
          </div>

          {/* Pins can sit too close together to tap reliably on a narrow
              screen - a tappable list of the same real clusters underneath
              the map, matching the design's mobile fallback. */}
          {isMobile && pins.length > 0 && (
            <div className="ps2-places-list">
              {pins.map((pin) => {
                const cover = pin.photos[0];
                return (
                  <button type="button" key={pin.key} className="ps2-places-list-row" onClick={() => openPin(pin.key)}>
                    <span className="ps2-places-list-photo">{cover.thumbnailUrl && <img src={cover.thumbnailUrl} alt="" />}</span>
                    <span className="ps2-places-list-text">
                      <span className="ps2-places-list-coords">
                        {pin.lat.toFixed(2)}, {pin.lng.toFixed(2)}
                      </span>
                      <span className="ps2-places-list-count">
                        {pin.photos.length} photo{pin.photos.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ps2-muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {viewerIndex !== null && selectedPin && (
        <PhotoViewerV2
          photos={viewerPhotos}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </div>
  );
}
