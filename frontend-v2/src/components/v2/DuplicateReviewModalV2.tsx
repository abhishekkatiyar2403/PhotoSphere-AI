"use client";

// "Review duplicates" modal, matching the original prototype's dialog
// exactly (640px, 2-column 4:3 compare, "Keep this one" x2, "Keep both" /
// "Finish later"). Real data throughout - status === "duplicate" and
// duplicateOfPhotoId are real backend fields (same ones Organize already
// reads); "Keep this one" is a genuine photosApi.remove (soft-delete to
// Trash). No invented "X MB freed" claim anywhere - the backend has no
// file-size field, so this only ever states real counts.

import { useCallback, useEffect, useState } from "react";
import { FolderPhoto, PhotoDetail, photosApi } from "@/lib/api";

function formatTakenAt(takenAt: string | null | undefined): string {
  if (!takenAt) return "Unknown date";
  const d = new Date(takenAt);
  return Number.isNaN(d.getTime()) ? "Unknown date" : d.toLocaleDateString();
}

export function DuplicateReviewModalV2({
  duplicates,
  onClose,
  onResolved,
}: {
  duplicates: FolderPhoto[];
  onClose: () => void;
  onResolved: (removedPhotoId: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [original, setOriginal] = useState<PhotoDetail | null>(null);
  const [duplicate, setDuplicate] = useState<PhotoDetail | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = duplicates[index] ?? null;

  const loadPair = useCallback(async (photo: FolderPhoto) => {
    setPairLoading(true);
    setError(null);
    setOriginal(null);
    setDuplicate(null);
    try {
      const [dup, orig] = await Promise.all([photosApi.get(photo.id), photosApi.get(photo.duplicateOfPhotoId as string)]);
      setDuplicate(dup);
      setOriginal(orig);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load this pair");
    } finally {
      setPairLoading(false);
    }
  }, []);

  useEffect(() => {
    if (current) loadPair(current);
  }, [current, loadPair]);

  function advance() {
    setIndex((i) => i + 1);
  }

  async function keepThisOne(deleteId: string) {
    if (busy || !current) return;
    setBusy(true);
    setError(null);
    try {
      await photosApi.remove(deleteId);
      // Report the pair (by its duplicate-flagged id) as resolved regardless
      // of which side actually got deleted, so the caller's duplicate count
      // stays accurate either way.
      onResolved(current.id);
      advance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete photo");
    } finally {
      setBusy(false);
    }
  }

  const photoUrl = (d: PhotoDetail | null) => d && (d.thumbnails["400"] ?? d.thumbnails["1200"] ?? d.original.url);

  return (
    <div className="ps2-modal-backdrop" onClick={onClose}>
      <div className="ps2-dup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ps2-dup-modal-head">
          <div className="ps2-dup-modal-title">Review duplicates</div>
          {current && (
            <div className="ps2-dup-progress">
              Pair {index + 1} of {duplicates.length}
            </div>
          )}
        </div>

        {error && <p className="ps2-modal-error">{error}</p>}

        {!current ? (
          <p style={{ color: "var(--ps2-muted)", fontSize: 13.5 }}>You&apos;re all caught up - no more duplicates to review.</p>
        ) : (
          <>
            <div className="ps2-dup-grid">
              <div className="ps2-dup-side">
                <div className="ps2-dup-photo">{!pairLoading && photoUrl(original) && <img src={photoUrl(original) as string} alt="" />}</div>
                <div className="ps2-dup-label">
                  Original · {original?.originalFilename ?? "…"} · {formatTakenAt(original?.exif.takenAt)}
                </div>
                <button
                  type="button"
                  className="ps2-dup-keep-btn"
                  disabled={busy || pairLoading || !original || !duplicate}
                  onClick={() => original && duplicate && keepThisOne(duplicate.id)}
                >
                  Keep this one
                </button>
              </div>
              <div className="ps2-dup-side">
                <div className="ps2-dup-photo">{!pairLoading && photoUrl(duplicate) && <img src={photoUrl(duplicate) as string} alt="" className="ps2-dup-photo-dim" />}</div>
                <div className="ps2-dup-label">
                  Duplicate{current.dedupMethod ? ` · ${current.dedupMethod}` : ""} · {formatTakenAt(duplicate?.exif.takenAt)}
                </div>
                <button
                  type="button"
                  className="ps2-dup-keep-btn"
                  disabled={busy || pairLoading || !original || !duplicate}
                  onClick={() => original && duplicate && keepThisOne(original.id)}
                >
                  Keep this one
                </button>
              </div>
            </div>
            <div className="ps2-dup-modal-actions">
              <button type="button" className="ps2-selectbar-btn cancel" onClick={advance} disabled={busy}>
                Keep both
              </button>
              <button type="button" className="ps2-selectbar-btn cancel" onClick={onClose}>
                Finish later
              </button>
            </div>
          </>
        )}

        {!current && (
          <div className="ps2-dup-modal-actions">
            <button type="button" className="ps2-btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
