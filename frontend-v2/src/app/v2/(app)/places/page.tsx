"use client";

// v2 Places - GPS coordinates only exist on the single-photo detail
// endpoint (PhotoDetail.exif.gpsLat/gpsLng), not the list/grid response -
// see lib/v2/featureFlags.ts's placesGpsList. This fetches the library then
// one photosApi.get() per photo to find real coordinates - an accepted N+1
// cost for a personal-library-sized collection, not something that scales
// to tens of thousands of photos without the backend adding those fields
// to the list response.
//
// Real map: Leaflet + CARTO's free no-key "dark matter" tiles (see
// components/v2/PlacesMap.tsx), with pins placed at their real lat/lng.
// Pin accent colors and sizes still cycle like the original design. Clicking
// a pin (or a mobile list row) opens that cluster's photos in the viewer -
// the design's pins jump to a filtered Browse chip, but these clusters have
// no backend filter to link to yet.

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ApiError, FolderPhoto, photosApi, searchApi } from "@/lib/api";
import { PhotoViewerV2, type ViewerPhotoRef } from "@/components/v2/PhotoViewerV2";
import { useIsMobile } from "@/components/v2/useIsMobile";
import { ALTITUDE_MAX, ALTITUDE_MIN, type MapPin, type PlacesMapHandle } from "@/components/v2/PlacesMap";

// three.js touches `window`/WebGL at import time - load it only on the client.
const PlacesMap = dynamic(() => import("@/components/v2/PlacesMap"), { ssr: false });

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

