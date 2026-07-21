"use client";

// A real 360° globe (react-globe.gl, built on three.js/WebGL). Exposes an
// imperative handle (zoom in/out, set/get altitude, locate, reset) so the
// Places page can drive it from its own "World View" chrome (zoom slider,
// Locate Me button, reset) instead of only the globe's built-in gestures.
// Loaded via next/dynamic with ssr:false from the Places page - three.js
// touches `window`/WebGL at import time and breaks server rendering
// otherwise.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import type { Object3D } from "three";

export type MapPin = {
  key: string;
  lat: number;
  lng: number;
  count: number;
  color: string;
  size: number;
  thumbSrc: string | null;
};

export type PlacesMapHandle = {
  getAltitude: () => number;
  setAltitude: (altitude: number) => void;
  locate: (lat: number, lng: number) => void;
  reset: () => void;
};

export const ALTITUDE_MIN = 0.55;
export const ALTITUDE_MAX = 2.5;
const DEFAULT_VIEW = { lat: 20, lng: 0, altitude: 1.7 };

function pinElement(pin: MapPin, onClick: (key: string) => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "ps2-places-globe-pin";
  el.style.width = `${pin.size}px`;
  el.innerHTML = `
    <span class="ps2-places-pin-badge" style="width:${pin.size}px;height:${pin.size}px">${pin.count}</span>
    <span class="ps2-places-pin-dot"></span>
  `;
  el.onclick = (e) => {
    e.stopPropagation();
    onClick(pin.key);
  };
  return el;
}

const PlacesMap = forwardRef<
  PlacesMapHandle,
  {
    pins: MapPin[];
    onPinClick: (key: string) => void;
    onAltitudeChange?: (altitude: number) => void;
    onInteractionStart?: () => void;
  }
