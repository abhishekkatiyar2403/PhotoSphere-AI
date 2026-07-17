"use client";

import { useCallback, useEffect, useState } from "react";
import { readLocal, writeLocal } from "@/lib/v2/localStore";
import { FEATURE_FLAGS } from "@/lib/v2/featureFlags";

// Photo rename has no backing endpoint yet (see featureFlags.ts) - renamed
// titles are kept in localStorage keyed by photo id, real and functional
// per-browser (survives reload), just not synced across devices. Once
// FEATURE_FLAGS.photoRename flips on, swap the `renameLocal` call below for
// the real photosApi.rename(id, title) PATCH.
const STORAGE_KEY = "ps2_photo_renames";

export function usePhotoRename() {
  const [renames, setRenames] = useState<Record<string, string>>({});

  useEffect(() => {
    setRenames(readLocal<Record<string, string>>(STORAGE_KEY, {}));
  }, []);

  const titleFor = useCallback((photoId: string, fallback: string) => renames[photoId] ?? fallback, [renames]);

  const rename = useCallback(async (photoId: string, title: string) => {
    if (FEATURE_FLAGS.photoRename) {
      // Real endpoint not wired yet - flip this on once
      // photosApi.rename(photoId, title) exists and call it here instead.
      return;
    }
    setRenames((prev) => {
      const next = { ...prev, [photoId]: title };
      writeLocal(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { titleFor, rename };
}
