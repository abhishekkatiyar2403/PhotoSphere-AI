"use client";

import { useCallback, useEffect, useState } from "react";
import { readLocal, writeLocal } from "@/lib/v2/localStore";
import { FEATURE_FLAGS } from "@/lib/v2/featureFlags";

export type PhotoComment = { by: string; text: string; at: string };

// Comments have no backing endpoint yet (see featureFlags.ts) - threads are
// kept in localStorage keyed by photo id, real and functional per-browser,
// just not synced across devices/guests. Once FEATURE_FLAGS.comments flips
// on, swap the local read/write below for real commentsApi.list/create
// calls against the photo id.
const STORAGE_KEY = "ps2_photo_comments";

export function usePhotoComments(photoId: string | null) {
  const [all, setAll] = useState<Record<string, PhotoComment[]>>({});

  useEffect(() => {
    setAll(readLocal<Record<string, PhotoComment[]>>(STORAGE_KEY, {}));
  }, []);

  const comments = photoId ? (all[photoId] ?? []) : [];

  const postComment = useCallback(
    (by: string, text: string) => {
      if (!photoId || !text.trim()) return;
      if (FEATURE_FLAGS.comments) {
        // Real endpoint not wired yet - flip this on once
        // commentsApi.create(photoId, text) exists and call it here instead.
        return;
      }
      setAll((prev) => {
        const next = { ...prev, [photoId]: [...(prev[photoId] ?? []), { by, text: text.trim(), at: new Date().toISOString() }] };
        writeLocal(STORAGE_KEY, next);
        return next;
      });
    },
    [photoId],
  );

  return { comments, postComment };
}