>(function PlacesMap({ pins, onPinClick, onAltitudeChange, onInteractionStart }, forwardedRef) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // react-globe.gl's ref sizing needs the actual pixel box, not just "100%" -
  // the flex/grid layout above it doesn't give a natural width to a canvas.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Callback props close over stale values at mount time otherwise - refs
  // keep them current for the DOM-event listeners registered once on ready.
  const clickRef = useRef(onPinClick);
  clickRef.current = onPinClick;
  const altitudeChangeRef = useRef(onAltitudeChange);
  altitudeChangeRef.current = onAltitudeChange;
  const interactionStartRef = useRef(onInteractionStart);
  interactionStartRef.current = onInteractionStart;

  const htmlElementsData = useMemo(() => pins, [pins]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      getAltitude: () => globeRef.current?.pointOfView().altitude ?? DEFAULT_VIEW.altitude,
      setAltitude: (altitude) => {
        const globe = globeRef.current;
        if (!globe) return;
        const current = globe.pointOfView();
        globe.pointOfView({ lat: current.lat, lng: current.lng, altitude }, 0);
      },
      locate: (lat, lng) => {
        globeRef.current?.pointOfView({ lat, lng, altitude: 0.5 }, 900);
      },
      reset: () => {
        globeRef.current?.pointOfView(DEFAULT_VIEW, 900);
      },
    }),
    [],
  );

  function handleGlobeReady() {
    const globe = globeRef.current;
    if (!globe) return;
    // Closer default framing than the library's default (~2.5) so the
    // globe reads as "big" inside the card right away.
    globe.pointOfView(DEFAULT_VIEW);

    // The globe is one fixed 4096x2048 texture wrapped on a sphere, not
    // satellite map tiles that swap in higher-detail imagery as you zoom
    // (that's how Google/Apple Maps stay sharp up close) - there's a hard
    // ceiling on how sharp this can look no matter the zoom level. These two
    // adjustments get it as close as this approach allows: render at the
    // display's actual device pixel ratio instead of a possibly-lower
    // default, and max out anisotropic filtering so the texture stays crisp
    // at the oblique viewing angles the globe's curve constantly creates.
    const renderer = globe.renderer();
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    globe.scene().traverse((obj: Object3D) => {
      const material = (obj as unknown as { material?: { map?: { anisotropy: number; needsUpdate: boolean } } }).material;
      if (material?.map) {
        material.map.anisotropy = maxAnisotropy;
        material.map.needsUpdate = true;
      }
    });

    const controls = globe.controls();
    if (!controls) return;
    // 360° spin, gentle enough to still read the pins while it turns.
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.6;
    controls.enableZoom = true;
    // Pinch/scroll zoom goes straight through OrbitControls, not our own
    // pointOfView() calls - without a matching distance clamp here it could
    // zoom in far past ALTITUDE_MIN (three-globe's own default min distance
    // is tiny), well past the point the fixed-resolution texture holds up,
    // which is what was actually causing the severe blur on pinch-zoom.
    // GLOBE_RADIUS matches three-globe's internal constant; altitude is
    // camera distance expressed as a multiple of that radius.
    const GLOBE_RADIUS = 100;
    controls.minDistance = GLOBE_RADIUS * (1 + ALTITUDE_MIN);
    controls.maxDistance = GLOBE_RADIUS * (1 + ALTITUDE_MAX);
    // OrbitControls fires "start" for both drag-rotate and pinch/wheel-zoom,
    // and "change" continuously while either is happening - one pair of
    // listeners covers the zoom-slider sync and the gesture-hint fade.
    controls.addEventListener("start", () => interactionStartRef.current?.());
    // autoRotate alone fires "change" every animation frame even though only
    // lat/lng is moving - altitude's floating-point recompute from the
    // camera distance still drifts by a hair each frame. Only forward real
    // zoom changes upstream, or the parent re-renders (and this component's
    // pins array gets rebuilt) 60 times a second for no reason.
    let lastAltitude = DEFAULT_VIEW.altitude;
    controls.addEventListener("change", () => {
      const altitude = globeRef.current?.pointOfView().altitude;
      if (altitude == null || Math.abs(altitude - lastAltitude) < 0.002) return;
      lastAltitude = altitude;
      altitudeChangeRef.current?.(altitude);
    });

    const canvas = wrapRef.current?.querySelector("canvas");
    if (!canvas) return;

    // Double-click/double-tap zooms in one step toward the tapped point -
    // separate from the single-click zoom (onGlobeClick below), which is
    // its own explicitly-requested "tap anywhere to zoom in" behavior; a
    // double-click still fires two of those plus this, compounding into a
    // bigger zoom, which reads fine as "double tap zooms in further".
    canvas.addEventListener("dblclick", (e) => {
      const coords = globeRef.current?.toGlobeCoords(e.offsetX, e.offsetY);
      if (!coords) return;
      const current = globeRef.current?.pointOfView();
      if (!current) return;
      const nextAltitude = Math.max(ALTITUDE_MIN, current.altitude * 0.55);
      globeRef.current?.pointOfView({ ...coords, altitude: nextAltitude }, 500);
    });

    // Two-finger tap (both fingers down and up quickly, without moving far
    // enough to read as a pinch) zooms out one step - the inverse of the
    // single-tap-to-zoom-in gesture above.
    let twoFingerTap: { time: number; touches: [{ x: number; y: number }, { x: number; y: number }] } | null = null;
    const TAP_MAX_MS = 300;
    const TAP_MAX_MOVE = 12;
    canvas.addEventListener("touchstart", (e: TouchEvent) => {
      if (e.touches.length !== 2) {
        twoFingerTap = null;
        return;
      }
      const [a, b] = [e.touches[0], e.touches[1]];
      twoFingerTap = { time: Date.now(), touches: [{ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }] };
    });
    canvas.addEventListener("touchmove", (e: TouchEvent) => {
      if (!twoFingerTap || e.touches.length !== 2) return;
      const [a, b] = [e.touches[0], e.touches[1]];
      const moved = [a, b].some((t, i) => {
        const start = twoFingerTap!.touches[i];
        return Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_MAX_MOVE;
      });
      if (moved) twoFingerTap = null;
    });
    canvas.addEventListener("touchend", () => {
      if (!twoFingerTap) return;
      const tap = twoFingerTap;
      twoFingerTap = null;
      if (Date.now() - tap.time > TAP_MAX_MS) return;
      const current = globeRef.current?.pointOfView();
      if (!current) return;
      const nextAltitude = Math.min(ALTITUDE_MAX, current.altitude / 0.55);
      globeRef.current?.pointOfView({ lat: current.lat, lng: current.lng, altitude: nextAltitude }, 500);
    });
  }

  // Clicking the globe's surface (not a pin) zooms in on that spot, one step
  // closer each click; a min altitude keeps it from clipping into the globe.
  function handleGlobeClick({ lat, lng }: { lat: number; lng: number }) {
    const globe = globeRef.current;
    if (!globe) return;
    const current = globe.pointOfView();
    const nextAltitude = Math.max(ALTITUDE_MIN, current.altitude * 0.55);
    globe.pointOfView({ lat, lng, altitude: nextAltitude }, 700);
  }

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%" }}>
      {size.width > 0 && size.height > 0 && (
        <Globe
          ref={globeRef}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          globeImageUrl="https://unpkg.com/three-globe/example/img/earth-night.jpg"
          bumpImageUrl="https://unpkg.com/three-globe/example/img/earth-topology.png"
          showAtmosphere
          atmosphereColor="#7fa8e8"
          atmosphereAltitude={0.22}
          htmlElementsData={htmlElementsData}
          htmlLat={(d) => (d as MapPin).lat}
          htmlLng={(d) => (d as MapPin).lng}
          htmlAltitude={0.01}
          htmlElement={(d) => pinElement(d as MapPin, (key) => clickRef.current(key))}
          onGlobeReady={handleGlobeReady}
          onGlobeClick={handleGlobeClick}
        />
      )}
    </div>
  );
});

export default PlacesMap;