export default function PlacesV2Page() {
  const isMobile = useIsMobile();
  const [pins, setPins] = useState<PlacePin[]>([]);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const mapRef = useRef<PlacesMapHandle>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [altitude, setAltitude] = useState(1.7);
  const [showHint, setShowHint] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showLegendPopover, setShowLegendPopover] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === cardRef.current);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

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

  // Referentially stable across re-renders (e.g. the zoom-slider's altitude
  // updates) - react-globe.gl rebuilds every pin's DOM element whenever this
  // array's identity changes, which is expensive at 60fps if it were
  // recomputed on every render instead of only when the pins themselves do.
  const mapPins: MapPin[] = useMemo(
    () =>
      pins.map((pin, i) => ({
        key: pin.key,
        lat: pin.lat,
        lng: pin.lng,
        count: pin.photos.length,
        color: PIN_COLORS[i % PIN_COLORS.length],
        size: i % 3 === 0 ? 58 : 52,
        thumbSrc: pin.photos[0].thumbnailUrl,
      })),
    [pins],
  );

  function openPin(key: string) {
    setSelectedKey(key);
    setViewerIndex(0);
  }

  // Slider shows "zoomed in" increasing to the right - altitude decreases
  // as you zoom in, so the mapping is inverted.
  const zoomPercent = Math.round(((ALTITUDE_MAX - altitude) / (ALTITUDE_MAX - ALTITUDE_MIN)) * 100);

  function setZoomPercent(percent: number) {
    const clamped = Math.min(100, Math.max(0, percent));
    const nextAltitude = ALTITUDE_MAX - (clamped / 100) * (ALTITUDE_MAX - ALTITUDE_MIN);
    mapRef.current?.setAltitude(nextAltitude);
    setAltitude(nextAltitude);
  }

  function handleLocateMe() {
    setLocateError(null);
    if (!navigator.geolocation) {
      setLocateError("Location isn't available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => mapRef.current?.locate(pos.coords.latitude, pos.coords.longitude),
      () => setLocateError("Couldn't get your location."),
      { timeout: 8000 },
    );
  }

  function handleReset() {
    mapRef.current?.reset();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      cardRef.current?.requestFullscreen();
    }
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
      {error && <p className="ps2-error">{error}</p>}

      {loading ? (
        <div className="ps2-skeleton" style={{ height: isMobile ? 300 : 440, borderRadius: 28 }} />
      ) : (
        <>
          <div className="ps2-globe-card" ref={cardRef}>
            <div className="ps2-globe-header">
              <span className="ps2-globe-header-icon">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" />
                </svg>
              </span>
              <span className="ps2-globe-header-text">
                <span className="ps2-globe-header-title">World View</span>
                <span className="ps2-globe-header-sub">Explore where your photos were taken.</span>
              </span>
            </div>

            <div className="ps2-globe-top-right">
              <button type="button" className="ps2-globe-locate-btn" onClick={handleLocateMe}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                </svg>
                Locate Me
              </button>
              <button type="button" className="ps2-globe-fullscreen-btn" onClick={toggleFullscreen} aria-label={isFullscreen ? "Exit full screen" : "Full screen"}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {isFullscreen ? (
                    <path d="M9 3v4a2 2 0 0 1-2 2H3M15 3v4a2 2 0 0 0 2 2h4M9 21v-4a2 2 0 0 0-2-2H3M15 21v-4a2 2 0 0 1 2-2h4" />
                  ) : (
                    <path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4" />
                  )}
                </svg>
              </button>
              {locateError && <span className="ps2-globe-locate-error">{locateError}</span>}
            </div>

            <div className="ps2-globe-zoom-control">
              <button type="button" onClick={() => setZoomPercent(zoomPercent + 12)} aria-label="Zoom in">
                +
              </button>
              <input
                type="range"
                className="ps2-globe-zoom-slider"
                min={0}
                max={100}
                value={zoomPercent}
                onChange={(e) => setZoomPercent(Number(e.target.value))}
                aria-label="Zoom"
              />
              <button type="button" onClick={() => setZoomPercent(zoomPercent - 12)} aria-label="Zoom out">
                &minus;
              </button>
            </div>

            <button type="button" className="ps2-globe-reset-btn" onClick={handleReset} aria-label="Reset view">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7M3 3v5h5" />
              </svg>
            </button>

            <div className="ps2-globe-stage">
              <PlacesMap
                ref={mapRef}
                pins={mapPins}
                onPinClick={openPin}
                onAltitudeChange={setAltitude}
                onInteractionStart={() => setShowHint(false)}
              />
            </div>

            <div className="ps2-globe-status-card">
              <span className="ps2-globe-status-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="6" width="18" height="14" rx="2" />
                  <path d="m3 16 5-5 4 4 5-5 4 4" />
                </svg>
              </span>
              {pins.length === 0 ? (
                <span className="ps2-globe-status-text">
                  <span className="ps2-globe-status-title">{scanned} photo{scanned === 1 ? "" : "s"} scanned</span>
                  <span className="ps2-globe-status-sub">No location data found yet.</span>
                </span>
              ) : (
                <span className="ps2-globe-status-text">
                  <span className="ps2-globe-status-title">{totalLocated} photo{totalLocated === 1 ? "" : "s"} mapped</span>
                  <span className="ps2-globe-status-sub">Across {pins.length} location{pins.length === 1 ? "" : "s"}</span>
                </span>
              )}
            </div>

            {showHint && (
              <div className="ps2-globe-hint">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11.5V6a1.5 1.5 0 0 1 3 0v5M12 6a1.5 1.5 0 0 1 3 0v5M15 6.5a1.5 1.5 0 0 1 3 0V13M9 12l-1.6-1.6a1.4 1.4 0 0 0-2 2L9 16c1 1.5 2 2 4 2h2a4 4 0 0 0 4-4v-3.5" />
                </svg>
                Pinch to zoom &middot; Drag to rotate
              </div>
            )}

            <div className="ps2-globe-legend">
              <span className="ps2-globe-legend-dot" />
              <span className="ps2-globe-legend-text">
                <span>Photo clusters</span>
                <span className="ps2-globe-legend-sub">Number of photos</span>
              </span>
            </div>

            <button
              type="button"
              className="ps2-globe-info-btn"
              onClick={() => setShowLegendPopover((v) => !v)}
              aria-label="Legend"
            >
              i
            </button>
            {showLegendPopover && (
              <div className="ps2-globe-legend ps2-globe-legend--popover">
                <span className="ps2-globe-legend-dot" />
                <span className="ps2-globe-legend-text">
                  <span>Photo clusters</span>
                  <span className="ps2-globe-legend-sub">Number of photos</span>
                </span>
              </div>
            )}
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
