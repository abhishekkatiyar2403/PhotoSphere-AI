"use client";

// v2 Upload - same real engine as the classic /upload page (queue with a
// concurrency cap, photosApi.uploadWithProgress for real transport progress,
// then poll photosApi.status until done/duplicate/failed), rendered as the
// design's dropzone + per-file rows with a 40px circular progress ring.
//
// True mid-upload cancellation isn't wired: photosApi.uploadWithProgress
// doesn't expose an abort handle for the in-flight XHR. What IS real: the
// design's "Remove" button drops the row (and skips a still-queued file).

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { photosApi } from "@/lib/api";

type PollStatus = "pending" | "processing" | "done" | "duplicate" | "failed";

type UploadItem = {
  key: string;
  file: File;
  queueStatus: "queued" | "uploading" | "polling" | "done" | "duplicate" | "failed" | "error";
  progress: number;
  photoId: string | null;
  pollStatus: PollStatus | null;
  duplicateOfPhotoId: string | null;
  thumbnailUrl: string | null;
  error: string | null;
  previewUrl: string;
};

const UPLOAD_CONCURRENCY = 3;
const POLL_INTERVAL_MS = 2000;
// Design ring: r=15 → circumference 94.2, stroke-dasharray 94.2.
const RING_CIRCUMFERENCE = 94.2;
const TERMINAL: UploadItem["queueStatus"][] = ["done", "duplicate", "failed", "error"];

function makeKey(file: File, index: number) {
  return `${file.name}-${file.size}-${file.lastModified}-${index}-${Date.now()}`;
}

// Browsers can't decode HEIC/HEIF in an <img>, so an object URL for those
// files renders as a blank/broken square. Detect them (by MIME when the OS
// provides one, by extension otherwise — drag-drop often has an empty type)
// and show a labeled placeholder until the backend's JPEG thumbnail arrives.
function isBrowserRenderable(file: File): boolean {
  if (/^image\/hei[cf]/i.test(file.type)) return false;
  return !/\.hei[cf]$/i.test(file.name);
}

// The design shows "{pct}%" while a file is in flight and "Tagged ✓" once
// done; real backend terminal states that the mock doesn't have (duplicate/
// failed) keep a minimal one-word label.
function statusLabel(item: UploadItem): string {
  switch (item.queueStatus) {
    case "queued":
      return "0%";
    case "uploading":
      return `${Math.round(item.progress * 100)}%`;
    case "polling":
      return "Tagging…";
    case "done":
      return "Tagged ✓";
    case "duplicate":
      return "Duplicate";
    case "failed":
      return "Failed";
    case "error":
      return item.error ?? "Failed";
    default:
      return "";
  }
}

function ringFraction(item: UploadItem): number {
  if (item.queueStatus === "queued") return 0;
  if (item.queueStatus === "uploading") return item.progress;
  return 1;
}

