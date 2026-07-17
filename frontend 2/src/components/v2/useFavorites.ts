"use client";

import { useCallback, useEffect, useState } from "react";
import { readLocal, writeLocal } from "@/lib/v2/localStore";

// Favorites has no backing endpoint or field on the backend (see
// featureFlags.ts) - hearted photo ids are kept in localStorage, real and
// functional per-browser, just not synced across devices.
const STORAGE_KEY = "ps2_favorites";

export function useFavorites() {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setIds(new Set(readLocal<string[]>(STORAGE_KEY, [])));
  }, []);

  const isFavorite = useCallback((photoId: string) => ids.has(photoId), [ids]);

  const toggleFavorite = useCallback((photoId: string) => {
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      writeLocal(STORAGE_KEY, Array.from(next));
      return next;
    });
  }, []);

  return { favoriteIds: ids, isFavorite, toggleFavorite };
}
