"use client";

// Pull-to-refresh gesture (mobile only in practice - these are touch events,
// inert on a desktop mouse). Only starts when the page is scrolled all the
// way to the top, matching the native gesture; the visual pull distance is
// damped (0.5x) and capped so it never feels like it's chasing your finger
// off past a sane point.

import { useRef, useState, type TouchEvent } from "react";

const MAX_PULL = 80;
const THRESHOLD = 64;

export function usePullToRefresh(onRefresh: () => Promise<void> | void) {
  const [pullY, setPullY] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startYRef = useRef<number | null>(null);
  const rawDeltaRef = useRef(0);

  function onTouchStart(e: TouchEvent) {
    if (refreshing || window.scrollY > 0 || e.touches.length !== 1) return;
    startYRef.current = e.touches[0].clientY;
  }

  function onTouchMove(e: TouchEvent) {
    if (startYRef.current == null || refreshing) return;
    if (window.scrollY > 0) {
      startYRef.current = null;
      setPullY(0);
      return;
    }
    const delta = e.touches[0].clientY - startYRef.current;
    if (delta <= 0) {
      setPullY(0);
      return;
    }
    rawDeltaRef.current = delta;
    setPullY(Math.min(MAX_PULL, delta * 0.5));
  }

  async function onTouchEnd() {
    if (startYRef.current == null) return;
    startYRef.current = null;
    const triggered = rawDeltaRef.current >= THRESHOLD;
    rawDeltaRef.current = 0;
    if (!triggered) {
      setPullY(0);
      return;
    }
    setRefreshing(true);
    setPullY(MAX_PULL);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
      setPullY(0);
    }
  }

  return { pullY, refreshing, handlers: { onTouchStart, onTouchMove, onTouchEnd } };
}