export default function UploadV2Page() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const pollRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const removedKeysRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<UploadItem[]>(items);
  itemsRef.current = items;

  useEffect(() => {
    const pollMap = pollRefs.current;
    return () => {
      pollMap.forEach((interval) => clearInterval(interval));
      pollMap.clear();
      itemsRef.current.forEach((it) => URL.revokeObjectURL(it.previewUrl));
    };
  }, []);

  function updateItem(key: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function startPoll(key: string, photoId: string) {
    const interval = setInterval(async () => {
      try {
        const statusRes = await photosApi.status(photoId);
        const pollStatus = statusRes.status as PollStatus;
        updateItem(key, { pollStatus });

        if (["done", "duplicate", "failed"].includes(pollStatus)) {
          clearInterval(interval);
          pollRefs.current.delete(key);

          updateItem(key, {
            queueStatus: pollStatus as "done" | "duplicate" | "failed",
            duplicateOfPhotoId: statusRes.duplicateOfPhotoId ?? null,
          });

          if (pollStatus === "done") {
            try {
              const photo = await photosApi.get(photoId);
              updateItem(key, { thumbnailUrl: photo.thumbnails?.["400"] ?? photo.original?.url ?? null });
            } catch {
              // A thumbnail fetch failing after a successful upload+classify
              // shouldn't flip this item's terminal status to an error.
            }
          }
        }
      } catch (pollErr) {
        clearInterval(interval);
        pollRefs.current.delete(key);
        updateItem(key, {
          queueStatus: "error",
          error: pollErr instanceof Error ? pollErr.message : "Failed",
        });
      }
    }, POLL_INTERVAL_MS);
    pollRefs.current.set(key, interval);
  }

  async function uploadOne(item: UploadItem) {
    updateItem(item.key, { queueStatus: "uploading", progress: 0, error: null });
    try {
      const res = await photosApi.uploadWithProgress(item.file, (fraction) => updateItem(item.key, { progress: fraction }));
      updateItem(item.key, { queueStatus: "polling", photoId: res.photoId, pollStatus: "pending" });
      startPoll(item.key, res.photoId);
    } catch (uploadErr) {
      updateItem(item.key, {
        queueStatus: "error",
        error: uploadErr instanceof Error ? uploadErr.message : "Failed",
      });
    }
  }

  const runQueue = useCallback((queued: UploadItem[]) => {
    let cursor = 0;
    function nextItem(): UploadItem | undefined {
      const next = queued[cursor];
      cursor += 1;
      return next;
    }
    async function worker() {
      let item = nextItem();
      while (item) {
        // Skip anything the user removed from the queue before its turn.
        if (!removedKeysRef.current.has(item.key)) await uploadOne(item);
        item = nextItem();
      }
    }
    const workerCount = Math.min(UPLOAD_CONCURRENCY, queued.length);
    for (let i = 0; i < workerCount; i += 1) void worker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const newItems: UploadItem[] = files.map((file, index) => ({
      key: makeKey(file, index),
      file,
      queueStatus: "queued",
      progress: 0,
      photoId: null,
      pollStatus: null,
      duplicateOfPhotoId: null,
      thumbnailUrl: null,
      error: null,
      previewUrl: URL.createObjectURL(file),
    }));
    setItems((prev) => [...prev, ...newItems]);
    runQueue(newItems);
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = "";
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  }

  function removeItem(key: string) {
    removedKeysRef.current.add(key);
    const interval = pollRefs.current.get(key);
    if (interval) {
      clearInterval(interval);
      pollRefs.current.delete(key);
    }
    setItems((prev) => {
      const removed = prev.find((it) => it.key === key);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((it) => it.key !== key);
    });
  }

  const doneCount = items.filter((it) => TERMINAL.includes(it.queueStatus)).length;
  const uploadHeadline = doneCount === items.length && items.length ? "All photos uploaded" : `Uploading ${items.length} photos`;
  const uploadSub = `${doneCount} of ${items.length} done · AI tagging on arrival`;

  return (
    <main style={{ padding: "38px 32px 60px", maxWidth: 900, width: "100%", margin: "0 auto", position: "relative", zIndex: 1 }}>
      <style>{`
        .upv2-drop:hover, .upv2-drop.active { background: color-mix(in oklab, var(--ps2-accent) 9%, var(--ps2-panel)) !important; }
        .upv2-cancel:hover { color: #e87f8f !important; border-color: #e87f8f !important; }
      `}</style>

      <h1
        style={{
          fontFamily: "var(--ps2-font-serif)",
          fontWeight: 400,
          fontSize: 36,
          margin: "0 0 24px",
          animation: "ps2Up .6s both",
        }}
      >
        Add to your sphere
      </h1>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        multiple
        onChange={handleFileInputChange}
        style={{ display: "none" }}
      />

      <div
        className={`upv2-drop${dragActive ? " active" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        style={{
          position: "relative",
          borderRadius: 24,
          border: "1.5px dashed color-mix(in oklab, var(--ps2-accent) 55%, var(--ps2-border))",
          background: "color-mix(in oklab, var(--ps2-accent) 4%, var(--ps2-panel))",
          padding: "56px 30px",
          textAlign: "center",
          cursor: "pointer",
          animation: "ps2In .6s both .08s",
          transition: "background .3s",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            margin: "0 auto 18px",
            borderRadius: 20,
            background: "color-mix(in oklab, var(--ps2-accent) 16%, transparent)",
            display: "grid",
            placeItems: "center",
            animation: "ps2Float 4.5s ease-in-out infinite",
          }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--ps2-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4m-6 6 6-6 6 6M4 20h16" />
          </svg>
        </div>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>Drop photos here, or click to browse</div>
        <div style={{ fontSize: 13, color: "var(--ps2-muted)" }}>JPEG, PNG, HEIC, RAW — up to 500 MB each. AI tags everything on arrival.</div>
      </div>

      {items.length > 0 && (
        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{uploadHeadline}</div>
            <div style={{ fontSize: 12.5, color: "var(--ps2-muted)" }}>{uploadSub}</div>
          </div>
          {items.map((item) => (
            <div
              key={item.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "12px 14px",
                borderRadius: 14,
                background: "var(--ps2-panel)",
                border: "1px solid var(--ps2-border)",
                animation: "ps2Up .5s both",
              }}
            >
              {item.thumbnailUrl || isBrowserRenderable(item.file) ? (
                <img
                  src={item.thumbnailUrl ?? item.previewUrl}
                  alt=""
                  style={{ width: 46, height: 46, borderRadius: 10, objectFit: "cover" }}
                />
              ) : (
                <div
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: 10,
                    flex: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "color-mix(in oklab, var(--ps2-text) 8%, transparent)",
                    border: "1px solid var(--ps2-border)",
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    color: "var(--ps2-muted)",
                  }}
                >
                  HEIC
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 7 }}>
                  <span style={{ fontWeight: 600 }}>{item.file.name}</span>
                  <span style={{ color: "var(--ps2-muted)" }}>{statusLabel(item)}</span>
                </div>
              </div>
              <svg width="40" height="40" viewBox="0 0 40 40" style={{ flex: "none", transform: "rotate(-90deg)" }}>
                <circle cx="20" cy="20" r="15" fill="none" stroke="color-mix(in oklab, var(--ps2-text) 10%, transparent)" strokeWidth="4" />
                <circle
                  cx="20"
                  cy="20"
                  r="15"
                  fill="none"
                  stroke="var(--ps2-accent)"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray="94.2"
                  strokeDashoffset={(RING_CIRCUMFERENCE * (1 - ringFraction(item))).toFixed(1)}
                  style={{ transition: "stroke-dashoffset .35s ease" }}
                />
              </svg>
              <button
                type="button"
                className="upv2-cancel"
                title="Remove"
                onClick={() => removeItem(item.key)}
                style={{
                  width: 28,
                  height: 28,
                  flex: "none",
                  borderRadius: 8,
                  border: "1px solid var(--ps2-border)",
                  background: "transparent",
                  color: "var(--ps2-muted)",
                  cursor: "pointer",
                  display: "grid",
                  placeItems: "center",
                  transition: "color .2s, border-color .2s",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
              {item.queueStatus === "done" && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7fd8a8" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
